import argparse
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from backends.hunyuan import worker


class MeshCleanupWorkerProtocolTests(unittest.TestCase):
    def test_protocol_version_is_two(self):
        self.assertEqual(worker.PROTOCOL_VERSION, 2)

    def test_mesh_cleanup_command_dispatches_request(self):
        events = []
        message = {
            "command": "mesh_cleanup",
            "job_id": "job-mesh-1",
            "request": {
                "input": "source.glb",
                "output": "source-clean.glb",
                "preset": "game-ready",
                "overrides": {
                    "triangle_budget_mode": "manual",
                    "target_triangles": 5000,
                },
            },
        }
        with mock.patch.object(worker, "run_mesh_cleanup", return_value=0) as run:
            keep_running = worker.dispatch_serve_command(
                message,
                cache=worker.PipelineCache(),
                emit_fn=events.append,
            )

        self.assertTrue(keep_running)
        args = run.call_args.args[0]
        self.assertEqual(args.input, "source.glb")
        self.assertEqual(args.output, "source-clean.glb")
        self.assertEqual(args.preset, "game-ready")
        self.assertEqual(args.overrides["triangle_budget_mode"], "manual")
        self.assertEqual(args.overrides["target_triangles"], 5000)

    def test_mesh_cleanup_releases_hunyuan_gpu_pipelines_before_cpu_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            input_path = Path(tmp) / "source.glb"
            output_path = Path(tmp) / "source-clean.glb"
            input_path.write_bytes(b"placeholder")
            args = argparse.Namespace(
                input=str(input_path),
                output=str(output_path),
                preset="game-ready",
                overrides={},
            )
            cache = worker.PipelineCache()
            report = SimpleNamespace(cleanup_ms=0.0, to_dict=lambda: {})
            cleaned = SimpleNamespace()

            with mock.patch.object(cache, "clear_shape") as clear_shape, mock.patch.object(
                cache,
                "clear_texture",
            ) as clear_texture, mock.patch.object(
                cache.cleanup_mesh_cache,
                "get_or_create",
                return_value=(cleaned, report, False),
            ), mock.patch.object(worker, "export_mesh_atomic"), mock.patch.object(worker, "emit"):
                result = worker.run_mesh_cleanup(args, cache=cache)

        self.assertEqual(result, 0)
        clear_shape.assert_called_once()
        clear_texture.assert_called_once()


if __name__ == "__main__":
    unittest.main()
