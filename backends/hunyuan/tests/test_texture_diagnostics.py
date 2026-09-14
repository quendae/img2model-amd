import importlib.util
import unittest
from pathlib import Path


WORKER = Path(__file__).resolve().parents[1] / "worker.py"


class TextureDiagnosticTests(unittest.TestCase):
    def load_worker_module(self):
        spec = importlib.util.spec_from_file_location("img2model_texture_diagnostic_worker", WORKER)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_texture_error_includes_last_debug_stage_and_traceback(self) -> None:
        module = self.load_worker_module()
        events: list[dict[str, object]] = []
        previous_sink = module._base._EVENT_SINK
        previous_job_id = module._base._CURRENT_JOB_ID
        try:
            module._base._EVENT_SINK = events.append
            module._base._CURRENT_JOB_ID = "job-texture-diagnostics"

            module._diagnostic_emit(
                "progress",
                ok=True,
                stage="running_texture",
                progress=0.35,
            )

            try:
                raise OSError(22, "Invalid argument")
            except OSError as exc:
                module._diagnostic_emit(
                    "error",
                    ok=False,
                    stage="texture",
                    error_kind="worker_error",
                    error=f"{type(exc).__name__}: {exc}",
                )
        finally:
            module._base._EVENT_SINK = previous_sink
            module._base._CURRENT_JOB_ID = previous_job_id

        error = events[-1]
        self.assertEqual(error["event"], "error")
        self.assertEqual(error["job_id"], "job-texture-diagnostics")
        self.assertEqual(error["debug_stage"], "paint_inference")
        self.assertIn("Debug stage: paint_inference", str(error["error"]))
        self.assertIn("OSError: [Errno 22] Invalid argument", str(error["error"]))
        self.assertIn("Traceback (most recent call last)", str(error["traceback"]))

    def test_texture_debug_stage_follows_preprocess_and_export_progress(self) -> None:
        module = self.load_worker_module()
        events: list[dict[str, object]] = []
        previous_sink = module._base._EVENT_SINK
        try:
            module._base._EVENT_SINK = events.append

            module._diagnostic_emit("progress", stage="preparing_input", progress=0.10)
            try:
                raise OSError(22, "image invalid")
            except OSError as exc:
                module._diagnostic_emit("error", stage="texture", error=str(exc))
            self.assertEqual(events[-1]["debug_stage"], "image_preprocess")

            module._diagnostic_emit("progress", stage="postprocessing", progress=0.92)
            try:
                raise OSError(22, "export invalid")
            except OSError as exc:
                module._diagnostic_emit("error", stage="texture", error=str(exc))
            self.assertEqual(events[-1]["debug_stage"], "texture_export")
        finally:
            module._base._EVENT_SINK = previous_sink


if __name__ == "__main__":
    unittest.main()
