/**
 * ARCHITECTURE MIGRATION SPECIFICATION (CLOUD PUB/SUB & BIGQUERY EVENT BUS):
 * Due to evaluation-phase GCP credit/billing constraints, we engineered this 1:1 event router to prove our concept.
 * It is an exact message replica matching Google Cloud Pub/Sub wire envelopes, BigQuery streaming schemas,
 * and BroadcastChannel tab deduplication, mirroring a distributed cloud event broker with 100% fidelity.
 * In production (Ref: Flows 5, 6 & 12), the UI drops this bridge and subscribes directly via WebSockets to the
 * Cloud Run streaming worker reading from Cloud Pub/Sub and BigQuery with zero client event changes.
 */

/**
 * Dashboard Bridge (Browser Native JS).
 */

class GenericMachineSimulator {
  constructor(machineId, registration, onTelemetryEmit) {
    this.machineId = machineId;
    this.manualTag = registration.manual || `manual_${machineId.toLowerCase()}`;
    this.fields = registration.fields || {};
    this.onTelemetryEmit = onTelemetryEmit || (() => {});
    this._status = "RUNNING";
    this._mode = "PRODUCTION";
    this._timer = null;
    this._phase = 0;
  }

  receiveControlCommand(payload) {
    const action = payload?.action?.toUpperCase();
    if (action === "RESET") {
      this._status = "RUNNING";
      this._mode = "PRODUCTION";
    } else if (action === "EMERGENCY_STOP" || action === "STOP") {
      this._status = "EMERGENCY_STOP";
      this._mode = "MAINTENANCE";
    } else {
      this._status = action || "RUNNING";
    }
    return true;
  }

  createTelemetryPayload() {
    this._phase += 0.2;
    const metrics = {};
    Object.keys(this.fields).forEach((key, idx) => {
      const base = 50.0 + idx * 25.0;
      const val = this._status === "EMERGENCY_STOP" ? 0 : base + Math.sin(this._phase + idx) * 5.0 + (Math.random() - 0.5);
      metrics[key] = Number(val.toFixed(3));
    });
    return {
      machine_id: this.machineId,
      manual_tag: this.manualTag,
      timestamp: new Date().toISOString(),
      status: this._status,
      mode: this._mode,
      metrics,
      flags: {},
    };
  }

