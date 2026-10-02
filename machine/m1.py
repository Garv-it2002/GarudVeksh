"""Standalone 5-axis CNC milling-center telemetry simulator."""

import json
import math
import random
import socket
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
	sys.path.insert(0, str(PROJECT_ROOT))

from agent1.control_server import ControlCommandServer

udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
WATCHER_ADDRESS = ("127.0.0.1", 5005)


class CNCMachineSimulator:
	MACHINE_ID = "M1_CNC_MILL"
	MANUAL_TAG = "manual_m1_cnc_v3"
	INTERVAL_SECONDS = 5

	_NOMINAL = {
		"spindle_rpm": 10000.0,
		"bearing_temp_c": 68.0,
		"vibration_rms": 0.35,
		"coolant_flow_lpm": 18.5,
		"spindle_load_pct": 62.0,
	}
	_NOISE = {
		"spindle_rpm": 45.0,
		"bearing_temp_c": 0.45,
		"vibration_rms": 0.015,
		"coolant_flow_lpm": 0.25,
		"spindle_load_pct": 0.9,
	}
	_DRIFT_STEP = {
		"spindle_rpm": 8.0,
		"bearing_temp_c": 0.08,
		"vibration_rms": 0.003,
		"coolant_flow_lpm": 0.04,
		"spindle_load_pct": 0.15,
	}
	_DRIFT_LIMIT = {
		"spindle_rpm": 100.0,
		"bearing_temp_c": 0.8,
		"vibration_rms": 0.025,
		"coolant_flow_lpm": 0.4,
		"spindle_load_pct": 1.8,
	}

	def __init__(self, on_telemetry_emit=None):
		self._lock = threading.Lock()
		self._stop_event = threading.Event()
		self._status = "RUNNING"
		self._mode = "PRODUCTION"
		self._targets = dict(self._NOMINAL)
		self._drift = {name: 0.0 for name in self._NOMINAL}
		self._noise_state = {name: 0.0 for name in self._NOMINAL}
		self._fault_started_at = None
		self.on_telemetry_emit = on_telemetry_emit or self._print_telemetry

	@staticmethod
	def _print_telemetry(payload):
		# Attach Google Cloud Pub/Sub here with publisher.publish(...).
		payload_str = json.dumps(payload, separators=(",", ":"), allow_nan=False)
		print(payload_str, flush=True)
		try:
			udp_socket.sendto(payload_str.encode("utf-8"), WATCHER_ADDRESS)
		except Exception:
			pass

	def receive_control_command(self, command_payload: dict):
		"""Apply a control-plane command; return False for invalid commands."""
		if not isinstance(command_payload, dict):
			return False

		action = command_payload.get("action")
		if not isinstance(action, str):
			return False
		action = action.strip().upper()

		with self._lock:
			if action == "THROTTLE_DOWN":
				self._targets.update({
					"spindle_rpm": 2000.0,
					"spindle_load_pct": 25.0,
					"coolant_flow_lpm": 20.5,
				})
				self._status = "THROTTLED"
				self._mode = "DEGRADED_SAFE"
				self._fault_started_at = None
			elif action == "EMERGENCY_STOP":
				self._targets.update({
					"spindle_rpm": 0.0,
					"spindle_load_pct": 0.0,
				})
				self._status = "EMERGENCY_STOP"
				self._mode = "MAINTENANCE"
				self._fault_started_at = None
			elif action == "RESET":
				self._targets = dict(self._NOMINAL)
				self._status = "RUNNING"
				self._mode = "PRODUCTION"
				self._fault_started_at = None
				self._drift = {name: 0.0 for name in self._NOMINAL}
				self._noise_state = {name: 0.0 for name in self._NOMINAL}
			else:
				return False
		return True

	def inject_bearing_thermal_runaway(self):
		with self._lock:
			self._status = "OVERHEATING"
			self._mode = "DEGRADED_SAFE"
			self._fault_started_at = time.monotonic()
		return True

	def _sample_metrics(self, now):
		with self._lock:
			targets = dict(self._targets)
			status = self._status
			mode = self._mode
			fault_started_at = self._fault_started_at

		if fault_started_at is not None:
			elapsed = max(0.0, now - fault_started_at)
			ramp = min(elapsed / 8.0, 1.0)
			targets.update({
				"bearing_temp_c": 70.0 + 45.0 * (1.0 - math.exp(-elapsed / 4.5)),
				"vibration_rms": 0.35 + 4.0 * ramp,
				"coolant_flow_lpm": 18.5 - 14.5 * min(elapsed / 10.0, 1.0),
			})

		metrics = {}
		with self._lock:
			for name, target in targets.items():
				self._drift[name] += random.gauss(0.0, self._DRIFT_STEP[name])
				limit = self._DRIFT_LIMIT[name]
				self._drift[name] = max(-limit, min(limit, self._drift[name]))
				correlation = 0.65
				innovation = math.sqrt(1.0 - correlation ** 2)
				self._noise_state[name] = (
					correlation * self._noise_state[name]
					+ innovation * random.gauss(0.0, self._NOISE[name])
				)
				noise = self._noise_state[name]
				value = target + self._drift[name] + noise
				if name == "spindle_rpm":
					value = max(0.0, value)
				elif name == "vibration_rms":
					value = max(0.0, value)
				elif name == "coolant_flow_lpm":
					value = max(0.0, value)
				elif name == "spindle_load_pct":
					value = max(0.0, min(100.0, value))
				metrics[name] = round(float(value), 3)

		flags = {
			"thermal_warning": metrics["bearing_temp_c"] >= 85.0,
			"vibration_warning": metrics["vibration_rms"] >= 1.5,
			"coolant_low": metrics["coolant_flow_lpm"] < 8.0,
		}
		return status, mode, metrics, flags

	def create_telemetry_payload(self):
		status, mode, metrics, flags = self._sample_metrics(time.monotonic())
		return {
			"machine_id": self.MACHINE_ID,
			"manual_tag": self.MANUAL_TAG,
			"timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
			"status": status,
			"mode": mode,
			"metrics": metrics,
			"flags": flags,
		}

	def run(self):
		next_emit = time.monotonic()
		while not self._stop_event.is_set():
			payload = self.create_telemetry_payload()
			try:
				self.on_telemetry_emit(payload)
			except Exception as exc:
				print("Telemetry callback failed: {}".format(exc), file=sys.stderr, flush=True)

			next_emit += self.INTERVAL_SECONDS
			self._stop_event.wait(max(0.0, next_emit - time.monotonic()))

	def stop(self):
		self._stop_event.set()


