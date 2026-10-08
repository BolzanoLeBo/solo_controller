"use strict";

const SERVICE_UUID = "49535343-fe7d-4ae5-8fa9-9fafd205e455";
const RX_UUID = "49535343-8841-43f4-a8d4-ecbe34729bb3";
const BLE_CONFIG = {
  motionIntervalMs: 50,
  connectTimeoutMs: 10000,
  writeTimeoutMs: 1500,
  retryDelaysMs: [500, 1000, 2000, 4000],
  connectAttempts: 3,
  reconnectAttempts: 5
};

let device = null;
let rxChar = null;
let connectionState = "disconnected";
let connectionJob = null;
let session = null;
let wantsConnection = false;
const activeKeys = new Set();
const keyboardKeys = new Set();
const pointerKeys = new Map();
const motionKeys = new Set(["z", "s", "q", "d", "a", "e"]);
let sendTimer = null;
let motionLoopId = 0;
let motionLoopRunning = false;
let writeCount = 0;
let lastMotionLogAt = -Infinity;
let logLines = [];

const MOTION_RAMP_STEP = 0.1;
let currentMotion = { vx: 0, vy: 0, wz: 0 };

const MOTION_LIMITS = {
  vx: { negative: -0.6, positive: 0.6 },
  vy: { negative: -0.5, positive: 0.5 },
  wz: { negative: -0.9, positive: 0.9 }
};

function axis(neg, pos, limits) {
  if (neg && !pos) return limits.negative;
  if (pos && !neg) return limits.positive;
  return 0;
}

function getTargetMotion() {
  return {
    // Forward/backward use X, left/right use Y, and rotation uses Z.
    vx: axis(activeKeys.has("s"), activeKeys.has("z"), MOTION_LIMITS.vx),
    vy: axis(activeKeys.has("q"), activeKeys.has("d"), MOTION_LIMITS.vy),
    wz: axis(activeKeys.has("a"), activeKeys.has("e"), MOTION_LIMITS.wz)
  };
}

function rampAxis(current, target) {
  // Stopping is immediate; acceleration toward an active command is gradual.
  if (target === 0) return 0;

  const difference = target - current;
  if (Math.abs(difference) <= MOTION_RAMP_STEP) return target;

  // Round to avoid values such as 0.30000000000000004 in the motion state.
  return Number((current + Math.sign(difference) * MOTION_RAMP_STEP).toFixed(3));
}

function updateCurrentMotion() {
  const target = getTargetMotion();
  currentMotion.vx = rampAxis(currentMotion.vx, target.vx);
  currentMotion.vy = rampAxis(currentMotion.vy, target.vy);
  currentMotion.wz = rampAxis(currentMotion.wz, target.wz);
}

function stopInactiveAxes() {
  const target = getTargetMotion();
  if (target.vx === 0) currentMotion.vx = 0;
  if (target.vy === 0) currentMotion.vy = 0;
  if (target.wz === 0) currentMotion.wz = 0;
}

function resetCurrentMotion() {
  currentMotion.vx = 0;
  currentMotion.vy = 0;
  currentMotion.wz = 0;
}

function setStatus(text) {
  document.getElementById("status").textContent = text;
}

