import importlib.util
import unittest
from pathlib import Path

WORKER = Path(__file__).resolve().parents[1] / "worker.py"


class TextureStyleContractTests(unittest.TestCase):
    def load_worker_module(self):
        spec = importlib.util.spec_from_file_location("img2model_hunyuan_worker_texture_style", WORKER)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_texture_namespace_preserves_style_preset(self) -> None:
        module = self.load_worker_module()
        args = module._texture_namespace(
            {
                "mesh": "shape.glb",
                "image": "source.png",
                "output": "textured.glb",
                "stylePreset": "cartoon",
            }
        )
        self.assertEqual(getattr(args, "style_preset", None), "cartoon")

    def test_texture_namespace_rejects_unknown_style_preset(self) -> None:
        module = self.load_worker_module()
        with self.assertRaisesRegex(ValueError, "Texture style preset"):
            module._texture_namespace(
                {
                    "mesh": "shape.glb",
                    "image": "source.png",
                    "output": "textured.glb",
                    "stylePreset": "unknown-style",
                }
            )


if __name__ == "__main__":
    unittest.main()
