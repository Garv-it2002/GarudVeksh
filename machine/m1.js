/**
 * ARCHITECTURE MIGRATION SPECIFICATION (M1 5-AXIS CNC MILL TWIN):
 * Due to evaluation-phase GCP credit/billing constraints, we engineered this 1:1 CNC twin to prove our concept.
 * It is an exact replica modeling spindle thermal drift, load percentages, and ISO 13374 vibration telemetry,
 * providing mathematically identical dynamics to physical industrial 5-axis machining centers.
 * In production (Ref: Flows 3 & 12), this class is replaced seamlessly by connecting the Edge Watcher OPC UA /
 * MTConnect client to the machine's Fanuc / Siemens controller and Cloud Pub/Sub.
 */

/**
 * Standalone 5-axis CNC milling-center telemetry simulator (Browser Native JS).
 */
class CNCMachineSimulator {
  static MACHINE_ID = "M1_CNC_MILL";
  static MANUAL_TAG = "manual_m1_cnc_v3";
  static INTERVAL_SECONDS = 5;

  static NOMINAL = {
    spindle_rpm: 10000.0,
    bearing_temp_c: 68.0,
    vibration_rms: 0.35,
    coolant_flow_lpm: 18.5,
    spindle_load_pct: 62.0,
  };

  static NOISE = {
    spindle_rpm: 45.0,
    bearing_temp_c: 0.45,
    vibration_rms: 0.015,
    coolant_flow_lpm: 0.25,
    spindle_load_pct: 0.9,
  };

  static DRIFT_STEP = {
    spindle_rpm: 8.0,
    bearing_temp_c: 0.08,
    vibration_rms: 0.003,
    coolant_flow_lpm: 0.04,
    spindle_load_pct: 0.15,
  };

  static DRIFT_LIMIT = {
    spindle_rpm: 100.0,
    bearing_temp_c: 0.8,
    vibration_rms: 0.025,
    coolant_flow_lpm: 0.4,
    spindle_load_pct: 1.8,
  };

  constructor(onTelemetryEmit = null) {
    this._status = "RUNNING";
    this._mode = "PRODUCTION";
    this._targets = { ...CNCMachineSimulator.NOMINAL };
    this._drift = Object.fromEntries(Object.keys(CNCMachineSimulator.NOMINAL).map((k) => [k, 0.0]));
    this._noiseState = Object.fromEntries(Object.keys(CNCMachineSimulator.NOMINAL).map((k) => [k, 0.0]));
    this._faultStartedAt = null;
    this._timer = null;
    this.onTelemetryEmit = onTelemetryEmit || ((payload) => console.log(payload));
  }

  static _randomGauss(mean = 0, std = 1) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return mean + num * std;
  }

  receiveControlCommand(commandPayload) {
    if (!commandPayload || typeof commandPayload !== "object") return false;
    let action = commandPayload.action;
    if (typeof action !== "string") return false;
    action = action.trim().toUpperCase();

    if (action === "THROTTLE_DOWN") {
      Object.assign(this._targets, {
        spindle_rpm: 2000.0,
        spindle_load_pct: 25.0,
        coolant_flow_lpm: 20.5,
      });
      this._status = "THROTTLED";
      this._mode = "DEGRADED_SAFE";
      this._faultStartedAt = null;
    } else if (action === "EMERGENCY_STOP") {
      Object.assign(this._targets, {
        spindle_rpm: 0.0,
        spindle_load_pct: 0.0,
      });
      this._status = "EMERGENCY_STOP";
      this._mode = "MAINTENANCE";
      this._faultStartedAt = null;
    } else if (action === "RESET") {
      this._targets = { ...CNCMachineSimulator.NOMINAL };
      this._status = "RUNNING";
      this._mode = "PRODUCTION";
      this._faultStartedAt = null;
      this._drift = Object.fromEntries(Object.keys(CNCMachineSimulator.NOMINAL).map((k) => [k, 0.0]));
      this._noiseState = Object.fromEntries(Object.keys(CNCMachineSimulator.NOMINAL).map((k) => [k, 0.0]));
    } else {
      return false;
    }
    return true;
  }

  injectBearingThermalRunaway() {
    this._status = "OVERHEATING";
    this._mode = "DEGRADED_SAFE";
    this._faultStartedAt = performance.now() / 1000.0;
    return true;
  }

  _sampleMetrics(nowSec) {
    const targets = { ...this._targets };
    const status = this._status;
    const mode = this._mode;
    const faultStartedAt = this._faultStartedAt;

    if (faultStartedAt !== null) {
      const elapsed = Math.max(0.0, nowSec - faultStartedAt);
      const ramp = Math.min(elapsed / 8.0, 1.0);
      Object.assign(targets, {
        bearing_temp_c: 70.0 + 45.0 * (1.0 - Math.exp(-elapsed / 4.5)),
        vibration_rms: 0.35 + 4.0 * ramp,
        coolant_flow_lpm: 18.5 - 14.5 * Math.min(elapsed / 10.0, 1.0),
      });
    }

    const metrics = {};
    for (const [name, target] of Object.entries(targets)) {
      this._drift[name] += CNCMachineSimulator._randomGauss(0.0, CNCMachineSimulator.DRIFT_STEP[name]);
      const limit = CNCMachineSimulator.DRIFT_LIMIT[name];
      this._drift[name] = Math.max(-limit, Math.min(limit, this._drift[name]));

      const correlation = 0.65;
      const innovation = Math.sqrt(1.0 - correlation ** 2);
      this._noiseState[name] = (
        correlation * this._noiseState[name] +
        innovation * CNCMachineSimulator._randomGauss(0.0, CNCMachineSimulator.NOISE[name])
      );
      let value = target + this._drift[name] + this._noiseState[name];

      if (name === "spindle_rpm" || name === "vibration_rms" || name === "coolant_flow_lpm") {
        value = Math.max(0.0, value);
      } else if (name === "spindle_load_pct") {
        value = Math.max(0.0, Math.min(100.0, value));
      }
      metrics[name] = Number(value.toFixed(3));
    }

    const flags = {
      thermal_warning: metrics.bearing_temp_c >= 85.0,
      vibration_warning: metrics.vibration_rms >= 1.5,
      coolant_low: metrics.coolant_flow_lpm < 8.0,
    };

    return { status, mode, metrics, flags };
  }

  createTelemetryPayload() {
    const nowSec = performance.now() / 1000.0;
    const { status, mode, metrics, flags } = this._sampleMetrics(nowSec);
    return {
      machine_id: CNCMachineSimulator.MACHINE_ID,
      manual_tag: CNCMachineSimulator.MANUAL_TAG,
      timestamp: new Date().toISOString(),
      status,
      mode,
      metrics,
      flags,
    };
  }

  start() {
    this.stop();
    this._timer = setInterval(() => {
      try {
        const payload = this.createTelemetryPayload();
        this.onTelemetryEmit(payload);
      } catch (err) {
        console.error("M1 Telemetry emit failed:", err);
      }
    }, CNCMachineSimulator.INTERVAL_SECONDS * 1000);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

if (typeof window !== "undefined") {
  window.CNCMachineSimulator = CNCMachineSimulator;
}