function displayBuffer(buffer) {
  return Array.from(buffer).map(b => '0x' + b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function updateKeyDebug() {
  document.getElementById("keys").textContent =
    "Keys: " + Array.from(activeKeys).join(",");
  for (const button of document.querySelectorAll("[data-key]")) {
    button.classList.toggle("active", activeKeys.has(button.dataset.key));
  }
}

function updateTxDebug(buffer) {
  if (typeof buffer === "string") {
    document.getElementById("tx").textContent = "TX: " + buffer;
  } else {
    document.getElementById("tx").textContent = "TX (Hex): " + displayBuffer(buffer);
  }
}

function updateLastResult(text) {
  document.getElementById("lastResult").textContent = "Last write: " + text;
}

function updateProps() {
  if (!rxChar) {
    document.getElementById("props").textContent = "RX properties: unknown";
    return;
  }
  const p = rxChar.properties;
  const text = "write=" + p.write + ", writeWithoutResponse=" + p.writeWithoutResponse + ", notify=" + p.notify + ", read=" + p.read;
  document.getElementById("props").textContent = "RX properties: " + text;
  addLog("RX characteristic properties: " + text);
}

function addLog(text) {
  const stamp = new Date().toLocaleTimeString();
  logLines.unshift(stamp + "  " + text);
  logLines = logLines.slice(0, 60);
  document.getElementById("sendLog").textContent = logLines.join("\n");
}


// Convertit un flottant (-1.0 à 1.0) vers un octet au format fixe Q0.7
function floatToQ07(value) {
  // Multiplication par 2^7 (128)
  let qValue = Math.round(value * 128);

  // Saturation des limites matérielles Q0.7 (-128 à 127)
  if (qValue > 127) qValue = 127;
  if (qValue < -128) qValue = -128;

  // Transformation en un octet non signé propre pour Uint8Array
  return qValue & 0xFF;
}

function buildBinaryMessage(vx, vy, wz, endingType = "cr") {
  let endingBytes = [];
  if (endingType === "cr") endingBytes = [13];       // \r
  if (endingType === "lf") endingBytes = [10];       // \n
  if (endingType === "crlf") endingBytes = [13, 10];  // \r\n

  // Total length is exactly 5 bytes for payload data plus ending character lengths
  const totalLength = 5 + endingBytes.length;
  const buffer = new Uint8Array(totalLength);

  let index = 0;
  buffer[index++] = 37; // '%'

  buffer[index++] = floatToQ07(vx); // X en Q0.7 (ex: 1.0 -> 0x7F, -1.0 -> 0x80)
  buffer[index++] = floatToQ07(vy); // Y en Q0.7
  buffer[index++] = floatToQ07(wz); // Z en Q0.7

  buffer[index++] = 37; // '%'

  for (let b of endingBytes) {
    buffer[index++] = b;
  }

  return buffer;
}

function getMotionMessageBuffer() {
  return buildBinaryMessage(currentMotion.vx, currentMotion.vy, currentMotion.wz, "cr");
}

function setConnectionState(state, message) {
  connectionState = state;
  setStatus(message);
  document.getElementById("connectButton").disabled = state !== "disconnected";
  document.getElementById("disconnectButton").disabled =
    state === "disconnected" || state === "disconnecting";
  for (const button of document.querySelectorAll("[data-key], [data-requires-connection]")) {
    button.disabled = state !== "connected";
  }
}

function canControl() {
  return connectionState === "connected" && session !== null &&
    device?.gatt?.connected && !document.hidden;
}

function errorText(error) {
  return (error.name || "Error") + ": " + error.message;
}

// A deadline releases our queue even if the browser never settles a GATT promise.
// The caller must disconnect on timeout: racing a promise does not cancel BLE I/O.
function withDeadline(operation, milliseconds, signal, label) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (callback, value) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, new DOMException("Operation cancelled", "AbortError"));
    Promise.resolve(operation).then(
      value => finish(resolve, value),
      error => finish(reject, error)
    );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(reject,
      new DOMException(label + " timed out", "TimeoutError")), milliseconds);
  });
}

function retryDelay(milliseconds, signal) {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

function jobIsCurrent(job) {
  return connectionJob === job && wantsConnection && !job.signal.aborted;
}

function disconnectGatt(target = device) {
  // Also abort a pending connect, even when connected is still false.
  try { target?.gatt?.disconnect(); }
  catch (error) { addLog("disconnect: " + errorText(error)); }
}

async function connectBle() {
  if (connectionState !== "disconnected") return;
  if (!window.isSecureContext || !navigator.bluetooth) {
    setStatus("Web Bluetooth requires HTTPS (or localhost) and a supported browser");
    return;
  }
  const job = new AbortController();
  connectionJob = job;
  wantsConnection = true;
  setConnectionState("scanning", "Select the robot...");
  try {
    // Keep the chooser broad: RN4870 names/advertised services are configurable.
    const selected = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [SERVICE_UUID]
    });
    if (!jobIsCurrent(job)) return;
    device?.removeEventListener("gattserverdisconnected", onDisconnected);
    device = selected;
    device.addEventListener("gattserverdisconnected", onDisconnected);
    await establishConnection(job, false);
  } catch (error) {
    if (!jobIsCurrent(job)) return;
    wantsConnection = false;
    setConnectionState("disconnected", "Connection cancelled or failed: " + errorText(error));
    addLog("device selection: " + errorText(error));
  } finally {
    if (connectionJob === job) connectionJob = null;
  }
}

