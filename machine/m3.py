"""Standalone VFD conveyor simulator with local edge-gateway output."""

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


class ConveyorSimulator:
	MACHINE_ID = "M3_VFD_CONVEYOR"
	MANUAL_TAG = "manual_m3_conveyor_v1"
	INTERVAL_SECONDS = 5

	_NOMINAL = {
		"motor_current_amps": 12.5,
		"vfd_frequency_hz": 50.0,
		"belt_tension_n": 450.0,
		"belt_speed_mps": 1.5,
	}
	_NOISE_STDDEV = {
		"motor_current_amps": 0.8,
		"vfd_frequency_hz": 0.2,
		"belt_tension_n": 12.0,
		"belt_speed_mps": 0.05,
	}
	_DRIFT_STEP = {
		"motor_current_amps": 0.08,
		"vfd_frequency_hz": 0.02,
		"belt_tension_n": 1.5,
		"belt_speed_mps": 0.005,
	}
	_DRIFT_LIMIT = {
		"motor_current_amps": 0.4,
		"vfd_frequency_hz": 0.08,
		"belt_tension_n": 6.0,
		"belt_speed_mps": 0.025,
	}

	def __init__(self, on_telemetry_emit=None):
		self._lock = threading.Lock()
		self._stop_event = threading.Event()
		self._status = "RUNNING"
		self._mode = "PRODUCTION"
		self._targets = dict(self._NOMINAL)
		self._drift = {name: 0.0 for name in self._NOMINAL}
		self._noise_state = {name: 0.0 for name in self._NOMINAL}
		self.on_telemetry_emit = on_telemetry_emit or self._emit_telemetry

	@staticmethod
	def _emit_telemetry(payload):
		payload_str = json.dumps(payload, separators=(",", ":"), allow_nan=False)
		print(payload_str, flush=True)
		try:
			udp_socket.sendto(payload_str.encode("utf-8"), WATCHER_ADDRESS)
		except Exception:
			pass

	def receive_control_command(self, command_payload: dict):
		if not isinstance(command_payload, dict):
			return False
		action = command_payload.get("action")
		if not isinstance(action, str):
			return False
		action = action.strip().upper()

		with self._lock:
			if action == "REVERSE_CLEAR":
				self._targets.update({
					"motor_current_amps": 15.0,
					"vfd_frequency_hz": -15.0,
					"belt_speed_mps": -0.4,
				})
				self._status = "REVERSING"
				self._mode = "CLEARING"
			elif action == "EMERGENCY_STOP":
				self._targets.update({
					"motor_current_amps": 0.0,
					"vfd_frequency_hz": 0.0,
					"belt_speed_mps": 0.0,
				})
				self._status = "EMERGENCY_STOP"
				self._mode = "MAINTENANCE"
			elif action == "RESET":
				self._targets = dict(self._NOMINAL)
				self._status = "RUNNING"
				self._mode = "PRODUCTION"
				self._drift = {name: 0.0 for name in self._NOMINAL}
				self._noise_state = {name: 0.0 for name in self._NOMINAL}
			else:
				return False
		return True

	def inject_mechanical_jam(self):
		with self._lock:
			self._targets.update({
				"motor_current_amps": 50.0,
				"belt_speed_mps": 0.0,
				"belt_tension_n": 850.0,
			})
			self._status = "JAMMED"
			self._mode = "CLEARING"
		return True

	def create_telemetry_payload(self):
		with self._lock:
			status = self._status
			mode = self._mode
			metrics = {}
			for name, target in self._targets.items():
				self._drift[name] += random.gauss(0.0, self._DRIFT_STEP[name])
				limit = self._DRIFT_LIMIT[name]
				self._drift[name] = max(-limit, min(limit, self._drift[name]))
				correlation = 0.65
				innovation_scale = (1.0 - correlation ** 2) ** 0.5
				self._noise_state[name] = (
					correlation * self._noise_state[name]
					+ innovation_scale * random.gauss(0.0, self._NOISE_STDDEV[name])
				)
				value = target + self._drift[name] + self._noise_state[name]

				if status == "JAMMED":
					if name == "motor_current_amps":
						value = max(45.1, value)
					elif name == "belt_speed_mps":
						value = 0.0
					elif name == "belt_tension_n":
						value = max(800.1, value)
				elif name == "vfd_frequency_hz":
						value = self._targets[name]
				elif status == "REVERSING":
					if name in ("vfd_frequency_hz", "belt_speed_mps"):
						value = self._targets[name]
				elif status == "EMERGENCY_STOP":
					if name in ("motor_current_amps", "vfd_frequency_hz", "belt_speed_mps"):
						value = 0.0
				metrics[name] = round(float(value), 3)

		flags = {
			"overcurrent_warning": metrics["motor_current_amps"] > 45.0,
			"motion_loss": abs(metrics["belt_speed_mps"]) < 0.05,
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
		"f": ("fault", None), "fault": ("fault", None),
		"c": ("control", "REVERSE_CLEAR"), "clear": ("control", "REVERSE_CLEAR"),
		"s": ("control", "EMERGENCY_STOP"), "stop": ("control", "EMERGENCY_STOP"),
		"r": ("control", "RESET"), "reset": ("control", "RESET"),
		"q": ("quit", None), "quit": ("quit", None),
	}
	print("Commands: f/fault, c/clear, s/stop, r/reset, q/quit", flush=True)
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
			machine.inject_mechanical_jam()
		elif kind == "control":
			machine.receive_control_command({"action": action})
		else:
			machine.stop()
			return


