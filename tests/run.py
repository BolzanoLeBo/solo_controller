"""Run the browser regression tests with Python and an installed Chrome/Chromium."""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from threading import Thread
import html


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


root = Path(__file__).resolve().parents[1]
browser = next((path for name in ("google-chrome", "chromium", "chromium-browser")
                if (path := shutil.which(name))), None)
if browser is None:
    raise SystemExit("Install Chrome or Chromium to run these tests.")

with ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(root))) as server:
    Thread(target=server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="solo-browser-tests-") as profile:
        result = subprocess.run([
            browser, "--headless", "--disable-gpu", "--no-first-run",
            "--no-default-browser-check", "--disable-background-networking",
            "--disable-dev-shm-usage", f"--user-data-dir={profile}",
            "--dump-dom", "--virtual-time-budget=15000",
            f"http://127.0.0.1:{server.server_port}/tests/",
        ], capture_output=True, text=True, timeout=45)
    server.shutdown()

match = re.search(r'<pre id="results"[^>]*>(.*?)</pre>', result.stdout, re.S)
if match:
    print(html.unescape(match.group(1)))
else:
    print(result.stderr[-4000:])
    print(result.stdout[-2000:])
raise SystemExit(0 if result.returncode == 0 and 'data-status="passed"' in result.stdout else 1)