async function establishConnection(job, reconnecting) {
  const target = device;
  const attempts = reconnecting ? BLE_CONFIG.reconnectAttempts : BLE_CONFIG.connectAttempts;
  for (let attempt = 1; attempt <= attempts && jobIsCurrent(job); attempt++) {
    let stage = "GATT connect";
    setConnectionState(reconnecting ? "reconnecting" : "connecting",
      (reconnecting ? "Reconnecting" : "Connecting") + " (" + attempt + "/" + attempts + ")...");
    try {
      const pendingConnect = target.gatt.connect();
      // A cancelled chooser/connect must not quietly leave the radio connected.
      pendingConnect.then(() => {
        if (!wantsConnection || device !== target) disconnectGatt(target);
      }, () => {});
      const server = await withDeadline(pendingConnect,
        BLE_CONFIG.connectTimeoutMs, job.signal, stage);
      if (!jobIsCurrent(job)) return;
      stage = "UART service discovery";
      const service = await withDeadline(server.getPrimaryService(SERVICE_UUID),
        BLE_CONFIG.connectTimeoutMs, job.signal, stage);
      if (!jobIsCurrent(job)) return;
      stage = "RX characteristic discovery";
      const characteristic = await withDeadline(service.getCharacteristic(RX_UUID),
        BLE_CONFIG.connectTimeoutMs, job.signal, stage);
      if (!jobIsCurrent(job)) return;
      // Verify the write path and clear any old robot command before enabling inputs.
      stage = "initial STOP write";
      const method = getWriteMethod(characteristic, "auto");
      await withDeadline(characteristic[method](buildBinaryMessage(0, 0, 0)),
        BLE_CONFIG.writeTimeoutMs, job.signal, stage);
      if (!jobIsCurrent(job)) return;
      if (!target.gatt.connected) throw new DOMException("Link lost during setup", "NetworkError");
      clearInputs();
      rxChar = characteristic;
      session = {
        characteristic, controller: new AbortController(), writing: false,
        pending: null, pendingStop: null, inFlight: null
      };
      updateProps();
      updateTxDebug(buildBinaryMessage(0, 0, 0));
      updateLastResult("initial STOP written via " + method);
      setConnectionState("connected", "Connected to " + (target.name || "BLE device") + " — ready");
      addLog("connected on attempt " + attempt + "; initial STOP written; controls reset");
      return;
    } catch (error) {
      if (!jobIsCurrent(job)) return;
      disconnectGatt(target);
      addLog(stage + " failed (" + attempt + "/" + attempts + "): " + errorText(error));
      // A missing UART service or unsupported write method needs configuration changes.
      const permanent = ["NotFoundError", "NotSupportedError", "SecurityError"].includes(error.name);
      if (attempt === attempts || permanent) {
        wantsConnection = false;
        setConnectionState("disconnected", stage + " failed: " + errorText(error) + ". Press Connect to retry.");
        return;
      }
      const delay = BLE_CONFIG.retryDelaysMs[Math.min(attempt - 1, BLE_CONFIG.retryDelaysMs.length - 1)];
      setStatus("Connection failed; retrying in " + delay + " ms (" + stage + ")...");
      await retryDelay(delay, job.signal);
    }
  }
}

function discardSession() {
  const previous = session;
  session = null;
  rxChar = null;
  if (previous) {
    previous.controller.abort();
    previous.pending?.resolve(false);
    previous.pendingStop?.resolve(false);
    previous.inFlight?.resolve(false);
    previous.pending = previous.pendingStop = null;
  }
  clearInputs();
  updateProps();
  updateTxDebug("waiting");
}

function recoverConnection(reason) {
  if (connectionState !== "connected") return;
  discardSession();
  setConnectionState("reconnecting", "Connection lost — controls reset");
  addLog(reason + "; discarded pending commands");
  disconnectGatt();
  if (!wantsConnection) return;
  const job = new AbortController();
  connectionJob = job;
  // Give the OS and RN4870 time to finish tearing down the old link.
  (async () => {
    await retryDelay(BLE_CONFIG.retryDelaysMs[0], job.signal);
    if (jobIsCurrent(job)) await establishConnection(job, true);
  })().finally(() => {
    if (connectionJob === job) connectionJob = null;
  });
}

