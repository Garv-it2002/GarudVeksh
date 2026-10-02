"""Autonomous industrial anomaly triage and control-plane agent."""

import os
import time
import json
import glob
import shutil
import socket
import sys
import uuid
from pathlib import Path

from google import genai
from google.genai import types

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent1.control_server import CONTROL_HOST, CONTROL_PORTS


# Local testing only; remove this value before sharing or deploying the script.
API_KEY_FOR_LOCAL_TESTING = ""
if API_KEY_FOR_LOCAL_TESTING:
    os.environ["GEMINI_API_KEY"] = API_KEY_FOR_LOCAL_TESTING

client = genai.Client()
MODEL_NAME = "gemini-3.5-flash-lite"
INCOMING_DIR = PROJECT_ROOT / "new_incoming"
ARCHIVE_DIR = PROJECT_ROOT / "archives"
INCOMING_DIR.mkdir(parents=True, exist_ok=True)
ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)

SYSTEM_INSTRUCTION = """You are an autonomous industrial diagnostic AI. You receive 15-second telemetry windows of failing machines.
1. Identify the mechanical failure.
2. You MUST use the execute_control_action tool to mitigate it.
- For M1_CNC_MILL thermal/vibration spikes, action="THROTTLE_DOWN", target_value=2000.
- For M2_HYDRAULIC_PRESS pressure drops, action="DEPRESSURIZE_PARK", target_value=15.0.
- For M3_VFD_CONVEYOR amperage spikes (jam), action="REVERSE_CLEAR", target_value=-15.0.
"""


def execute_control_action(
    machine_id: str,
    action: str,
    target_value: float,
    reason: str,
    procurement_requisition: str,
) -> str:
    """Executes a control plane action on a machine to mitigate an active failure."""
    expected_actions = {
        "M1_CNC_MILL": "THROTTLE_DOWN",
        "M2_HYDRAULIC_PRESS": "DEPRESSURIZE_PARK",
        "M3_VFD_CONVEYOR": "REVERSE_CLEAR",
    }
    action = action.strip().upper()
    if machine_id not in CONTROL_PORTS or expected_actions.get(machine_id) != action:
        raise ValueError("Unsupported machine/action pair: {} / {}".format(machine_id, action))

    request_id = str(uuid.uuid4())
    command = {
        "request_id": request_id,
        "machine_id": machine_id,
        "action": action,
        "target_value": target_value,
        "reason": reason,
        "procurement_requisition": procurement_requisition,
    }
    print("\n[CONTROL PLANE REQUEST] -> {}".format(machine_id), flush=True)
    print("  ACTION: {} (Target: {})".format(action, target_value))
    print("  REASON: {}".format(reason))
    print("  PROCUREMENT: Ordering {}...".format(procurement_requisition), flush=True)

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as control_socket:
        control_socket.settimeout(3.0)
        control_socket.sendto(
            json.dumps(command, separators=(",", ":")).encode("utf-8"),
            (CONTROL_HOST, CONTROL_PORTS[machine_id]),
        )
        try:
            response_data, _address = control_socket.recvfrom(2048)
        except (socket.timeout, OSError) as exc:
            raise RuntimeError(
                "No control acknowledgment from {}. Is its simulator running?".format(machine_id)
            ) from exc

    acknowledgment = json.loads(response_data.decode("utf-8"))
    if (
        acknowledgment.get("request_id") != request_id
        or acknowledgment.get("machine_id") != machine_id
        or acknowledgment.get("action") != action
        or acknowledgment.get("accepted") is not True
    ):
        raise RuntimeError("{} rejected control action {}.".format(machine_id, action))

    print("[CONTROL PLANE ACTIVATED] -> {} acknowledged {}".format(machine_id, action), flush=True)
    return "{} acknowledged {} on {}.".format(machine_id, action, machine_id)


config = types.GenerateContentConfig(
    temperature=0.1,
    tools=[execute_control_action],
    system_instruction=SYSTEM_INSTRUCTION,
    automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
)


def process_anomaly_file(filepath: str) -> bool:
    """Analyze an anomaly file, execute returned tool calls, then archive it."""
    with open(filepath, "r", encoding="utf-8") as anomaly_file:
        json_content_string = anomaly_file.read()
    json.loads(json_content_string)

    response = client.models.generate_content(
        model=MODEL_NAME,
        contents=json_content_string,
        config=config,
    )

    response_text = getattr(response, "text", None)
    if response_text:
        print(response_text, flush=True)

    function_calls = getattr(response, "function_calls", None) or []
    if not function_calls:
        raise RuntimeError("Gemini returned no control action; anomaly file left in place.")

    for function_call in function_calls:
        if function_call.name != "execute_control_action":
            print("Ignoring unrecognized tool call: {}".format(function_call.name), flush=True)
            continue
        try:
            result = execute_control_action(**dict(function_call.args or {}))
        except (TypeError, ValueError) as exc:
            print("Invalid control action arguments: {}".format(exc), flush=True)
            raise
        print(result, flush=True)

    archived_path = os.path.join(str(ARCHIVE_DIR), os.path.basename(filepath))
    shutil.move(filepath, archived_path)
    print("Archived processed anomaly: {}".format(archived_path), flush=True)
    return True


def watchdog_loop():
    while True:
        for filepath in glob.glob(str(INCOMING_DIR / "anomaly_payload_*.json")):
            try:
                process_anomaly_file(filepath)
            except Exception as exc:
                print("Failed to process {}: {}".format(filepath, exc), flush=True)
        time.sleep(3)


if __name__ == "__main__":
    print("Industrial diagnostic agent using {} is watching for anomalies.".format(MODEL_NAME), flush=True)
    watchdog_loop()
