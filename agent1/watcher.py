"""Local UDP edge gateway for factory-machine telemetry."""

import json
import math
import os
import re
import selectors
import socket
import threading
import uuid
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
import time

from agent2.agent import validate_telemetry


class EdgeGateway:
	HOST = "127.0.0.1"
	PORT = 5005
	BUFFER_SIZE = 30
	COOLDOWN_SECONDS = 30.0

	def __init__(self, host=HOST, port=PORT, output_dir=None, cooldown_seconds=COOLDOWN_SECONDS, on_telemetry=None):
		self.buffers = defaultdict(lambda: deque(maxlen=self.BUFFER_SIZE))
		self._cooldowns = {}
		self._cooldown_seconds = cooldown_seconds
		self._on_telemetry = on_telemetry
		self._closed = threading.Event()
		self._registry_path = Path(__file__).resolve().parents[1] / "machine_registry.json"
		self._registry_mtime = None
		self._registry = {}
		self._output_dir = (
			Path(output_dir)
			if output_dir is not None
			else Path(__file__).resolve().parents[1] / "new_incoming"
		)
		self._output_dir.mkdir(parents=True, exist_ok=True)
		self._socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
		self._socket.setblocking(False)
		self._socket.bind((host, port))
		self._selector = selectors.DefaultSelector()
		self._selector.register(self._socket, selectors.EVENT_READ)

	@staticmethod
	def _utc_now():
		return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

	@staticmethod
	def _safe_machine_id(machine_id):
		return re.sub(r"[^A-Za-z0-9_.-]+", "_", machine_id).strip("._") or "unknown_machine"

	def _load_registry(self):
		try:
			mtime = self._registry_path.stat().st_mtime_ns
			if mtime != self._registry_mtime:
				data = json.loads(self._registry_path.read_text(encoding="utf-8"))
				self._registry = data if isinstance(data, dict) else {}
				self._registry_mtime = mtime
		except (OSError, json.JSONDecodeError):
			self._registry = {}
			self._registry_mtime = None
		return self._registry

	def _registered_field_anomalies(self, machine_id, payload, telemetry_buffer):
		registry = self._load_registry()
		entry = registry.get(machine_id, {})
		fields = entry.get("fields", {}) if isinstance(entry, dict) else {}
		metrics = payload.get("metrics", {})
		if not isinstance(fields, dict) or not isinstance(metrics, dict):
			return []

		reasons = []
		for field_name in fields:
			current = metrics.get(field_name)
			if isinstance(current, bool) or not isinstance(current, (int, float)) or not math.isfinite(current):
				continue
			history = []
			for sample in list(telemetry_buffer)[:-1]:
				value = sample.get("metrics", {}).get(field_name)
				if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
					history.append(float(value))
			if len(history) < 5:
				continue
			mean = sum(history) / len(history)
			variance = sum((value - mean) ** 2 for value in history) / len(history)
			threshold = max(4.0 * math.sqrt(variance), abs(mean) * 0.02, 1e-9)
			if abs(float(current) - mean) > threshold:
				reasons.append("{}={}{} deviated from baseline".format(field_name, current, fields[field_name]))
		return reasons

	def _save_anomaly(self, machine_id, trigger_flags, telemetry_buffer):
		event_timestamp = datetime.now(timezone.utc)
		timestamp_text = event_timestamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")
		filename_timestamp = event_timestamp.strftime("%Y%m%dT%H%M%S_%fZ")
		safe_id = self._safe_machine_id(machine_id)
		output_path = self._output_dir / "anomaly_payload_{}_{}.json".format(safe_id, filename_timestamp)
		event = {
			"event_id": str(uuid.uuid4()),
			"timestamp": timestamp_text,
			"machine_id": machine_id,
			"trigger_reason": ", ".join(trigger_flags),
			"telemetry_buffer": telemetry_buffer,
		}
		temporary_path = output_path.with_name(output_path.name + ".tmp")
		try:
			with temporary_path.open("w", encoding="utf-8") as event_file:
				json.dump(event, event_file, separators=(",", ":"), allow_nan=False)
				event_file.write("\n")
			os.replace(temporary_path, output_path)
		except Exception:
			try:
				temporary_path.unlink(missing_ok=True)
			except OSError:
				pass
			raise
		return output_path

	def process_datagram(self, datagram):
		try:
			payload = json.loads(datagram.decode("utf-8"))
		except (UnicodeDecodeError, json.JSONDecodeError):
			return None
		if not isinstance(payload, dict):
			return None
		machine_id = payload.get("machine_id")
		if not isinstance(machine_id, str) or not machine_id:
			return None

		telemetry_buffer = self.buffers[machine_id]
		telemetry_buffer.append(payload)
		flags = payload.get("flags")
		registry = self._load_registry()
		registration = registry.get(machine_id, {})
		registered_fields = registration.get("fields", {}) if isinstance(registration, dict) else {}
		candidate_fields = self._registered_field_anomalies(machine_id, payload, telemetry_buffer)
		assessment = validate_telemetry(
			machine_id,
			payload.get("metrics", {}),
			flags=flags,
			registered_fields=registered_fields,
			status=payload.get("status", "RUNNING"),
		)
		anomaly_fields = assessment["issues"]
		relay_payload = dict(payload)
		relay_payload["field_variations"] = candidate_fields
		relay_payload["operational_assessment"] = assessment
		relay_payload["validated_anomalies"] = anomaly_fields
		telemetry_buffer[-1] = relay_payload
		trigger_flags = [
			"{}: {}".format(issue["field"], issue["reason"])
			for issue in anomaly_fields
		]
		if self._on_telemetry is not None:
			try:
				self._on_telemetry(relay_payload)
			except Exception as exc:
				print("Telemetry relay failed: {}".format(exc), flush=True)
		if not trigger_flags:
			return None

		now = time.monotonic()
		if now < self._cooldowns.get(machine_id, 0.0):
			return None

		try:
			output_path = self._save_anomaly(machine_id, trigger_flags, list(telemetry_buffer))
		except (OSError, TypeError, ValueError) as exc:
			print("Failed to save anomaly for {}: {}".format(machine_id, exc), flush=True)
			return None
		self._cooldowns[machine_id] = now + self._cooldown_seconds
		print(
			"\033[91mANOMALY DETECTED [{}]: {} | saved {}\033[0m".format(
				machine_id, ", ".join(trigger_flags), output_path.name
			),
			flush=True,
		)
		return output_path

	def serve_forever(self):
		print("Edge Gateway listening on {}:{}".format(*self._socket.getsockname()), flush=True)
		try:
			while not self._closed.is_set():
				try:
					ready = self._selector.select(timeout=0.5)
				except (OSError, ValueError):
					if self._closed.is_set():
						break
					raise
				for key, _ in ready:
					try:
						datagram, _address = key.fileobj.recvfrom(65535)
					except BlockingIOError:
						continue
					self.process_datagram(datagram)
		except KeyboardInterrupt:
			print("\nEdge Gateway shutting down.", flush=True)
		finally:
			self.close()

	def close(self):
		if self._closed.is_set():
			return
		self._closed.set()
		self._selector.close()
		self._socket.close()


def main():
	EdgeGateway().serve_forever()


if __name__ == "__main__":
	main()