function onDisconnected(event) {
  // Ignore delayed events for an old device or a link already re-established.
  if (event.target !== device || device.gatt.connected) return;
  if (connectionState === "connected") recoverConnection("GATT disconnected");
}

async function disconnectBle() {
  if (connectionState === "disconnecting") return;
  wantsConnection = false;
  connectionJob?.abort();
  connectionJob = null;
  clearInputs();
  setConnectionState("disconnecting", "Stopping and disconnecting...");
  if (session && device?.gatt?.connected) {
    await sendRawBuffer(buildBinaryMessage(0, 0, 0), { stop: true, source: "disconnect STOP" });
  }
  discardSession();
  disconnectGatt();
  setConnectionState("disconnected", "Disconnected");
  addLog("disconnected by user");
}

function getWriteMethod(characteristic, mode) {
  const p = characteristic.properties;
  if ((mode === "auto" || mode === "withResponse") && p.write &&
      typeof characteristic.writeValueWithResponse === "function") return "writeValueWithResponse";
  if ((mode === "auto" || mode === "withoutResponse") && p.writeWithoutResponse &&
      typeof characteristic.writeValueWithoutResponse === "function") return "writeValueWithoutResponse";
  if (((mode === "auto" || mode === "legacy") && (p.write || p.writeWithoutResponse) ||
      mode === "withResponse" && p.write) && typeof characteristic.writeValue === "function") return "writeValue";
  throw new DOMException("Selected write mode is not supported by this characteristic", "NotSupportedError");
}

function sendRawBuffer(buffer, { stop = false, source = "motion" } = {}) {
  const current = session;
  if (!current || !device?.gatt?.connected ||
      (connectionState !== "connected" && !(stop && connectionState === "disconnecting"))) {
    if (connectionState === "connected") recoverConnection("GATT link unavailable");
    return Promise.resolve(false);
  }
  let method;
  try {
    method = getWriteMethod(current.characteristic,
      stop ? "auto" : document.getElementById("writeModeSelect").value);
  } catch (error) {
    updateLastResult(errorText(error));
    addLog(errorText(error));
    // Invalid write selections must not leave a motion loop repeatedly failing.
    if (!stop) stopRobot();
    return Promise.resolve(false);
  }
  return new Promise(resolve => {
    const item = { buffer: buffer.slice(), method, source, resolve };
    if (stop) {
      current.pending?.resolve(false);
      current.pending = null;
      // Duplicate release/STOP events share the same queued STOP.
      if (current.pendingStop) {
        const previousResolve = current.pendingStop.resolve;
        current.pendingStop.resolve = result => { previousResolve(result); resolve(result); };
      } else {
        current.pendingStop = item;
      }
    } else {
      // Only the latest unsent command matters. Never replay a movement backlog.
      current.pending?.resolve(false);
      current.pending = item;
    }
    drainWrites(current);
  });
}

async function drainWrites(current) {
  if (current.writing) return;
  current.writing = true;
  try {
    while (session === current && (current.pendingStop || current.pending)) {
      const item = current.pendingStop || current.pending;
      if (current.pendingStop) current.pendingStop = null;
      else current.pending = null;
      current.inFlight = item;
      try {
        await withDeadline(current.characteristic[item.method](item.buffer),
          BLE_CONFIG.writeTimeoutMs, current.controller.signal, "GATT write");
        if (session !== current) { item.resolve(false); return; }
        writeCount++;
        updateTxDebug(item.buffer);
        updateLastResult("#" + writeCount + " OK via " + item.method);
        // Keep failures/reconnects visible instead of replacing the log at 20 Hz.
        if (item.source !== "motion" || performance.now() - lastMotionLogAt >= 1000) {
          addLog(item.source + " #" + writeCount + " [" + displayBuffer(item.buffer) + "]");
          lastMotionLogAt = performance.now();
        }
        item.resolve(true);
      } catch (error) {
        item.resolve(false);
        if (session !== current) return;
        updateLastResult("ERROR: " + errorText(error));
        addLog("write failed: " + errorText(error));
        if (connectionState === "disconnecting") {
          discardSession();
          disconnectGatt();
        } else {
          recoverConnection("Write failed: " + errorText(error));
        }
        return;
      } finally {
        current.inFlight = null;
      }
    }
  } finally {
    current.writing = false;
  }
}

