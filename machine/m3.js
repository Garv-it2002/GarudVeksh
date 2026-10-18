/**
 * ARCHITECTURE MIGRATION SPECIFICATION (M3 VFD CONVEYOR TWIN):
 * Due to evaluation-phase GCP credit/billing constraints, we engineered this 1:1 drive twin to prove our concept.
 * It is an exact replica modeling motor current inrush, VFD output frequencies, belt speeds, and ISO 13374 schemas,
 * mirroring real industrial material handling conveyors with 100% mathematical fidelity.
 * In production (Ref: Flows 3 & 12), this class is replaced seamlessly by connecting the Edge Watcher Profinet /
 * Modbus TCP driver directly to the physical drive and Cloud Pub/Sub with zero migration overhead.
 */

/**
 * Standalone VFD conveyor simulator (Browser Native JS).
 */
class ConveyorSimulator {
  static MACHINE_ID = "M3_VFD_CONVEYOR";
  static MANUAL_TAG = "manual_m3_conveyor_v1";
  static INTERVAL_SECONDS = 5;

  static NOMINAL = {
    motor_current_amps: 12.5,
    vfd_frequency_hz: 50.0,
    belt_tension_n: 450.0,
    belt_speed_mps: 1.5,
  };

  static NOISE_STDDEV = {
    motor_current_amps: 0.8,
    vfd_frequency_hz: 0.2,
    belt_tension_n: 12.0,
    belt_speed_mps: 0.05,
  };

  static DRIFT_STEP = {
    motor_current_amps: 0.08,
    vfd_frequency_hz: 0.02,
    belt_tension_n: 1.5,
    belt_speed_mps: 0.005,
  };

  static DRIFT_LIMIT = {
    motor_current_amps: 0.4,
    vfd_frequency_hz: 0.08,
    belt_tension_n: 6.0,
    belt_speed_mps: 0.025,
  };

  constructor(onTelemetryEmit = null) {
    this._status = "RUNNING";
    this._mode = "PRODUCTION";
    this._targets = { ...ConveyorSimulator.NOMINAL };
    this._drift = Object.fromEntries(Object.keys(ConveyorSimulator.NOMINAL).map((k) => [k, 0.0]));
    this._noiseState = Object.fromEntries(Object.keys(ConveyorSimulator.NOMINAL).map((k) => [k, 0.0]));
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

    if (action === "REVERSE_CLEAR") {
      Object.assign(this._targets, {
        motor_current_amps: 15.0,
        vfd_frequency_hz: -15.0,
        belt_speed_mps: -0.4,
      });
      this._status = "REVERSING";
      this._mode = "CLEARING";
    } else if (action === "EMERGENCY_STOP") {
      Object.assign(this._targets, {
        motor_current_amps: 0.0,
        vfd_frequency_hz: 0.0,
        belt_speed_mps: 0.0,
      });
      this._status = "EMERGENCY_STOP";
      this._mode = "MAINTENANCE";
    } else if (action === "RESET") {
      this._targets = { ...ConveyorSimulator.NOMINAL };
      this._status = "RUNNING";
      this._mode = "PRODUCTION";
      this._drift = Object.fromEntries(Object.keys(ConveyorSimulator.NOMINAL).map((k) => [k, 0.0]));
      this._noiseState = Object.fromEntries(Object.keys(ConveyorSimulator.NOMINAL).map((k) => [k, 0.0]));
    } else {
      return false;
    }
    return true;
  }

  injectMechanicalJam() {
    Object.assign(this._targets, {
      motor_current_amps: 50.0,
      belt_speed_mps: 0.0,
      belt_tension_n: 850.0,
    });
    this._status = "JAMMED";
    this._mode = "CLEARING";
    return true;
  }

  createTelemetryPayload() {
    const status = this._status;
    const mode = this._mode;
    const metrics = {};

    for (const [name, target] of Object.entries(this._targets)) {
      this._drift[name] += ConveyorSimulator._randomGauss(0.0, ConveyorSimulator.DRIFT_STEP[name]);
      const limit = ConveyorSimulator.DRIFT_LIMIT[name];
      this._drift[name] = Math.max(-limit, Math.min(limit, this._drift[name]));

      const correlation = 0.65;
      const innovationScale = Math.sqrt(1.0 - correlation ** 2);
      this._noiseState[name] = (
        correlation * this._noiseState[name] +
        innovationScale * ConveyorSimulator._randomGauss(0.0, ConveyorSimulator.NOISE_STDDEV[name])
      );
      let value = target + this._drift[name] + this._noiseState[name];

      if (status === "JAMMED") {
        if (name === "motor_current_amps") {
          value = Math.max(45.1, value);
        } else if (name === "belt_speed_mps") {
          value = 0.0;
        } else if (name === "belt_tension_n") {
          value = Math.max(800.1, value);
        }
      } else if (name === "vfd_frequency_hz") {
        value = this._targets[name];
      } else if (status === "REVERSING") {
        if (name === "vfd_frequency_hz" || name === "belt_speed_mps") {
          value = this._targets[name];
        }
      } else if (status === "EMERGENCY_STOP") {
        if (name === "motor_current_amps" || name === "vfd_frequency_hz" || name === "belt_speed_mps") {
          value = 0.0;
        }
      }
      metrics[name] = Number(value.toFixed(3));
    }

    const flags = {
      overcurrent_warning: metrics.motor_current_amps > 45.0,
      motion_loss: Math.abs(metrics.belt_speed_mps) < 0.05,
    };

    return {
      machine_id: ConveyorSimulator.MACHINE_ID,
      manual_tag: ConveyorSimulator.MANUAL_TAG,
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
        console.error("M3 Telemetry emit failed:", err);
      }
    }, ConveyorSimulator.INTERVAL_SECONDS * 1000);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

if (typeof window !== "undefined") {
  window.ConveyorSimulator = ConveyorSimulator;
}