def main():
	machine = ConveyorSimulator()
	threading.Thread(target=_command_listener, args=(machine,), daemon=True).start()
	try:
		machine.run()
	except KeyboardInterrupt:
		machine.stop()


"""Standalone VFD infeed-conveyor telemetry simulator."""

import json
import random
import sys
import threading
import time
from datetime import datetime, timezone


class ConveyorSimulator:
	MACHINE_ID = "M3_VFD_CONVEYOR"
	MANUAL_TAG = "manual_m3_conveyor_v1"
	INTERVAL_SECONDS = 10

	_NOMINAL = {
		"motor_current_amps": 12.5,
		"vfd_frequency_hz": 50.0,
		"belt_tension_n": 450.0,
		"belt_speed_mps": 1.5,
	}
	_NOISE_STDDEV = {
		"motor_current_amps": 0.8,
		"vfd_frequency_hz": 0.2,
		"belt_tension_n": 12.0,
		"belt_speed_mps": 0.05,
	}
	_DRIFT_STEP = {
		"motor_current_amps": 0.08,
		"vfd_frequency_hz": 0.02,
		"belt_tension_n": 1.5,
		"belt_speed_mps": 0.005,
	}
	_DRIFT_LIMIT = {
		"motor_current_amps": 0.4,
		"vfd_frequency_hz": 0.08,
		"belt_tension_n": 6.0,
		"belt_speed_mps": 0.025,
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
			if action == "REVERSE_CLEAR":
				self._targets.update({
					"motor_current_amps": 15.0,
					"vfd_frequency_hz": -15.0,
					"belt_speed_mps": -0.4,
				})
				self._status = "REVERSING"
				self._mode = "CLEARING"
			elif action == "EMERGENCY_STOP":
				self._targets.update({
					"motor_current_amps": 0.0,
					"vfd_frequency_hz": 0.0,
					"belt_speed_mps": 0.0,
				})
				self._status = "EMERGENCY_STOP"
				self._mode = "MAINTENANCE"
			elif action == "RESET":
				self._targets = dict(self._NOMINAL)
				self._status = "RUNNING"
				self._mode = "PRODUCTION"
				self._drift = {name: 0.0 for name in self._NOMINAL}
				self._noise_state = {name: 0.0 for name in self._NOMINAL}
			else:
				return False
		return True

	def inject_mechanical_jam(self):
		with self._lock:
			self._targets.update({
				"motor_current_amps": 50.0,
				"belt_speed_mps": 0.0,
				"belt_tension_n": 850.0,
			})
			self._status = "JAMMED"
			self._mode = "CLEARING"
		return True

	def create_telemetry_payload(self):
		with self._lock:
			status = self._status
			mode = self._mode
			metrics = {}
			for name, target in self._targets.items():
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

				if status == "JAMMED":
					if name == "motor_current_amps":
						value = max(45.1, value)
					elif name == "belt_speed_mps":
						value = 0.0
					elif name == "belt_tension_n":
						value = max(800.1, value)
				elif name == "vfd_frequency_hz":
						value = self._targets[name]
				elif status == "REVERSING":
					if name in ("vfd_frequency_hz", "belt_speed_mps"):
						value = self._targets[name]
				elif status == "EMERGENCY_STOP":
					if name in ("motor_current_amps", "vfd_frequency_hz", "belt_speed_mps"):
						value = 0.0
				metrics[name] = round(float(value), 3)

		flags = {
			"overcurrent_warning": metrics["motor_current_amps"] > 45.0,
			"motion_loss": abs(metrics["belt_speed_mps"]) < 0.05,
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
		"c": ("control", "REVERSE_CLEAR"),
		"clear": ("control", "REVERSE_CLEAR"),
		"s": ("control", "EMERGENCY_STOP"),
		"stop": ("control", "EMERGENCY_STOP"),
		"r": ("control", "RESET"),
		"reset": ("control", "RESET"),
		"q": ("quit", None),
		"quit": ("quit", None),
	}
	print("Commands: f/fault, c/clear, s/stop, r/reset, q/quit", flush=True)
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
			machine.inject_mechanical_jam()
		elif kind == "control":
			machine.receive_control_command({"action": action})
		else:
			machine.stop()
			return


def main():
	machine = ConveyorSimulator()
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
