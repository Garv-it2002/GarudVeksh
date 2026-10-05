"""Agent 1: dummy RAG-backed operational-limit validation."""

import math


# Replace these demo limits with retrieved manual/engineering-limit documents.
DUMMY_RAG_LIMITS = {
    "M1_CNC_MILL": {
        "spindle_rpm": {"min": 9850.0, "max": 10150.0, "source": "dummy M1 operating envelope"},
        "bearing_temp_c": {"min": 0.0, "max": 85.0, "source": "dummy M1 bearing limit"},
        "vibration_rms": {"min": 0.0, "max": 1.5, "source": "dummy M1 vibration limit"},
        "coolant_flow_lpm": {"min": 8.0, "max": None, "source": "dummy M1 coolant minimum"},
        "spindle_load_pct": {"min": 0.0, "max": 100.0, "source": "dummy M1 load envelope"},
    },
    "M2_HYDRAULIC_PRESS": {
        "line_pressure_psi": {"min": 2500.0, "max": 3500.0, "source": "dummy M2 pressure envelope"},
        "oil_temp_c": {"min": 30.0, "max": 75.0, "source": "dummy M2 oil-temperature envelope"},
        "oil_viscosity_cst": {"min": 35.0, "max": 60.0, "source": "dummy M2 viscosity envelope"},
        "ram_cycle_rate_cpm": {"min": 0.0, "max": 16.0, "source": "dummy M2 cycle-rate envelope"},
    },
    "M3_VFD_CONVEYOR": {
        "motor_current_amps": {"min": 0.0, "max": 45.0, "source": "dummy M3 overcurrent limit"},
        "vfd_frequency_hz": {"min": 45.0, "max": 55.0, "source": "dummy M3 production frequency envelope"},
        "belt_tension_n": {"min": 350.0, "max": 550.0, "source": "dummy M3 tension envelope"},
        "belt_speed_mps": {"min": 1.2, "max": 1.8, "source": "dummy M3 production speed envelope"},
    },
}

_FLAG_FIELDS = {
    "M1_CNC_MILL": {
        "thermal_warning": "bearing_temp_c",
        "vibration_warning": "vibration_rms",
        "coolant_low": "coolant_flow_lpm",
    },
    "M2_HYDRAULIC_PRESS": {
        "pressure_warning": "line_pressure_psi",
        "leak_detected": "line_pressure_psi",
    },
    "M3_VFD_CONVEYOR": {
        "overcurrent_warning": "motor_current_amps",
        "motion_loss": "belt_speed_mps",
    },
}

_CONTROLLED_STATUSES = {
    "THROTTLED",
    "BYPASS_ACTIVE",
    "REVERSING",
    "EMERGENCY_STOP",
}


def retrieve_operating_limits(machine_id: str, field_name: str):
    """Return demo knowledge for a metric; replace with vector/manual retrieval later."""
    return DUMMY_RAG_LIMITS.get(machine_id, {}).get(field_name)


def validate_telemetry(machine_id: str, metrics: dict, flags=None, registered_fields=None, status="RUNNING"):
    """Only confirm issues supported by a retrieved operational limit."""
    if not isinstance(metrics, dict):
        return {"validated": False, "issues": [], "unverified_fields": []}
    if str(status).upper() in _CONTROLLED_STATUSES:
        return {"validated": False, "issues": [], "unverified_fields": [], "reason": "intentional control state"}

    if registered_fields is None:
        fields = set(metrics.keys())
    elif isinstance(registered_fields, dict):
        fields = set(registered_fields)
    else:
        fields = set(registered_fields)
    flag_fields = _FLAG_FIELDS.get(machine_id, {})
    flagged_fields = {
        field_name
        for flag_name, field_name in flag_fields.items()
        if field_name in fields and isinstance(flags, dict) and flags.get(flag_name) is True
    }
    observed_fields = fields
    issues = []
    unverified = []

    for field_name in observed_fields:
        value = metrics.get(field_name)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            continue
        limits = retrieve_operating_limits(machine_id, field_name)
        if limits is None:
            if field_name in flagged_fields:
                unverified.append(field_name)
            continue
        below_min = limits["min"] is not None and value < limits["min"]
        above_max = limits["max"] is not None and value > limits["max"]
        if below_min or above_max:
            issues.append({
                "field": field_name,
                "value": value,
                "min": limits["min"],
                "max": limits["max"],
                "source": limits["source"],
                "reason": "below operational minimum" if below_min else "above operational maximum",
            })

    return {
        "validated": bool(issues),
        "issues": issues,
        "unverified_fields": sorted(set(unverified)),
        "knowledge_source": "dummy RAG operational-limit set",
    }