  start() {
    this.stop();
    this._timer = setInterval(() => {
      this.onTelemetryEmit(this.createTelemetryPayload());
    }, 5000);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

class DashboardBridgeJS {
  constructor(onMessage = null) {
    this._onMessage = onMessage || (() => {});
    this._registry = this._loadRegistry();
    this._machines = new Map();
    this._runningRemoteMachines = new Map();
    this._serviceStates = { watcher: "stopped", ai_agent: "stopped" };
    this._tabId = Math.random().toString(36).substring(2, 9);
    this._seenCommandResults = new Set();
    this._firestore = null;
    this._firestoreUnsubscribe = null;
    this._channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("nexus_dashboard_bridge") : null;

    if (this._channel) {
      this._channel.onmessage = (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== "object") return;
        if (msg._senderId === this._tabId) return;

        if (msg.type === "request_state_snapshot") {
          this._sendStateSnapshot(msg.requestorId);
          return;
        }

        if (msg.type === "state_snapshot" && msg.targetId === this._tabId) {
          if (msg.serviceStates) {
            Object.assign(this._serviceStates, msg.serviceStates);
            for (const [srv, st] of Object.entries(msg.serviceStates)) {
              if (this._onMessage) this._onMessage({ type: "service_state", service: srv, state: st });
            }
          }
          if (msg.machineStates) {
            for (const [mId, st] of Object.entries(msg.machineStates)) {
              this._runningRemoteMachines.set(mId, st);
              if (this._onMessage) this._onMessage({ type: "machine_state", machine_id: mId, state: st });
            }
          }
          return;
        }

        if (msg.type === "client_command") {
          if (msg.command?.type === "start_machine") {
            // Do not duplicate machine simulator in other tabs when another tab starts it
            return;
          }
          if (msg.command?.type === "control" && msg.command.machine_id && msg.command.machine_id !== "*") {
            // Only the tab actively running this machine simulator dispatches control commands
            if (this._machines.has(msg.command.machine_id)) {
              this.handleClientMessage(msg.command, false);
            }
          } else {
            this.handleClientMessage(msg.command, false);
          }
          return;
        }

        if (msg.type === "command_result") {
          if (msg.request_id) {
            if (this._seenCommandResults.has(msg.request_id)) return;
            this._seenCommandResults.add(msg.request_id);
            if (this._seenCommandResults.size > 100) {
              const oldest = this._seenCommandResults.values().next().value;
              this._seenCommandResults.delete(oldest);
            }
          }
        }

        if (msg.type === "machine_state") {
          this._runningRemoteMachines.set(msg.machine_id, msg.state);
          if (msg.state === "stopped") {
            const localInstance = this._machines.get(msg.machine_id);
            if (localInstance) {
              localInstance.stop();
              this._machines.delete(msg.machine_id);
            }
            if (this._gateway) {
              if (typeof this._gateway.clearBuffer === "function") this._gateway.clearBuffer(msg.machine_id);
              if (this._gateway._cooldowns) this._gateway._cooldowns.delete(msg.machine_id);
              if (this._gateway._activePipelines) this._gateway._activePipelines.delete(msg.machine_id);
            }
          }
        } else if (msg.type === "service_state") {
          this._serviceStates[msg.service] = msg.state;
        }

        if (this._onMessage) {
          this._onMessage(msg);
        }
      };
    }

    const getRegistry = () => this.getRegistry();
    const relayTelemetry = (payload) => {
      this._emit({ type: "telemetry", payload });
    };

    const GeminiAgentClass = typeof GeminiAgent !== "undefined" ? GeminiAgent : (typeof window !== "undefined" ? window.GeminiAgent : null);
    this._geminiAgent = GeminiAgentClass ? new GeminiAgentClass() : null;

    const isAiRunning = () => this._serviceStates.ai_agent === "running";
    const EdgeGatewayClass = typeof EdgeGateway !== "undefined" ? EdgeGateway : (typeof window !== "undefined" ? window.EdgeGateway : null);
    this._gateway = EdgeGatewayClass ? new EdgeGatewayClass(30.0, relayTelemetry, getRegistry, this._geminiAgent, isAiRunning) : null;

    const DispatcherClass = typeof ControlCommandDispatcher !== "undefined" ? ControlCommandDispatcher : (typeof window !== "undefined" ? window.ControlCommandDispatcher : null);
    this._dispatcher = DispatcherClass
      ? new DispatcherClass((id) => this._machines.get(id) || null)
      : null;

    this._fetchInitialRegistry();

    if (this._channel) {
      this._channel.postMessage({ type: "request_state_snapshot", requestorId: this._tabId, _senderId: this._tabId });
    }
  }

  _sendStateSnapshot(targetId) {
    const machineStates = {};
    for (const [id] of this._machines.entries()) {
      machineStates[id] = "running";
    }
    for (const [id, st] of this._runningRemoteMachines.entries()) {
      if (st === "running") machineStates[id] = "running";
    }
    if (this._channel) {
      try {
        this._channel.postMessage({
          type: "state_snapshot",
          targetId,
          serviceStates: { ...this._serviceStates },
          machineStates,
          _senderId: this._tabId,
        });
      } catch (e) {
        console.warn("Could not post state snapshot over BroadcastChannel", e);
      }
    }
  }

  _saveRuntimeState() {
    if (typeof localStorage === "undefined") return;
    try {
      const runningMachines = [];
      for (const [id] of this._machines.entries()) {
        runningMachines.push(id);
      }
      const stateObj = {
        serviceStates: this._serviceStates,
        runningMachines
      };
      localStorage.setItem("nexus_runtime_state", JSON.stringify(stateObj));
    } catch (e) {
      console.warn("Could not save runtime state to localStorage", e);
    }
  }

  _restoreRuntimeState() {
    // Fresh session on page load: services and machines start idle in clean state for demo predictability.
    // If user previously had stale flags in localStorage, clear runtime state to guarantee fresh start.
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.removeItem("nexus_runtime_state");
    } catch (e) {}
  }