function stopMotionLoop() {
  motionLoopId++;
  motionLoopRunning = false;
  clearTimeout(sendTimer);
  sendTimer = null;
}

function startMotionLoop() {
  if (motionLoopRunning || !canControl()) return;
  motionLoopRunning = true;
  const id = ++motionLoopId;
  const tick = async () => {
    if (id !== motionLoopId || !canControl() || activeKeys.size === 0) return;
    const startedAt = performance.now();
    updateCurrentMotion();
    await sendRawBuffer(getMotionMessageBuffer());
    if (id !== motionLoopId) return;
    // Wait for each write; slow links reduce the rate instead of accumulating work.
    sendTimer = setTimeout(tick, Math.max(0,
      BLE_CONFIG.motionIntervalMs - (performance.now() - startedAt)));
  };
  tick();
}

function clearInputs() {
  stopMotionLoop();
  keyboardKeys.clear();
  pointerKeys.clear();
  activeKeys.clear();
  resetCurrentMotion();
  updateKeyDebug();
}

function stopRobot() {
  clearInputs();
  return sendRawBuffer(buildBinaryMessage(0, 0, 0), { stop: true, source: "STOP" });
}

function inputsChanged() {
  const previous = [...activeKeys].sort().join("");
  activeKeys.clear();
  for (const key of keyboardKeys) activeKeys.add(key);
  for (const key of pointerKeys.values()) activeKeys.add(key);
  if ([...activeKeys].sort().join("") === previous) return;
  stopInactiveAxes();
  updateKeyDebug();
  if (activeKeys.size === 0) {
    stopRobot();
  } else if (!motionLoopRunning) {
    startMotionLoop();
  } else {
    sendRawBuffer(getMotionMessageBuffer());
  }
}

function sendManualBinary() {
  if (!canControl()) return Promise.resolve(false);
  const fields = document.getElementById("manualInput").value.trim().split(",");
  const values = fields.map(Number);
  if (fields.length !== 3 || fields.some(field => !field.trim()) ||
      values.some(value => !Number.isFinite(value) || value < -1 || value > 1)) {
    updateLastResult("Enter exactly 3 finite numbers between -1 and 1, separated by commas");
    return Promise.resolve(false);
  }
  return sendTestCommand(values, document.getElementById("endingSelect").value);
}

function testBinaryCommand(vx, vy, wz) {
  return sendTestCommand([vx, vy, wz], "cr");
}

function sendTestCommand(values, ending) {
  if (!canControl()) return Promise.resolve(false);
  clearInputs();
  return sendRawBuffer(buildBinaryMessage(...values, ending), {
    stop: values.every(value => value === 0), source: "manual"
  });
}

for (const button of document.querySelectorAll("[data-key]")) {
  button.addEventListener("pointerdown", event => {
    event.preventDefault();
    if (!canControl() || event.button !== 0) return;
    try { button.setPointerCapture(event.pointerId); } catch (_) {}
    pointerKeys.set(event.pointerId, button.dataset.key);
    inputsChanged();
  });
  const release = event => {
    event.preventDefault();
    if (!pointerKeys.delete(event.pointerId)) return;
    inputsChanged();
  };
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("lostpointercapture", release);
}

window.addEventListener("keydown", event => {
  const key = event.key.toLowerCase();
  if (!motionKeys.has(key) || event.repeat || event.ctrlKey || event.altKey || event.metaKey ||
      event.target.closest?.("input, textarea, select, [contenteditable]") || !canControl()) return;
  event.preventDefault();
  keyboardKeys.add(key);
  inputsChanged();
});

window.addEventListener("keyup", event => {
  if (keyboardKeys.delete(event.key.toLowerCase())) {
    event.preventDefault();
    inputsChanged();
  }
});

document.getElementById("manualInput").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.repeat) sendManualBinary();
});

document.getElementById("writeModeSelect").addEventListener("change", stopRobot);

// Browsers can throttle/freeze hidden tabs. Drop all inputs and never resume them.
window.addEventListener("blur", stopRobot);
window.addEventListener("pagehide", stopRobot);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopRobot();
});

setConnectionState("disconnected", "Disconnected");
