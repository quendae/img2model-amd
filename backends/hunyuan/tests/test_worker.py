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

    def test_serve_protocol_survives_third_party_stdout_noise(self) -> None:
        module = self.load_worker_module()
        stdin = io.StringIO(json.dumps({"command": "shape", "job_id": "job-noisy", "request": {}}) + "\n")
        stdout = io.StringIO()

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
        ):
            result = module.run_serve(None)

        self.assertEqual(result, 0)
        stdout_lines = [line for line in stdout.getvalue().splitlines() if line.strip()]
        self.assertGreaterEqual(len(stdout_lines), 2, stdout.getvalue())
        self.assertIn("PointCrossAttentionEncoder INFO", stdout_lines[0])
        payload = json.loads(stdout_lines[-1])
        self.assertEqual(payload["event"], "completed")
        self.assertEqual(payload["job_id"], "job-noisy")

    def test_preload_shape_reuses_shape_pipeline_cache(self) -> None:
        module = self.load_worker_module()
        replies: list[dict[str, object]] = []
        cache = module.PipelineCache(event_sink=replies.append)
        built: list[str] = []

        def fake_build(args):
            built.append(args.model)
            return object()

        with mock.patch.object(module._base, "build_shape_pipeline", fake_build):
            first = module.dispatch_serve_command(
                {"command": "preload_shape", "job_id": "job-preload-1", "request": {}},
                cache=cache,
                emit_fn=replies.append,
            )
            second = module.dispatch_serve_command(
                {"command": "preload_shape", "job_id": "job-preload-2", "request": {}},
                cache=cache,
                emit_fn=replies.append,
            )

        self.assertTrue(first)
        self.assertTrue(second)
        self.assertEqual(built, ["tencent/Hunyuan3D-2mini"])
        completed = [item for item in replies if item.get("event") == "completed"]
        self.assertEqual(len(completed), 2, replies)
        self.assertFalse(completed[0]["cache_hit"])
        self.assertTrue(completed[1]["cache_hit"])
        self.assertEqual(completed[-1]["stage"], "shape_preloaded")
