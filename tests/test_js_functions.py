"""Ejecuta las pruebas JS de las Functions (tests/js/) en Edge/Chrome headless.

Mismos casos compartidos que Python (fixtures/) más los endpoints con un KV en
memoria y la validación del JWT de Access. Se omite si no hay navegador.
Para verlas a mano: python scripts/dev_server.py y abrir http://127.0.0.1:8787/__tests__/
"""

import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

import _path  # noqa: F401
from _server import RunningServer

CANDIDATES = [
    os.environ.get("BROWSER_PATH", ""),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    shutil.which("msedge") or "",
    shutil.which("chrome") or "",
    shutil.which("google-chrome") or "",
    shutil.which("chromium") or "",
]
BROWSER = next((p for p in CANDIDATES if p and Path(p).is_file()), None)
TIMEOUT_S = 90


@unittest.skipUnless(BROWSER, "no se encontró Edge/Chrome (define BROWSER_PATH)")
class JsFunctionsTest(unittest.TestCase):
    def test_js_suite_passes(self):
        srv = RunningServer()
        profile = tempfile.mkdtemp(prefix="segop-js-tests-")
        process = subprocess.Popen(
            [
                BROWSER, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                "--disable-extensions", f"--user-data-dir={profile}", f"{srv.url}/__tests__/index.html",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            results_box = srv.server.RequestHandlerClass.func.js_results
            deadline = time.monotonic() + TIMEOUT_S
            while "last" not in results_box and time.monotonic() < deadline:
                time.sleep(0.25)
            self.assertIn("last", results_box, f"la página de pruebas no reportó resultados en {TIMEOUT_S}s")
            results = results_box["last"]
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
            srv.close()
            shutil.rmtree(profile, ignore_errors=True)

        detail = "\n".join(f"- {f['name']}: {f['error']}" for f in results["failures"])
        self.assertEqual(results["failures"], [], f"fallan pruebas JS:\n{detail}")
        self.assertGreater(results["total"], 40)


if __name__ == "__main__":
    unittest.main()