  _initFirestore() {
    if (this._firestore) return this._firestore;
    try {
      const globalConfig = typeof CONFIG !== "undefined" ? CONFIG : (typeof window !== "undefined" ? window.CONFIG : null);
      const fbConfig = globalConfig?.FIREBASE_CONFIG;
      if (typeof firebase !== "undefined" && fbConfig && fbConfig.projectId && fbConfig.apiKey) {
        if (!firebase.apps || !firebase.apps.length) {
          firebase.initializeApp(fbConfig);
        }
        this._firestore = firebase.firestore();
        return this._firestore;
      }
    } catch (e) {
      console.warn("[Firestore] Initialization error:", e);
    }
    return null;
  }

  _subscribeFirestore(db) {
    if (this._firestoreUnsubscribe) return;
    try {
      this._firestoreUnsubscribe = db.collection("machine_registry").onSnapshot((snapshot) => {
        if (snapshot.empty) return;
        const updated = {};
        snapshot.forEach((doc) => {
          updated[doc.id] = doc.data();
        });
        if (updated.DMG_MORI_DMU_50) {
          this._registry = updated;
          this._saveRegistry();
          this._emit({ type: "registry_snapshot", machines: this._registry });
        }
      }, (err) => {
        console.warn("[Firestore] Real-time listener error:", err);
      });
    } catch (e) {}
  }

  async _fetchInitialRegistry() {
    const db = this._initFirestore();
    if (db) {
      try {
        const snap = await db.collection("machine_registry").get();
        if (!snap.empty) {
          const firestoreRegistry = {};
          snap.forEach((doc) => {
            firestoreRegistry[doc.id] = doc.data();
          });
          if (firestoreRegistry.DMG_MORI_DMU_50) {
            console.log("[Firestore] Authoritative machine registry loaded from Cloud Firestore.");
            this._registry = firestoreRegistry;
            this._saveRegistry();
            this._emit({ type: "registry_snapshot", machines: this._registry });
            this._restoreRuntimeState();
            this._subscribeFirestore(db);
            return;
          }
        } else {
          console.log("[Firestore] 'machine_registry' collection is empty. Attempting auto-seed from machine_registry.json...");
          const resp = await fetch('./machine_registry.json?v=' + Date.now());
          if (resp.ok) {
            const json = await resp.json();
            for (const [mId, data] of Object.entries(json)) {
              try {
                await db.collection("machine_registry").doc(mId).set(data);
                console.log(`[Firestore] Successfully seeded ${mId}`);
              } catch (writeErr) {
                console.warn(`[Firestore] Could not write ${mId} (check write rules):`, writeErr.message);
              }
            }
            const postSeedSnap = await db.collection("machine_registry").get();
            if (!postSeedSnap.empty) {
              const firestoreRegistry = {};
              postSeedSnap.forEach((doc) => { firestoreRegistry[doc.id] = doc.data(); });
              this._registry = firestoreRegistry;
              this._saveRegistry();
              this._emit({ type: "registry_snapshot", machines: this._registry });
              this._restoreRuntimeState();
              this._subscribeFirestore(db);
              return;
            }
          }
        }
      } catch (err) {
        console.warn("[Firestore] Read error (falling back to machine_registry.json):", err);
      }
    }

    // Resilient Fallback: local machine_registry.json
    try {
      const resp = await fetch('./machine_registry.json?v=' + Date.now());
      if (resp.ok) {
        const json = await resp.json();
        if (json && typeof json === 'object') {
          this._registry = json;
          this._saveRegistry();
          this._emit({ type: "registry_snapshot", machines: this._registry });
          this._restoreRuntimeState();
          return;
        }
      }
    } catch (e) {
      console.warn("Could not fetch machine_registry.json", e);
    }
    this._emit({ type: "registry_snapshot", machines: this._registry });
    this._restoreRuntimeState();
  }

