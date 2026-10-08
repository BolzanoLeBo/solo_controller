"use strict";

// Run against the actual page and controller, replacing only the Bluetooth API.
const results = parent.document.getElementById("results");
const testResults = [];
const browserErrors = [];
window.addEventListener("error", event => browserErrors.push(event.message));
window.addEventListener("unhandledrejection", event => browserErrors.push(String(event.reason)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(2);
  }
  throw new Error("Timed out waiting for condition; state=" + connectionState);
}
const networkError = () => new DOMException("Simulated link failure", "NetworkError");
const zero = bytes => bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0;
function keyboard(type, key, options = {}) {
  document.body.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, ...options }));
}
function pointer(type, id, key = "z") {
  document.querySelector('[data-key="' + key + '"]').dispatchEvent(
    new PointerEvent(type, { pointerId: id, button: 0, bubbles: true, cancelable: true }));
}

function makeDevice(options = {}) {
  const mock = new EventTarget();
  mock.name = "Test RN4870";
  mock.attempts = 0;
  mock.discoveries = 0;
  mock.writes = [];
  mock.concurrent = 0;
  mock.maxConcurrent = 0;
  mock.writeBehavior = null;
  mock.characteristics = [];
  mock.gatt = {
    connected: false,
    async connect() {
      mock.attempts++;
      if (options.connect) await options.connect(mock);
      mock.gatt.connected = true;
      return mock.gatt;
    },
    disconnect() {
      const connected = mock.gatt.connected;
      mock.gatt.connected = false;
      if (connected) mock.dispatchEvent(new Event("gattserverdisconnected"));
    },
    async getPrimaryService() {
      mock.discoveries++;
      if (options.discover) await options.discover(mock);
      return {
        async getCharacteristic() {
          const characteristic = {
            properties: options.properties || { write: true, writeWithoutResponse: true },
            async writeValueWithResponse(data) { return write(data, "response", characteristic); },
            async writeValueWithoutResponse(data) { return write(data, "no-response", characteristic); }
          };
          mock.characteristics.push(characteristic);
          return characteristic;
        }
      };
    }
  };
  async function write(data, mode, characteristic) {
    const record = { bytes: [...data], mode, characteristic };
    mock.writes.push(record);
    mock.concurrent++;
    mock.maxConcurrent = Math.max(mock.maxConcurrent, mock.concurrent);
    try { if (mock.writeBehavior) await mock.writeBehavior(record); }
    finally { mock.concurrent--; }
  }
  return mock;
}

let selectedDevice;
let chooserCalls = 0;
let choose = async () => selectedDevice;
Object.defineProperty(navigator, "bluetooth", {
  configurable: true,
  value: { requestDevice() { chooserCalls++; return choose(); } }
});
BLE_CONFIG.connectTimeoutMs = 60;
BLE_CONFIG.writeTimeoutMs = 60;
BLE_CONFIG.retryDelaysMs = [5, 5, 5, 5];
BLE_CONFIG.motionIntervalMs = 1000;

async function connectMock(options) {
  selectedDevice = makeDevice(options);
  await connectBle();
  assert(connectionState === "connected", "Expected a ready connection");
  return selectedDevice;
}