def _command_listener(machine):
	commands = {
		"f": ("fault", None),
		"fault": ("fault", None),
		"t": ("control", "THROTTLE_DOWN"),
		"throttle": ("control", "THROTTLE_DOWN"),
		"s": ("control", "EMERGENCY_STOP"),
		"stop": ("control", "EMERGENCY_STOP"),
		"r": ("control", "RESET"),
		"reset": ("control", "RESET"),
		"q": ("quit", None),
		"quit": ("quit", None),
	}
	print("Commands: f/fault, t/throttle, s/stop, r/reset, q/quit", flush=True)
	while not machine._stop_event.is_set():
		try:
			command = input().strip().lower()
		except EOFError:
			machine.stop()
			return

		parsed = commands.get(command)
		if parsed is None:
			if command:
				print("Unknown command: {}".format(command), file=sys.stderr, flush=True)
			continue
		kind, action = parsed
		if kind == "fault":
			machine.inject_bearing_thermal_runaway()
		elif kind == "control":
			machine.receive_control_command({"action": action})
		else:
			machine.stop()
			return


def main():
	machine = CNCMachineSimulator()
	control_server = ControlCommandServer(machine).start()
	listener = threading.Thread(target=_command_listener, args=(machine,), daemon=True)
	listener.start()
	try:
		machine.run()
	except KeyboardInterrupt:
		machine.stop()
	finally:
		control_server.close()


if __name__ == "__main__":
	main()
