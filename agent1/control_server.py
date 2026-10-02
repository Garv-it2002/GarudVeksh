"""Local command receiver shared by the machine simulators."""

import json
import socket
import threading


CONTROL_HOST = "127.0.0.1"
CONTROL_PORTS = {
    "M1_CNC_MILL": 5011,
    "M2_HYDRAULIC_PRESS": 5012,
    "M3_VFD_CONVEYOR": 5013,
}


class ControlCommandServer:
    def __init__(self, machine, port=None, host=CONTROL_HOST):
        self.machine = machine
        self.host = host
        requested_port = port if port is not None else CONTROL_PORTS[machine.MACHINE_ID]
        self._stop_event = threading.Event()
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._socket.settimeout(0.25)
        self._socket.bind((host, requested_port))
        self.port = self._socket.getsockname()[1]
        self._thread = threading.Thread(target=self._serve, daemon=True)

    def start(self):
        self._thread.start()
        print(
            "Control listener for {} on {}:{}".format(
                self.machine.MACHINE_ID, self.host, self.port
            ),
            flush=True,
        )
        return self

    def _serve(self):
        while not self._stop_event.is_set():
            try:
                datagram, sender = self._socket.recvfrom(8192)
            except socket.timeout:
                continue
            except OSError:
                return

            request_id = None
            action = None
            accepted = False
            try:
                command = json.loads(datagram.decode("utf-8"))
                request_id = command.get("request_id")
                action = command.get("action")
                if command.get("machine_id") == self.machine.MACHINE_ID:
                    accepted = self.machine.receive_control_command(command)
            except (UnicodeDecodeError, json.JSONDecodeError, AttributeError, TypeError):
                pass

            response = {
                "request_id": request_id,
                "machine_id": self.machine.MACHINE_ID,
                "action": action,
                "accepted": accepted,
            }
            try:
                self._socket.sendto(
                    json.dumps(response, separators=(",", ":")).encode("utf-8"),
                    sender,
                )
            except OSError:
                if not self._stop_event.is_set():
                    raise

    def close(self):
        self._stop_event.set()
        self._socket.close()
        if self._thread.is_alive():
            self._thread.join(timeout=1.0)
