"""GET /api/health identifies this engine (and this launch of it).

Run from python-sidecar/:  python -m unittest discover -s tests
(needs the engine's requirements; fastapi's TestClient needs httpx).
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import api_server  # noqa: E402

try:
    from fastapi.testclient import TestClient
except Exception:  # noqa: BLE001  (httpx missing)
    TestClient = None


class HealthPayload(unittest.TestCase):
    def test_with_token(self):
        self.assertEqual(
            api_server.health_payload("t0k"),
            {"status": "ok", "app": "lab-analysis-suite", "token": "t0k"},
        )

    def test_dev_engine_without_token(self):
        self.assertEqual(api_server.health_payload(None), {"status": "ok", "app": "lab-analysis-suite"})
        self.assertEqual(api_server.health_payload(""), {"status": "ok", "app": "lab-analysis-suite"})

    def test_token_taken_from_env_and_removed(self):
        os.environ[api_server.ENV_ENGINE_TOKEN] = "secret-launch-token"
        self.assertEqual(api_server.take_engine_token_from_env(), "secret-launch-token")
        self.assertNotIn(api_server.ENV_ENGINE_TOKEN, os.environ)  # not inherited by R
        self.assertIsNone(api_server.take_engine_token_from_env())


@unittest.skipIf(TestClient is None, "fastapi TestClient unavailable")
class HealthEndpoint(unittest.TestCase):
    def tearDown(self):
        api_server.set_engine_token(None)

    def test_endpoint_with_token(self):
        api_server.set_engine_token("abc")
        r = TestClient(api_server.app).get("/api/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"status": "ok", "app": "lab-analysis-suite", "token": "abc"})

    def test_endpoint_without_token(self):
        api_server.set_engine_token(None)
        r = TestClient(api_server.app).get("/api/health")
        self.assertEqual(r.json(), {"status": "ok", "app": "lab-analysis-suite"})

    def test_health_runs_on_the_event_loop(self):
        # Not in the worker thread pool: it must answer while long R calls
        # occupy every worker (the app restarts an engine that stops answering).
        import inspect
        self.assertTrue(inspect.iscoroutinefunction(api_server.health))

    def test_package_check_route_exists(self):
        # The route another app's engine lacked (404) — this engine has it.
        paths = {getattr(rt, "path", "") for rt in api_server.app.routes}
        self.assertIn("/api/analysis/check-packages", paths)
        self.assertIn("/api/analysis/check-r", paths)


if __name__ == "__main__":
    unittest.main()
