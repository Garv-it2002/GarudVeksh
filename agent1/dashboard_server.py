"""Bridge simulator UDP telemetry and machine controls to the browser UI."""

import asyncio
import json
import socket
import subprocess
import sys
import threading
import uuid
from pathlib import Path

import websockets
from websockets.exceptions import ConnectionClosed

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent1.control_server import CONTROL_HOST, CONTROL_PORTS
from agent1.watcher import EdgeGateway

WEBSOCKET_HOST = "127.0.0.1"
WEBSOCKET_PORT = 8000
WEBSOCKET_PATH = "/ws/telemetry"
MACHINE_SCRIPTS = {
    "M1_CNC_MILL": PROJECT_ROOT / "machine" / "m1.py",
    "M2_HYDRAULIC_PRESS": PROJECT_ROOT / "machine" / "m2.py",
    "M3_VFD_CONVEYOR": PROJECT_ROOT / "machine" / "m3.py",
}
AI_AGENT_SCRIPT = PROJECT_ROOT / "agent2" / "ai_agent.py"
MACHINE_ACTIONS = {
    "M1_CNC_MILL": {"THROTTLE_DOWN", "EMERGENCY_STOP", "RESET", "INJECT_BEARING_OVERHEAT"},
    "M2_HYDRAULIC_PRESS": {"DEPRESSURIZE_PARK", "EMERGENCY_STOP", "RESET", "INJECT_SEAL_RUPTURE"},
    "M3_VFD_CONVEYOR": {"REVERSE_CLEAR", "EMERGENCY_STOP", "RESET", "INJECT_BELT_JAM"},
}


