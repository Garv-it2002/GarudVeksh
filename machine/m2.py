"""Standalone hydraulic press telemetry simulator."""

import json
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


class HydraulicPressSimulator:
	MACHINE_ID = "M2_HYDRAULIC_PRESS"
	MANUAL_TAG = "manual_m2_press_v2"
	INTERVAL_SECONDS = 5

	_NOMINAL = {
		"line_pressure_psi": 3000.0,
		"oil_temp_c": 45.0,
		"oil_viscosity_cst": 46.0,
		"ram_cycle_rate_cpm": 12.0,
	}
	_NOISE_STDDEV = {
		"line_pressure_psi": 45.0,
		"oil_temp_c": 1.5,
		"oil_viscosity_cst": 0.5,
		"ram_cycle_rate_cpm": 0.2,
	}
	_DRIFT_STEP = {
		"line_pressure_psi": 7.0,
		"oil_temp_c": 0.08,
		"oil_viscosity_cst": 0.025,
		"ram_cycle_rate_cpm": 0.025,
	}
	_DRIFT_LIMIT = {
		"line_pressure_psi": 40.0,
		"oil_temp_c": 0.6,
		"oil_viscosity_cst": 0.2,
		"ram_cycle_rate_cpm": 0.08,
	}

	def __init__(self, on_telemetry_emit=None):
		self._lock = threading.Lock()
		self._stop_event = threading.Event()
		self._status = "RUNNING"
		self._mode = "PRODUCTION"
		self._targets = dict(self._NOMINAL)
		self._drift = {name: 0.0 for name in self._NOMINAL}
		self._noise_state = {name: 0.0 for name in self._NOMINAL}
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
		"""Apply a control command; return False when its payload is invalid."""
		if not isinstance(command_payload, dict):
			return False
		action = command_payload.get("action")
		if not isinstance(action, str):
			return False
		action = action.strip().upper()

		with self._lock:
			if action == "DEPRESSURIZE_PARK":
				self._targets["line_pressure_psi"] = 15.0
				self._targets["ram_cycle_rate_cpm"] = 0.0
				self._status = "BYPASS_ACTIVE"
				self._mode = "MAINTENANCE"
			elif action == "EMERGENCY_STOP":
				self._targets["line_pressure_psi"] = 0.0
				self._targets["ram_cycle_rate_cpm"] = 0.0
				self._status = "EMERGENCY_STOP"
				self._mode = "MAINTENANCE"
			elif action == "RESET":
				self._targets = dict(self._NOMINAL)
				self._status = "RUNNING"
				self._mode = "PRODUCTION"
				self._drift = {name: 0.0 for name in self._NOMINAL}
				self._noise_state = {name: 0.0 for name in self._NOMINAL}
			elif action == "SEAL_RUPTURE":
				self._targets["line_pressure_psi"] = 900.0
				self._targets["ram_cycle_rate_cpm"] = 0.0
				self._status = "FAULT_PRESSURE_LOSS"
				self._mode = "MAINTENANCE"
			else:
				return False
		return True

	def inject_seal_rupture(self):
		return self.receive_control_command({"action": "SEAL_RUPTURE"})

	def create_telemetry_payload(self):
		with self._lock:
			targets = dict(self._targets)
			status = self._status
			mode = self._mode
			metrics = {}
			for name, target in targets.items():
				self._drift[name] += random.gauss(0.0, self._DRIFT_STEP[name])
				limit = self._DRIFT_LIMIT[name]
				self._drift[name] = max(-limit, min(limit, self._drift[name]))

				# Correlated Gaussian noise avoids unrealistic jumps between samples.
				correlation = 0.65
				innovation_scale = (1.0 - correlation ** 2) ** 0.5
				self._noise_state[name] = (
					correlation * self._noise_state[name]
					+ innovation_scale * random.gauss(0.0, self._NOISE_STDDEV[name])
				)
				value = target + self._drift[name] + self._noise_state[name]

				# Fault and safety states override pressure and stop the ram.
				if status == "FAULT_PRESSURE_LOSS":
					if name == "line_pressure_psi":
						value = min(value, 900.0)
					elif name == "ram_cycle_rate_cpm":
						value = 0.0
				elif status in ("BYPASS_ACTIVE", "EMERGENCY_STOP"):
					if name == "line_pressure_psi":
						value = targets[name]
					elif name == "ram_cycle_rate_cpm":
						value = 0.0
				value = max(0.0, value)
				metrics[name] = round(float(value), 3)

		flags = {
			"pressure_warning": metrics["line_pressure_psi"] < 2500.0,
			"leak_detected": status == "FAULT_PRESSURE_LOSS",
		}
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
		"p": ("control", "DEPRESSURIZE_PARK"),
		"park": ("control", "DEPRESSURIZE_PARK"),
		"s": ("control", "EMERGENCY_STOP"),
		"stop": ("control", "EMERGENCY_STOP"),
		"r": ("control", "RESET"),
		"reset": ("control", "RESET"),
		"q": ("quit", None),
		"quit": ("quit", None),
	}
	print("Commands: f/fault, p/park, s/stop, r/reset, q/quit", flush=True)
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
			machine.inject_seal_rupture()
		elif kind == "control":
			machine.receive_control_command({"action": action})
		else:
			machine.stop()
			return


def main():
	machine = HydraulicPressSimulator()
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