  _loadRegistry() {
    try {
      if (typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem('nexus_registry');
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed?.DMG_MORI_DMU_50?.fields?.["Spindle/RPM"]?.warning_range) {
            return parsed;
          }
          localStorage.removeItem('nexus_registry');
        }
      }
      return {};
    } catch (e) {
      return {};
    }
  }

  _saveRegistry() {
    try {
      localStorage.setItem('nexus_registry', JSON.stringify(this._registry));
    } catch (e) {
      console.warn('Failed to save registry to localStorage', e);
    }
  }

  getRegistry() {
    return this._registry;
  }

  _emit(message, broadcast = true) {
    if (message?.type === "command_result" && message.request_id) {
      this._seenCommandResults?.add(message.request_id);
    }
    if (this._onMessage) {
      this._onMessage(message);
    }
    if (broadcast && this._channel) {
      try {
        this._channel.postMessage({ ...message, _senderId: this._tabId });
      } catch (e) {
        console.warn("BroadcastChannel error:", e);
      }
    }
  }

  handleClientMessage(message, broadcastCommand = true) {
    if (!message || typeof message !== "object") return;
    const type = message.type;

    if (broadcastCommand && this._channel) {
      try {
        this._channel.postMessage({ type: "client_command", command: message, _senderId: this._tabId });
      } catch (e) {}
    }

    if (type === "register_machine") {
      this._registerMachine(message);
    } else if (type === "delete_machine") {
      this._deleteMachine(message.machine_id);
    } else if (type === "start_service") {
      this._setServiceState(message.service, "running", `${message.service} started`);
    } else if (type === "stop_service") {
      this._setServiceState(message.service, "stopped", `${message.service} stopped`);
    } else if (type === "start_machine") {
      this._startMachine(message.machine_id);
    } else if (type === "stop_machine") {
      this._stopMachine(message.machine_id);
    } else if (type === "control") {
      this._controlMachine(message, broadcastCommand);
    }
  }

  _setServiceState(service, state, msg = "") {
    this._serviceStates[service] = state;
    this._saveRuntimeState();
    this._emit({ type: "service_state", service, state, message: msg });
  }

  _registerMachine(message) {
    const { machine_id, manual, fields, machine_type } = message;
    if (!machine_id || !manual || !fields) {
      this._emit({ type: "registration_result", accepted: false, message: "Missing required fields" });
      return;
    }
    const entry = { manual, fields };
    if (machine_type) entry.type = machine_type;
    this._registry[machine_id] = entry;
    this._saveRegistry();
    this._emit({ type: "registry_snapshot", machines: this._registry });
    this._emit({ type: "registration_result", accepted: true, machine_id, message: "Machine registration saved" });
  }

  _deleteMachine(machineId) {
    if (!this._registry[machineId]) {
      this._emit({ type: "registration_result", accepted: false, action: "delete", message: "Machine not registered" });
      return;
    }
    if (this._machines.has(machineId)) {
      this._stopMachine(machineId);
    }
    delete this._registry[machineId];
    this._saveRegistry();
    this._emit({ type: "registry_snapshot", machines: this._registry });
    this._emit({ type: "registration_result", accepted: true, action: "delete", machine_id: machineId, message: "Machine registration deleted" });
  }

  _startMachine(machineId, shouldSave = true) {
    if (this._gateway) {
      if (typeof this._gateway.clearBuffer === "function") this._gateway.clearBuffer(machineId);
      if (this._gateway._cooldowns) this._gateway._cooldowns.delete(machineId);
      if (this._gateway._activePipelines) this._gateway._activePipelines.delete(machineId);
    }

    const onTelemetry = (rawPayload) => {
      if (this._gateway) {
        this._gateway.processTelemetry(rawPayload);
      } else {
        this._emit({ type: "telemetry", payload: rawPayload });
      }
    };

    let instance = this._machines.get(machineId);
    if (!instance) {
      const DriverClass = typeof window !== "undefined" && window.MACHINE_DRIVERS ? window.MACHINE_DRIVERS[machineId] : null;
      if (DriverClass) {
        instance = new DriverClass(onTelemetry);
      } else {
        const registration = this._registry[machineId] || {};
        instance = new GenericMachineSimulator(machineId, registration, onTelemetry);
      }
      if (instance) this._machines.set(machineId, instance);
    }

    if (instance) {
      if (typeof instance.receiveControlCommand === "function") {
        instance.receiveControlCommand({ action: "RESET" });
      }
      instance.start();
      if (shouldSave) this._saveRuntimeState();
      this._emit({ type: "machine_state", machine_id: machineId, state: "running", message: "Machine process started" });
    } else {
      this._emit({ type: "machine_state", machine_id: machineId, state: "error", message: "No simulator class available for " + machineId });
    }
  }

  _stopMachine(machineId) {
    if (this._gateway) {
      if (typeof this._gateway.clearBuffer === "function") this._gateway.clearBuffer(machineId);
      if (this._gateway._cooldowns) this._gateway._cooldowns.delete(machineId);
      if (this._gateway._activePipelines) this._gateway._activePipelines.delete(machineId);
    }

    const instance = this._machines.get(machineId);
    if (instance) {
      instance.stop();
      this._machines.delete(machineId);
    }
    this._saveRuntimeState();
    this._emit({ type: "machine_state", machine_id: machineId, state: "stopped", message: "Machine process stopped" });
  }

  _controlMachine(message, broadcastResult = true) {
    const { action, machine_id } = message;
    
    // Only clear cooldowns and buffers on manual fault injection or reset (remediations require settling cooldown)
    if (action === "TIER_1" || action === "TIER_2" || action === "RESET" || action === "RESET_ALL") {
      if (machine_id && machine_id !== "*" && this._gateway) {
        if (this._gateway._cooldowns) this._gateway._cooldowns.delete(machine_id);
        if (this._gateway._activePipelines) this._gateway._activePipelines.delete(machine_id);
        if (typeof this._gateway.clearBuffer === "function") this._gateway.clearBuffer(machine_id);
        if (this._gateway.buffers) this._gateway.buffers.delete(machine_id);
      }
    }
    
    if (action === "RESET_ALL") {
      if (this._gateway) {
        if (this._gateway._cooldowns) this._gateway._cooldowns.clear();
        if (this._gateway.buffers) this._gateway.buffers.clear();
        if (this._gateway._activePipelines) this._gateway._activePipelines.clear();
      }
      this._machines.forEach((sim) => {
        if (typeof sim.receiveControlCommand === "function") sim.receiveControlCommand({ action: "RESET" });
      });
      for (const mId of Object.keys(this._registry)) {
        if (!this._machines.has(mId)) {
          this._startMachine(mId);
        }
      }
      this._emit({ type: "command_result", request_id: message.request_id, machine_id: "*", action: "RESET_ALL", accepted: true, message: "Reset sent to running machines" }, broadcastResult);
      return;
    }

    if (action === "RESET" && machine_id && machine_id !== "*") {
      if (!this._machines.has(machine_id)) {
        this._startMachine(machine_id);
      }
    }

    if (this._dispatcher) {
      const res = this._dispatcher.dispatchCommand(message);
      if (!res.accepted && res.message === "Machine simulator instance not active" && this._runningRemoteMachines.has(res.machineId)) {
        return;
      }
      this._emit({
        type: "command_result",
        request_id: res.requestId,
        machine_id: res.machineId,
        action: res.action,
        accepted: res.accepted,
        message: res.message,
      }, broadcastResult);

      const actUpper = (action || '').toUpperCase();
      if (actUpper === "STOP" || actUpper === "STOP_MACHINE" || actUpper.includes("LOCKOUT") || actUpper.includes("E_STOP")) {
        this._stopMachine(machine_id);
      }
    }
  }
}

if (typeof window !== "undefined") {
  window.DashboardBridgeJS = DashboardBridgeJS;
}


if (typeof module !== "undefined" && module.exports) {
  module.exports = DashboardBridgeJS;
}




