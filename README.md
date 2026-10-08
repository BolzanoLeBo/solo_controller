# SOLO12 BLE controller

Static Web Bluetooth controller for an RN4870 Transparent UART connection.
Serve `index.html` **and** `controller.js` over HTTPS, or use localhost for development:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open `http://localhost:8000` in a browser/OS combination that supports Web Bluetooth.
Press **Connect** and select the robot. The chooser intentionally allows all names
because the RN4870's advertised name and services can be configured.

## Connection and control behavior

- Initial setup retries transient errors up to 3 times. Unexpected disconnects or
  write failures trigger up to 5 reconnect attempts using the selected device.
  Retries wait 0.5, 1, 2, then 4 seconds; automatic recovery also waits 0.5 seconds
  before its first attempt. **Disconnect** cancels retries.
- Each connection discovers the UART service/characteristic again and writes STOP
  before enabling the controls. Reconnecting clears held inputs and pending data;
  movement requires a fresh press. Missing services or unsupported characteristics
  fail immediately with the setup stage shown in the log.
- GATT setup operations have 10-second deadlines; writes have 1.5-second deadlines.
  A timeout tears down the link. A late result cannot restore old control state.
- Motion runs at up to 20 Hz, waiting for each write before scheduling the next
  tick. There is at most one write in flight and one pending movement command.
  New commands replace unsent movement; STOP discards it and goes next. A write
  already in flight cannot be recalled.
- STOP, focus loss, page hiding, and pointer/key release clear the appropriate
  input state. Intentional disconnect attempts STOP before closing the link.
  Keyboard auto-repeat is ignored, and typing in form fields cannot move the robot.
- Auto write mode prefers writes with response, checks the characteristic's
  properties, and falls back to a supported method. STOP always uses Auto.
  A successful GATT write is not an acknowledgement from the robot's motor controller.
- Manual/test commands are single writes and cancel held controls. Manual values
  must be three finite numbers in `[-1, 1]`. The forward test uses the configured
  forward speed limit. Routine motion logs are sampled once per second.

Timing constants and motion limits are at the top of `controller.js`. Current
directional limits are X ±0.6, Y ±0.5, rotation ±0.9; acceleration remains 0.1 per
motion tick. Stopping an inactive axis remains immediate.

## Robot firmware requirement

The browser **cannot transmit STOP after the radio link has been lost**, and it may
be suspended when a tab is hidden or closed. The robot firmware must stop motion
when valid commands stop arriving. Choose and verify a watchdog timeout against
the robot's stopping requirements and measured command intervals. This repository
contains no robot firmware, so that behavior cannot be implemented or verified here.
Manual/test commands are not repeated and will expire under such a watchdog.

The existing packet format is unchanged: `%[X][Y][Z]%\r`, where X/Y/Z are single
signed Q0.7 bytes (clamped to -128…127). UART parsing must consume the fixed-length
binary payload: payload bytes can equal `%`, CR, LF, or NUL. For example, 0.1
encodes as `0x0D` (CR). Splitting every packet on CR or `%` would corrupt valid
commands. The receiving parser is not present in this repository.

## Diagnostics and verification

The browser log now retains setup stages, error names, retry numbers, and write
failures. If real-device drops continue, save that log along with the browser/OS,
RN4870 firmware/configuration, and any UART reset/disconnect messages. The browser
code alone cannot establish whether the cause is the radio, power, UART, or host stack.

The service/RX UUIDs match [Microchip's Transparent UART specification](https://developerhelp.microchip.com/xwiki/bin/view/applications/ble/android-development-for-bm70rn4870/transparent-uart-service-for-bm70rn4870/).
Re-discovery and serialized operations follow [Chrome's Web Bluetooth guidance](https://developer.chrome.com/docs/capabilities/bluetooth).
For UART streaming, also review [Microchip's hardware flow-control guidance](https://onlinedocs.microchip.com/oxy/GUID-1B991CE9-4FE3-48B8-BC90-28F5F29AD994-en-US-1/GUID-D0CF7DB7-C216-4121-9BED-526F6D2D641F.html).

Run the regression tests with Python 3 and Chrome/Chromium installed:

```sh
python3 tests/run.py
```

Or open `/tests/` using the local server above. Tests load the real controller page
and replace Bluetooth with a mock. They cover connection retries/cancellation,
slow and hung writes, STOP priority, stale-session isolation, input handling, and
packet encoding. They do not validate radio behavior or actual robot stopping.
