import unittest
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
                "overrides": {"smoothing_iterations": 1},
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
        self.assertEqual(args.overrides["smoothing_iterations"], 1)


if __name__ == "__main__":
    unittest.main()