const cases = [
  ["packet encoding retains Q0.7 saturation and endings", async () => {
    assert([...buildBinaryMessage(1, -1, 0.5)].join() === "37,127,128,64,37,13", "Incorrect wire format");
    assert(buildBinaryMessage(0, 0, 0, "crlf").length === 7, "CRLF missing");
    assert(buildBinaryMessage(0, 0, 0, "none").length === 5, "Unexpected ending");
    assert(MOTION_LIMITS.vx.positive === 0.6 && MOTION_LIMITS.vy.positive === 0.5, "User limits changed");
  }],
  ["transient first connection failure retries without a second chooser", async () => {
    const before = chooserCalls;
    const mock = await connectMock({ connect: mock => { if (mock.attempts === 1) throw networkError(); } });
    assert(mock.attempts === 2 && chooserCalls === before + 1, "Retry did not reuse selected device");
    assert(mock.writes.length === 1 && zero(mock.writes[0].bytes), "Initial STOP missing");
  }],
  ["transient service discovery failure tears down and retries", async () => {
    const mock = await connectMock({ discover: mock => { if (mock.discoveries === 1) throw networkError(); } });
    assert(mock.attempts === 2 && mock.discoveries === 2, "Discovery was not retried");
  }],
  ["missing UART service fails once with a useful error", async () => {
    selectedDevice = makeDevice({ discover: () => { throw new DOMException("UART absent", "NotFoundError"); } });
    await connectBle();
    assert(selectedDevice.attempts === 1 && !selectedDevice.gatt.connected, "Invalid service kept retrying/connected");
    assert(document.getElementById("status").textContent.includes("UART service discovery"), "Missing failure stage");
  }],
  ["failed connections stop after the retry limit", async () => {
    selectedDevice = makeDevice({ connect: () => { throw networkError(); } });
    await connectBle();
    assert(selectedDevice.attempts === BLE_CONFIG.connectAttempts, "Unbounded retries");
    assert(connectionState === "disconnected" && !wantsConnection, "Connection stuck busy");
  }],
  ["double Connect opens one chooser and Disconnect cancels selection", async () => {
    const selection = deferred();
    choose = () => selection.promise;
    const before = chooserCalls;
    const first = connectBle();
    await connectBle();
    await disconnectBle();
    const mock = makeDevice();
    selection.resolve(mock);
    await first;
    assert(chooserCalls === before + 1 && mock.attempts === 0, "Cancelled chooser connected");
  }],
  ["Disconnect during discovery prevents late setup from enabling controls", async () => {
    const discovery = deferred();
    selectedDevice = makeDevice({ discover: () => discovery.promise });
    const connecting = connectBle();
    await until(() => selectedDevice.discoveries === 1);
    await disconnectBle();
    discovery.resolve();
    await connecting;
    assert(connectionState === "disconnected" && session === null && selectedDevice.writes.length === 0,
      "Late discovery revived connection");
  }],
  ["a stalled connect times out and can be cancelled", async () => {
    const connection = deferred();
    selectedDevice = makeDevice({ connect: () => connection.promise });
    const connecting = connectBle();
    await until(() => logLines.some(line => line.includes("GATT connect timed out")));
    await disconnectBle();
    connection.resolve();
    await connecting;
    await delay(1);
    assert(connectionState === "disconnected" && !selectedDevice.gatt.connected, "Late connect stayed connected");
  }],
  ["late connection to a previous robot is closed without affecting its replacement", async () => {
    const held = deferred();
    const oldDevice = makeDevice({ connect: () => held.promise });
    selectedDevice = oldDevice;
    const first = connectBle();
    await until(() => oldDevice.attempts === 1);
    await disconnectBle();
    const replacement = await connectMock();
    held.resolve();
    await first;
    await delay(1);
    assert(!oldDevice.gatt.connected && replacement.gatt.connected && device === replacement,
      "Late connection affected replacement or stayed connected");
  }],
  ["controls remain disabled until the initial STOP succeeds", async () => {
    const held = deferred();
    selectedDevice = makeDevice();
    selectedDevice.writeBehavior = () => held.promise;
    const connecting = connectBle();
    await until(() => selectedDevice.writes.length === 1);
    keyboard("keydown", "z");
    assert(activeKeys.size === 0 && document.querySelector('[data-key="z"]').disabled,
      "Controls enabled before write path verified");
    held.resolve();
    await connecting;
    assert(connectionState === "connected", "Initial STOP did not enable controls");
  }],
  ["slow writes coalesce movement and STOP overtakes pending commands", async () => {
    const mock = await connectMock();
    const held = deferred();
    mock.writeBehavior = () => held.promise;
    const first = sendRawBuffer(buildBinaryMessage(0.1, 0, 0));
    const stale = sendRawBuffer(buildBinaryMessage(0.2, 0, 0));
    const latest = sendRawBuffer(buildBinaryMessage(0.3, 0, 0));
    const stopped = stopRobot();
    assert(await stale === false && await latest === false, "Old movement was not discarded");
    mock.writeBehavior = null;
    held.resolve();
    assert(await first && await stopped, "Writes did not settle truthfully");
    assert(mock.writes.length === 3 && zero(mock.writes[2].bytes), "STOP delayed behind movement");
    assert(mock.maxConcurrent === 1, "Overlapping GATT writes");
  }],
  ["drop discards held inputs and pending writes; reconnect obtains fresh characteristic", async () => {
    const mock = await connectMock();
    const held = deferred();
    mock.writeBehavior = () => held.promise;
    keyboard("keydown", "z");
    const oldSession = session;
    const stale = sendRawBuffer(buildBinaryMessage(0.5, 0, 0));
    mock.gatt.disconnect();
    assert(await stale === false && activeKeys.size === 0, "Stale command or input survived");
    mock.writeBehavior = null;
    held.resolve();
    await until(() => connectionState === "connected");
    assert(session !== oldSession && mock.characteristics.length === 2, "Reused invalid characteristic");
    assert(zero(mock.writes.at(-1).bytes) && !motionLoopRunning, "Motion resumed on reconnect");
    keyboard("keydown", "z", { repeat: true });
    assert(activeKeys.size === 0, "Held keyboard key resumed motion");
  }],
  ["write error reconnects without replaying failed movement", async () => {
    const mock = await connectMock();
    mock.writeBehavior = () => { throw networkError(); };
    assert(await sendRawBuffer(buildBinaryMessage(0.5, 0, 0)) === false, "Failed write reported success");
    mock.writeBehavior = null;
    await until(() => connectionState === "connected");
    assert(mock.writes.length === 3 && zero(mock.writes.at(-1).bytes), "Failed movement replayed");
  }],
  ["hung write times out and its late completion cannot update a new session", async () => {
    const mock = await connectMock();
    const held = deferred();
    mock.writeBehavior = () => held.promise;
    const sending = sendRawBuffer(buildBinaryMessage(0.5, 0, 0));
    assert(await sending === false, "Timed-out write reported success");
    mock.writeBehavior = null;
    await until(() => connectionState === "connected");
    const result = document.getElementById("lastResult").textContent;
    held.resolve();
    await delay(1);
    assert(document.getElementById("lastResult").textContent === result, "Old write changed new session");
  }],
  ["Disconnect cancels automatic reconnect", async () => {
    const mock = await connectMock();
    mock.gatt.disconnect();
    await disconnectBle();
    await delay(15);
    assert(mock.attempts === 1 && connectionState === "disconnected", "Reconnect survived cancellation");
  }],
  ["automatic reconnect stops after its retry budget", async () => {
    const mock = await connectMock({ connect: mock => { if (mock.attempts > 1) throw networkError(); } });
    mock.gatt.disconnect();
    await until(() => connectionState === "disconnected");
    assert(mock.attempts === 1 + BLE_CONFIG.reconnectAttempts && !wantsConnection,
      "Automatic reconnect exceeded its budget");
  }],
  ["intentional Disconnect writes STOP and does not reconnect", async () => {
    const mock = await connectMock();
    await testBinaryCommand(0.3, 0, 0);
    await disconnectBle();
    await delay(15);
    assert(zero(mock.writes.at(-1).bytes) && mock.attempts === 1, "Disconnect failed to stop/cancel retries");
  }],
  ["keyboard repeat and editable fields do not create movement writes", async () => {
    const mock = await connectMock();
    document.getElementById("manualInput").dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true }));
    assert(mock.writes.length === 1, "Typing moved robot");
    keyboard("keydown", "z");
    keyboard("keydown", "z", { repeat: true });
    await delay(1);
    assert(mock.writes.length === 2, "Key repeat added writes");
    assert(mock.writes[1].bytes[1] === 13, "Initial acceleration step changed");
    keyboard("keyup", "z");
    await until(() => zero(mock.writes.at(-1).bytes));
  }],
  ["keyboard and pointer holds are independent and duplicate releases ignored", async () => {
    const mock = await connectMock();
    keyboard("keydown", "z");
    pointer("pointerdown", 42);
    pointer("pointerup", 42);
    assert(activeKeys.has("z"), "Pointer release cleared keyboard hold");
    keyboard("keyup", "z");
    await until(() => zero(mock.writes.at(-1).bytes));
    const count = mock.writes.length;
    pointer("lostpointercapture", 42);
    await delay(1);
    assert(mock.writes.length === count, "Duplicate release sent another STOP");
  }],
  ["focus loss clears movement and writes STOP", async () => {
    const mock = await connectMock();
    keyboard("keydown", "z");
    window.dispatchEvent(new Event("blur"));
    await until(() => zero(mock.writes.at(-1).bytes));
    assert(activeKeys.size === 0 && !motionLoopRunning, "Focus loss left motion running");
  }],
  ["hidden page stops and becoming visible does not resume movement", async () => {
    const mock = await connectMock();
    keyboard("keydown", "z");
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await until(() => zero(mock.writes.at(-1).bytes));
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
    assert(activeKeys.size === 0 && !motionLoopRunning, "Visibility restored stale movement");
  }],
  ["manual input rejects blanks, Infinity and out-of-range values", async () => {
    const mock = await connectMock();
    for (const input of ["0,,0", "Infinity,0,0", "1.1,0,0", "-1.1,0,0", "0,0,NaN"]) {
      document.getElementById("manualInput").value = input;
      assert(await sendManualBinary() === false, "Accepted " + input);
    }
    assert(mock.writes.length === 1, "Invalid manual input sent data");
    document.getElementById("manualInput").value = "0,0.5,-1";
    assert(await sendManualBinary() === true, "Valid manual command rejected");
  }],
  ["write mode checks properties and STOP uses a supported mode", async () => {
    const mock = await connectMock({ properties: { write: false, writeWithoutResponse: true } });
    assert(mock.writes[0].mode === "no-response", "Auto chose unsupported write method");
    document.getElementById("writeModeSelect").value = "withResponse";
    assert(await sendRawBuffer(buildBinaryMessage(0.1, 0, 0)) === false, "Unsupported write attempted");
    assert(connectionState === "connected", "Unsupported selection caused reconnect loop");
    assert(await stopRobot() === true && mock.writes.at(-1).mode === "no-response", "STOP blocked by selection");
  }],
  ["changing write mode stops held movement", async () => {
    const mock = await connectMock();
    keyboard("keydown", "z");
    const select = document.getElementById("writeModeSelect");
    select.value = "withoutResponse";
    select.dispatchEvent(new Event("change"));
    await until(() => zero(mock.writes.at(-1).bytes));
    assert(activeKeys.size === 0 && !motionLoopRunning, "Write mode change retained movement");
  }]
];

(async () => {
  let failures = 0;
  for (const [name, run] of cases) {
    try {
      choose = async () => selectedDevice;
      document.getElementById("writeModeSelect").value = "auto";
      await run();
      testResults.push("PASS " + name);
    } catch (error) {
      failures++;
      testResults.push("FAIL " + name + ": " + error.stack);
    } finally {
      delete document.hidden;
      await disconnectBle();
    }
    results.textContent = testResults.join("\n");
  }
  results.textContent += "\n" + (cases.length - failures) + "/" + cases.length + " passed";
  if (browserErrors.length) results.textContent += "\nBrowser errors: " + browserErrors.join("\n");
  results.dataset.status = failures || browserErrors.length ? "failed" : "passed";
})();
