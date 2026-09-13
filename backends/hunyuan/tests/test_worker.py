import contextlib
import io
import json
import sys
import tempfile
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest import mock

from PIL import Image

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

    def test_shape_generation_uses_hunyuan_default_generator_on_windows_rocm(self) -> None:
        module = self.load_worker_module()
        replies: list[dict[str, object]] = []
        calls: dict[str, object] = {}

        fake_torch = ModuleType("torch")
        fake_torch.cuda = SimpleNamespace(is_available=lambda: True)

        class ForbiddenCudaGenerator:
            def __init__(self, *args, **kwargs):
                raise OSError(22, "Invalid argument")

        def manual_seed(seed: int):
            calls["seed"] = seed
            return ("default-generator", seed)

        fake_torch.Generator = ForbiddenCudaGenerator
        fake_torch.manual_seed = manual_seed

        class FakeMesh:
            def export(self, path: str) -> None:
                Path(path).write_bytes(b"fake-glb")

        class FakePipeline:
            def __call__(self, **kwargs):
                calls["generator"] = kwargs.get("generator")
                calls["enable_pbar"] = kwargs.get("enable_pbar")
                return [FakeMesh()]

        with tempfile.TemporaryDirectory() as tmp:
            input_path = Path(tmp) / "input.png"
            output_path = Path(tmp) / "output.glb"
            Image.new("RGBA", (2, 2), (255, 0, 0, 255)).save(input_path)

            args = SimpleNamespace(
                input=str(input_path),
                output=str(output_path),
                model="tencent/Hunyuan3D-2mini",
                subfolder="hunyuan3d-dit-v2-mini",
                variant="fp16",
                steps=30,
                seed=1234,
                remove_background=False,
            )
            cache = module.PipelineCache(event_sink=replies.append)
            cache.shape_pipeline = FakePipeline()
            cache.shape_key = (args.model, args.subfolder, args.variant)

            previous_sink = module._base._EVENT_SINK
            previous_job_id = module._base._CURRENT_JOB_ID
            module._base._EVENT_SINK = replies.append
            module._base._CURRENT_JOB_ID = "job-shape-generator"
            try:
                with mock.patch.dict(sys.modules, {"torch": fake_torch}):
                    result = module.run_generate(args, cache=cache)
            finally:
                module._base._EVENT_SINK = previous_sink
                module._base._CURRENT_JOB_ID = previous_job_id

            self.assertEqual(result, 0, replies)
            self.assertEqual(calls["seed"], 1234)
            self.assertEqual(calls["generator"], ("default-generator", 1234))
            self.assertIs(calls["enable_pbar"], False)
            self.assertTrue(output_path.is_file())

    def test_shape_failure_reports_debug_stage_and_traceback(self) -> None:
        module = self.load_worker_module()
        replies: list[dict[str, object]] = []

        fake_torch = ModuleType("torch")
        fake_torch.cuda = SimpleNamespace(is_available=lambda: True)
        fake_torch.manual_seed = lambda seed: ("default-generator", seed)

        class FailingPipeline:
            def __call__(self, **kwargs):
                raise OSError(22, "Invalid argument")

        with tempfile.TemporaryDirectory() as tmp:
            input_path = Path(tmp) / "input.png"
            output_path = Path(tmp) / "output.glb"
            Image.new("RGBA", (2, 2), (255, 0, 0, 255)).save(input_path)

            args = SimpleNamespace(
                input=str(input_path),
                output=str(output_path),
                model="tencent/Hunyuan3D-2mini",
                subfolder="hunyuan3d-dit-v2-mini",
                variant="fp16",
                steps=30,
                seed=1234,
                remove_background=False,
            )
            cache = module.PipelineCache(event_sink=replies.append)
            cache.shape_pipeline = FailingPipeline()
            cache.shape_key = (args.model, args.subfolder, args.variant)

            previous_sink = module._base._EVENT_SINK
            previous_job_id = module._base._CURRENT_JOB_ID
            module._base._EVENT_SINK = replies.append
            module._base._CURRENT_JOB_ID = "job-shape-traceback"
            try:
                with mock.patch.dict(sys.modules, {"torch": fake_torch}):
                    result = module.run_generate(args, cache=cache)
            finally:
                module._base._EVENT_SINK = previous_sink
                module._base._CURRENT_JOB_ID = previous_job_id

        self.assertEqual(result, 1, replies)
        error = replies[-1]
        self.assertEqual(error["event"], "error")
        self.assertEqual(error["debug_stage"], "pipeline_call")
        self.assertIn("worker_base.py", str(error["traceback"]))
        self.assertIn("mesh = pipeline(**generate_kwargs)[0]", str(error["traceback"]))
        self.assertIn("OSError: [Errno 22] Invalid argument", str(error["traceback"]))
