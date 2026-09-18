import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest import mock


WORKER = Path(__file__).resolve().parents[1] / "worker.py"


class TextureOutputMetadataTests(unittest.TestCase):
    def load_worker_module(self):
        spec = importlib.util.spec_from_file_location("img2model_texture_output_worker", WORKER)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_texture_completed_reports_exported_file_size(self) -> None:
        module = self.load_worker_module()
        events: list[dict[str, object]] = []

        fake_torch = ModuleType("torch")
        fake_torch.cuda = SimpleNamespace(
            is_available=lambda: True,
            get_device_properties=lambda _index: SimpleNamespace(total_memory=16 * 1024**3),
            empty_cache=lambda: None,
        )
        fake_trimesh = ModuleType("trimesh")
        fake_hy3dgen = ModuleType("hy3dgen")
        fake_shapegen = ModuleType("hy3dgen.shapegen")
        fake_shapegen.DegenerateFaceRemover = type("DegenerateFaceRemover", (), {})
        fake_shapegen.FaceReducer = type("FaceReducer", (), {})
        fake_shapegen.FloaterRemover = type("FloaterRemover", (), {})

        class FakeTexturedMesh:
            def export(self, path: str) -> None:
                Path(path).write_bytes(b"x" * 123)

        class FakePipeline:
            def __call__(self, mesh, image=None):
                return FakeTexturedMesh()

        with tempfile.TemporaryDirectory() as tmp:
            mesh_path = Path(tmp) / "input.glb"
            image_path = Path(tmp) / "input.png"
            output_path = Path(tmp) / "output.glb"
            mesh_path.write_bytes(b"mesh")
            image_path.write_bytes(b"image")

            args = SimpleNamespace(
                mesh=str(mesh_path),
                image=str(image_path),
                output=str(output_path),
                model="tencent/Hunyuan3D-2",
                subfolder="hunyuan3d-paint-v2-0-turbo",
                profile="auto",
                max_faces=500,
                cpu_offload=None,
                attention_slicing=None,
                remove_background=False,
            )

            previous_sink = module._base._EVENT_SINK
            previous_job_id = module._base._CURRENT_JOB_ID
            module._base._EVENT_SINK = events.append
            module._base._CURRENT_JOB_ID = "job-output-size"
            try:
                with (
                    mock.patch.dict(
                        sys.modules,
                        {
                            "torch": fake_torch,
                            "trimesh": fake_trimesh,
                            "hy3dgen": fake_hy3dgen,
                            "hy3dgen.shapegen": fake_shapegen,
                        },
                    ),
                    mock.patch.object(
                        module._base,
                        "texture_health_payload",
                        return_value={"ok": True, "error": None},
                    ),
                    mock.patch.object(
                        module._base,
                        "load_or_prepare_texture_image",
                        return_value=(object(), False),
                    ),
                    mock.patch.object(
                        module._base,
                        "load_or_prepare_texture_mesh",
                        return_value=("mesh", False, 1000, 500),
                    ),
                    mock.patch.object(
                        module._base,
                        "build_texture_pipeline",
                        return_value=FakePipeline(),
                    ),
                ):
                    result = module._base.run_texture(args)
            finally:
                module._base._EVENT_SINK = previous_sink
                module._base._CURRENT_JOB_ID = previous_job_id

        self.assertEqual(result, 0, events)
        completed = events[-1]
        self.assertEqual(completed["event"], "completed")
        self.assertEqual(completed["output_size_bytes"], 123)


if __name__ == "__main__":
    unittest.main()
