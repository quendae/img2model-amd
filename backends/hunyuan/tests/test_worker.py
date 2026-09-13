import contextlib
import io
import json
import sys
from unittest import mock

import worker_tests_base as base_worker_tests


class WorkerProtocolTests(base_worker_tests.WorkerProtocolTests):
    """Legacy worker regression suite with protocol-v2 expectation."""

    def test_serve_ping_returns_same_job_id(self) -> None:
        module = self.load_worker_module()
        replies: list[dict[str, object]] = []
        keep_running = module.dispatch_serve_command(
            {"command": "ping", "job_id": "job-1"},
            cache=module.PipelineCache(),
            emit_fn=replies.append,
        )
        self.assertTrue(keep_running)
        self.assertEqual(replies[-1]["job_id"], "job-1")
        self.assertEqual(replies[-1]["event"], "pong")
        self.assertEqual(replies[-1]["protocol_version"], 2)

    def test_serve_keeps_third_party_prints_off_json_stdout(self) -> None:
        module = self.load_worker_module()
        stdin = io.StringIO(json.dumps({"command": "shape", "job_id": "job-noisy", "request": {}}) + "\n")
        stdout = io.StringIO()
        stderr = io.StringIO()

        def noisy_dispatch(message, *, cache, emit_fn=None):
            print("PointCrossAttentionEncoder INFO: pc_sharpedge_size is given")
            payload = {
                "event": "completed",
                "ok": True,
                "stage": "completed",
                "progress": 1.0,
                "job_id": message["job_id"],
            }
            if emit_fn is None:
                print(json.dumps(payload), flush=True)
            else:
                emit_fn(payload)
            return False

        with (
            mock.patch.object(module, "_original_dispatch_serve_command", noisy_dispatch),
            mock.patch.object(sys, "stdin", stdin),
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            result = module.run_serve(None)

        self.assertEqual(result, 0)
        stdout_lines = [line for line in stdout.getvalue().splitlines() if line.strip()]
        self.assertEqual(len(stdout_lines), 1, stdout.getvalue())
        payload = json.loads(stdout_lines[0])
        self.assertEqual(payload["event"], "completed")
        self.assertEqual(payload["job_id"], "job-noisy")
        self.assertIn("PointCrossAttentionEncoder INFO", stderr.getvalue())