class DashboardBridge:
    def __init__(self):
        self._loop = None
        self._clients = set()
        self._processes = {}
        self._ai_process = None
        self._gateway = None
        self._udp_thread = None
        self._latest_telemetry = {}
        self._registry_path = PROJECT_ROOT / "machine_registry.json"
        self._registry_mtime = None
        self._registry = self._load_registry()

    def _load_registry(self):
        try:
            stat = self._registry_path.stat()
            registry = json.loads(self._registry_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            self._registry_mtime = None
            return {}
        except (OSError, json.JSONDecodeError):
            self._registry_mtime = None
            return {}
        self._registry_mtime = stat.st_mtime_ns
        return registry if isinstance(registry, dict) else {}

    def _save_registry(self):
        temporary_path = self._registry_path.with_suffix(".json.tmp")
        temporary_path.write_text(
            json.dumps(self._registry, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        temporary_path.replace(self._registry_path)
        self._registry_mtime = self._registry_path.stat().st_mtime_ns

    async def _watch_registry_file(self):
        while True:
            await asyncio.sleep(1)
            try:
                current_mtime = self._registry_path.stat().st_mtime_ns
            except OSError:
                current_mtime = None
            if current_mtime != self._registry_mtime:
                self._registry = self._load_registry()
                await self._broadcast({"type": "registry_snapshot", "machines": self._registry})

    async def serve_forever(self):
        self._loop = asyncio.get_running_loop()
        registry_watch = asyncio.create_task(self._watch_registry_file())
        try:
            async with websockets.serve(
                self._handle_client,
                WEBSOCKET_HOST,
                WEBSOCKET_PORT,
                ping_interval=20,
                ping_timeout=20,
                max_size=1_048_576,
            ):
                print(
                    "Dashboard bridge serving ws://{}:{}{}. Watcher, AI agent, and machines are stopped.".format(
                        WEBSOCKET_HOST, WEBSOCKET_PORT, WEBSOCKET_PATH
                    ),
                    flush=True,
                )
                await asyncio.Future()
        finally:
            registry_watch.cancel()
            await asyncio.gather(registry_watch, return_exceptions=True)
            await self._stop_all_machines()
            await self._stop_ai_agent()
            await self._stop_watcher()

    def _queue_telemetry(self, payload):
        self._latest_telemetry[payload.get("machine_id")] = payload
        if self._loop and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self._schedule_broadcast, {
                "type": "telemetry",
                "payload": payload,
            })

    def _schedule_broadcast(self, message):
        asyncio.create_task(self._broadcast(message))

    async def _broadcast(self, message):
        if not self._clients:
            return
        encoded = json.dumps(message, separators=(",", ":"), allow_nan=False)
        results = await asyncio.gather(
            *(client.send(encoded) for client in tuple(self._clients)),
            return_exceptions=True,
        )
        for client, result in zip(tuple(self._clients), results):
            if isinstance(result, Exception):
                self._clients.discard(client)

    async def _send(self, websocket, message):
        await websocket.send(json.dumps(message, separators=(",", ":"), allow_nan=False))

    async def _handle_client(self, websocket):
        request_path = getattr(getattr(websocket, "request", None), "path", WEBSOCKET_PATH)
        if request_path.split("?", 1)[0] != WEBSOCKET_PATH:
            await websocket.close(code=1008, reason="Unknown endpoint")
            return
        self._clients.add(websocket)
        try:
            await self._send(websocket, {"type": "registry_snapshot", "machines": self._registry})
            await self._send_service_state(websocket, "watcher", "running" if self._gateway else "stopped")
            await self._send_service_state(websocket, "ai_agent", "running" if self._ai_process and self._ai_process.returncode is None else "stopped")
            for machine_id in MACHINE_SCRIPTS:
                process = self._processes.get(machine_id)
                state = "running" if process and process.returncode is None else "stopped"
                await self._send_machine_state(websocket, machine_id, state)
                payload = self._latest_telemetry.get(machine_id)
                if payload is not None:
                    await self._send(websocket, {"type": "telemetry", "payload": payload})
            async for raw_message in websocket:
                try:
                    message = json.loads(raw_message)
                    if not isinstance(message, dict):
                        raise ValueError("Expected a JSON object")
                except (json.JSONDecodeError, ValueError):
                    await self._send(websocket, {"type": "error", "message": "Invalid JSON command"})
                    continue
                await self._handle_message(websocket, message)
        except ConnectionClosed:
            pass
        finally:
            self._clients.discard(websocket)

    async def _handle_message(self, websocket, message):
        message_type = message.get("type")
        if message_type == "register_machine":
            await self._register_machine(websocket, message)
        elif message_type == "delete_machine":
            await self._delete_machine(websocket, message.get("machine_id"))
        elif message_type == "start_service" and message.get("service") == "watcher":
            await self._start_watcher(websocket)
        elif message_type == "stop_service" and message.get("service") == "watcher":
            await self._stop_watcher(websocket)
        elif message_type == "start_service" and message.get("service") == "ai_agent":
            await self._start_ai_agent(websocket)
        elif message_type == "stop_service" and message.get("service") == "ai_agent":
            await self._stop_ai_agent(websocket)
        elif message_type == "start_machine":
            await self._start_machine(websocket, message.get("machine_id"))
        elif message_type == "stop_machine":
            await self._stop_machine(websocket, message.get("machine_id"))
        elif message_type == "control":
            if message.get("action") == "RESET_ALL":
                await self._reset_all(websocket, message.get("request_id"))
            else:
                await self._control_machine(websocket, message)
        else:
            await self._send(websocket, {"type": "error", "message": "Unsupported command type"})

    async def _register_machine(self, websocket, message):
        machine_id = message.get("machine_id")
        manual = message.get("manual")
        fields = message.get("fields")
        if not isinstance(machine_id, str) or not machine_id.strip():
            await self._send(websocket, {"type": "registration_result", "accepted": False, "message": "Machine ID is required"})
            return
        if not isinstance(manual, str) or not manual.strip():
            await self._send(websocket, {"type": "registration_result", "accepted": False, "message": "Manual ID is required"})
            return
        if not isinstance(fields, dict) or not fields:
            await self._send(websocket, {"type": "registration_result", "accepted": False, "message": "Add at least one telemetry field and unit"})
            return
        normalized_fields = {
            str(name).strip(): str(unit).strip()
            for name, unit in fields.items()
            if isinstance(name, str) and name.strip() and isinstance(unit, str) and unit.strip()
        }
        if len(normalized_fields) != len(fields):
            await self._send(websocket, {"type": "registration_result", "accepted": False, "message": "Each field needs a name and unit"})
            return

        entry = {
            "manual": manual.strip(),
            "fields": normalized_fields,
        }
        machine_type = message.get("machine_type")
        if isinstance(machine_type, str) and machine_type.strip():
            entry["type"] = machine_type.strip()
        self._registry[machine_id.strip()] = entry
        try:
            self._save_registry()
        except OSError as exc:
            await self._send(websocket, {"type": "registration_result", "accepted": False, "message": "Could not save registry: {}".format(exc)})
            return
        await self._broadcast({"type": "registry_snapshot", "machines": self._registry})
        await self._send(websocket, {
            "type": "registration_result",
            "accepted": True,
            "machine_id": machine_id.strip(),
            "message": "Machine registration saved",
        })

    async def _delete_machine(self, websocket, machine_id):
        if not isinstance(machine_id, str) or machine_id not in self._registry:
            await self._send(websocket, {"type": "registration_result", "accepted": False, "action": "delete", "message": "Machine is not registered"})
            return
        process = self._processes.get(machine_id)
        if process and process.returncode is None:
            await self._send(websocket, {"type": "registration_result", "accepted": False, "action": "delete", "message": "Stop the machine before deleting its registration"})
            return
        deleted_entry = self._registry.pop(machine_id)
        try:
            self._save_registry()
        except OSError as exc:
            self._registry[machine_id] = deleted_entry
            await self._send(websocket, {"type": "registration_result", "accepted": False, "action": "delete", "message": "Could not save registry: {}".format(exc)})
            return
        await self._broadcast({"type": "registry_snapshot", "machines": self._registry})
        await self._send(websocket, {
            "type": "registration_result",
            "accepted": True,
            "action": "delete",
            "machine_id": machine_id,
            "message": "Machine registration deleted",
        })

    async def _start_watcher(self, websocket):
        if self._gateway is not None:
            await self._send_service_state(websocket, "watcher", "running", "Watcher already running")
            return
        try:
            gateway = EdgeGateway(on_telemetry=self._queue_telemetry)
            thread = threading.Thread(target=gateway.serve_forever, daemon=True)
            thread.start()
        except OSError as exc:
            await self._send_service_state(websocket, "watcher", "error", str(exc))
            return
        self._gateway = gateway
        self._udp_thread = thread
        await self._send_service_state(websocket, "watcher", "running", "Watcher started on UDP 5005")

    async def _stop_watcher(self, websocket=None):
        await self._stop_all_machines()
        await self._stop_ai_agent()
        gateway = self._gateway
        thread = self._udp_thread
        self._gateway = None
        self._udp_thread = None
        if gateway is not None:
            gateway.close()
        if thread is not None:
            await asyncio.to_thread(thread.join, 1.0)
        if websocket is not None:
            await self._send_service_state(websocket, "watcher", "stopped", "Watcher stopped; machines stopped too")
        else:
            await self._broadcast({"type": "service_state", "service": "watcher", "state": "stopped", "message": "Watcher stopped"})

    async def _start_ai_agent(self, websocket):
        if self._ai_process and self._ai_process.returncode is None:
            await self._send_service_state(websocket, "ai_agent", "running", "AI agent already running")
            return
        if self._gateway is None:
            await self._send_service_state(websocket, "ai_agent", "error", "Start the watcher before the AI agent")
            return
        try:
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                str(AI_AGENT_SCRIPT),
                cwd=str(PROJECT_ROOT),
                stdin=asyncio.subprocess.DEVNULL,
            )
        except OSError as exc:
            await self._send_service_state(websocket, "ai_agent", "error", str(exc))
            return
        self._ai_process = process
        asyncio.create_task(self._watch_ai_agent(process))
        await asyncio.sleep(0.2)
        if process.returncode is not None:
            self._ai_process = None
            await self._send_service_state(websocket, "ai_agent", "error", "AI agent exited during startup; check its API key and logs")
            return
        await self._send_service_state(websocket, "ai_agent", "running", "AI agent started")

    async def _watch_ai_agent(self, process):
        return_code = await process.wait()
        if self._ai_process is process:
            self._ai_process = None
            await self._broadcast({
                "type": "service_state",
                "service": "ai_agent",
                "state": "stopped" if return_code == 0 else "error",
                "message": "AI agent exited ({})".format(return_code),
            })

    async def _stop_ai_agent(self, websocket=None):
        process = self._ai_process
        self._ai_process = None
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        if websocket is not None:
            await self._send_service_state(websocket, "ai_agent", "stopped", "AI agent stopped")
        else:
            await self._broadcast({"type": "service_state", "service": "ai_agent", "state": "stopped", "message": "AI agent stopped"})

    async def _send_service_state(self, websocket, service, state, message=""):
        await self._send(websocket, {
            "type": "service_state",
            "service": service,
            "state": state,
            "message": message,
        })

    async def _send_machine_state(self, websocket, machine_id, state, message=""):
        await self._send(websocket, {
            "type": "machine_state",
            "machine_id": machine_id,
            "state": state,
            "message": message,
        })

    async def _start_machine(self, websocket, machine_id):
        if self._gateway is None:
            await self._machine_state(websocket, machine_id, "error", "Start the watcher before a machine")
            return
        if machine_id not in self._registry:
            await self._machine_state(websocket, machine_id, "error", "Register this machine before starting it")
            return
        script = MACHINE_SCRIPTS.get(machine_id)
        if script is None:
            await self._machine_state(websocket, machine_id, "error", "Unknown machine")
            return
        current = self._processes.get(machine_id)
        if current and current.returncode is None:
            await self._machine_state(websocket, machine_id, "running", "Machine already running")
            return
        try:
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                str(script),
                cwd=str(PROJECT_ROOT),
                stdin=asyncio.subprocess.PIPE,
            )
        except OSError as exc:
            await self._machine_state(websocket, machine_id, "error", str(exc))
            return
        self._processes[machine_id] = process
        asyncio.create_task(self._watch_process(machine_id, process))
        await asyncio.sleep(0.15)
        if process.returncode is not None:
            self._processes.pop(machine_id, None)
            await self._machine_state(
                websocket,
                machine_id,
                "error",
                "Machine exited during startup; check its control-port availability.",
            )
            return
        await self._machine_state(websocket, machine_id, "running", "Machine process started")

    async def _watch_process(self, machine_id, process):
        return_code = await process.wait()
        if self._processes.get(machine_id) is process:
            self._processes.pop(machine_id, None)
            await self._broadcast({
                "type": "machine_state",
                "machine_id": machine_id,
                "state": "stopped",
                "message": "Machine process exited ({})".format(return_code),
            })

    async def _stop_machine(self, websocket, machine_id):
        process = self._processes.get(machine_id)
        if not process or process.returncode is not None:
            self._processes.pop(machine_id, None)
            await self._machine_state(websocket, machine_id, "stopped", "Machine is not running")
            return
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=3.0)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
        self._processes.pop(machine_id, None)
        await self._machine_state(websocket, machine_id, "stopped", "Machine process stopped")

    async def _stop_all_machines(self):
        for machine_id in tuple(self._processes):
            process = self._processes.pop(machine_id)
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=3.0)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
            await self._broadcast({
                "type": "machine_state",
                "machine_id": machine_id,
                "state": "stopped",
                "message": "Machine stopped with watcher",
            })

    async def _machine_state(self, websocket, machine_id, state, message):
        payload = {
            "type": "machine_state",
            "machine_id": machine_id,
            "state": state,
            "message": message,
        }
        await self._broadcast(payload)

    @staticmethod
    def _send_machine_control(machine_id, action, target_value=None):
        request_id = str(uuid.uuid4())
        command = {
            "request_id": request_id,
            "machine_id": machine_id,
            "action": action,
            "target_value": target_value,
        }
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
            client.settimeout(2.0)
            client.sendto(
                json.dumps(command, separators=(",", ":")).encode("utf-8"),
                (CONTROL_HOST, CONTROL_PORTS[machine_id]),
            )
            response_data, _address = client.recvfrom(2048)
        response = json.loads(response_data.decode("utf-8"))
        return response.get("request_id") == request_id and response.get("accepted") is True

    async def _control_machine(self, websocket, message):
        machine_id = message.get("machine_id")
        action = message.get("action")
        accepted = False
        if machine_id in MACHINE_ACTIONS and action in MACHINE_ACTIONS[machine_id]:
            try:
                accepted = await asyncio.to_thread(
                    self._send_machine_control,
                    machine_id,
                    action,
                    message.get("target_value"),
                )
            except (OSError, ValueError, json.JSONDecodeError):
                accepted = False
        await self._send(websocket, {
            "type": "command_result",
            "request_id": message.get("request_id"),
            "machine_id": machine_id,
            "action": action,
            "accepted": accepted,
            "message": "Command accepted by machine" if accepted else "Machine is offline or rejected the command",
        })

    async def _reset_all(self, websocket, request_id):
        active = [
            machine_id for machine_id, process in self._processes.items()
            if process.returncode is None
        ]
        results = await asyncio.gather(*(
            asyncio.to_thread(self._send_machine_control, machine_id, "RESET")
            for machine_id in active
        ), return_exceptions=True)
        accepted = bool(active) and all(result is True for result in results)
        await self._send(websocket, {
            "type": "command_result",
            "request_id": request_id,
            "machine_id": "*",
            "action": "RESET_ALL",
            "accepted": accepted,
            "message": "Reset sent to {} running machine(s)".format(len(active)) if accepted else "No running machines or a reset was rejected",
        })


async def main():
    await DashboardBridge().serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Dashboard bridge stopped.", flush=True)
