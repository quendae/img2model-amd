import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace


WORKER = Path(__file__).resolve().parents[1] / "worker.py"


class WorkerProtocolTests(unittest.TestCase):
    def run_worker(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(WORKER), *args],
            capture_output=True,
            text=True,
            check=False,
        )

    def load_worker_module(self):
        spec = importlib.util.spec_from_file_location("img2model_hunyuan_worker", WORKER)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_health_returns_machine_readable_status_without_ml_runtime(self) -> None:
        result = self.run_worker("health", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertIn("ok", payload)
        self.assertIn("python", payload)
        self.assertIn("torch_available", payload)
        self.assertIn("hunyuan_available", payload)
        self.assertIn("hunyuan_import_ok", payload)
        self.assertIn("hip_version", payload)
        self.assertIn("gpu_available", payload)
        self.assertIn("device_name", payload)

    def test_texture_health_returns_machine_readable_capability(self) -> None:
        result = self.run_worker("texture-health", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertIn("ok", payload)
        self.assertIn("texgen_available", payload)
        self.assertIn("custom_rasterizer_available", payload)
        self.assertIn("mesh_processor_available", payload)
        self.assertIn("texture_import_ok", payload)
        self.assertIn("error", payload)

    def test_probe_always_returns_machine_readable_result(self) -> None:
        result = self.run_worker("probe", "--json")
        self.assertTrue(result.stdout.strip(), result.stderr)
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertIn("ok", payload)
        if payload["ok"]:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("checksum", payload)
            self.assertIn("device", payload)
        else:
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("error", payload)

    def test_generate_rejects_missing_input_with_json_error(self) -> None:
        missing = Path(__file__).resolve().parent / "does-not-exist.png"
        output = Path(__file__).resolve().parent / "unused.glb"
        result = self.run_worker(
            "generate",
            "--input",
            str(missing),
            "--output",
            str(output),
            "--model",
            "tencent/Hunyuan3D-2mini",
            "--subfolder",
            "hunyuan3d-dit-v2-mini",
        )
        self.assertNotEqual(result.returncode, 0)
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["event"], "error")
        self.assertIn("Input image does not exist", payload["error"])

    def test_generate_defaults_to_official_mini_fp16_variant(self) -> None:
        module = self.load_worker_module()
        parser = module.build_parser()
        args = parser.parse_args(
            [
                "generate",
                "--input",
                "input.png",
                "--output",
                "output.glb",
            ]
        )
        self.assertEqual(args.variant, "fp16")

    def test_texture_defaults_to_auto_profile(self) -> None:
        module = self.load_worker_module()
        parser = module.build_parser()
        args = parser.parse_args(
            [
                "texture",
                "--mesh",
                "input.glb",
                "--image",
                "input.png",
                "--output",
                "textured.glb",
            ]
        )
        self.assertEqual(args.model, "tencent/Hunyuan3D-2")
        self.assertEqual(args.subfolder, "hunyuan3d-paint-v2-0-turbo")
        self.assertEqual(args.profile, "auto")
        self.assertIsNone(args.max_faces)
        self.assertIsNone(args.cpu_offload)
        self.assertIsNone(args.attention_slicing)

    def test_texture_parser_accepts_all_profiles(self) -> None:
        module = self.load_worker_module()
        parser = module.build_parser()
        for profile in ("auto", "safe", "balanced", "quality"):
            args = parser.parse_args(
                [
                    "texture",
                    "--mesh",
                    "input.glb",
                    "--image",
                    "input.png",
                    "--output",
                    "output.glb",
                    "--profile",
                    profile,
                ]
            )
            self.assertEqual(args.profile, profile)

    def test_auto_texture_profile_is_safe_at_16_gib(self) -> None:
        module = self.load_worker_module()
        resolved = module.resolve_texture_profile("auto", 15.98)
        self.assertEqual(resolved["name"], "safe")
        self.assertEqual(resolved["max_faces"], 10_000)
        self.assertTrue(resolved["cpu_offload"])
        self.assertEqual(resolved["attention_slicing"], "max")

    def test_auto_texture_profile_is_balanced_above_16_gib(self) -> None:
        module = self.load_worker_module()
        resolved = module.resolve_texture_profile("auto", 24.0)
        self.assertEqual(resolved["name"], "balanced")
        self.assertEqual(resolved["max_faces"], 20_000)

    def test_explicit_quality_profile_uses_40k(self) -> None:
        module = self.load_worker_module()
        resolved = module.resolve_texture_profile("quality", 16.0)
        self.assertEqual(resolved["name"], "quality")
        self.assertEqual(resolved["max_faces"], 40_000)

    def test_classify_texture_error_detects_rocm_cuda_oom_wording(self) -> None:
        module = self.load_worker_module()
        kind = module.classify_texture_error(
            RuntimeError("CUDA out of memory. Tried to allocate 2.81 GiB")
        )
        self.assertEqual(kind, "out_of_memory")

    def test_texture_allows_expert_overrides(self) -> None:
        module = self.load_worker_module()
        parser = module.build_parser()
        args = parser.parse_args(
            [
                "texture",
                "--mesh",
                "input.glb",
                "--image",
                "input.png",
                "--output",
                "textured.glb",
                "--max-faces",
                "12000",
                "--no-cpu-offload",
                "--attention-slicing",
                "off",
            ]
        )
        self.assertEqual(args.max_faces, 12000)
        self.assertFalse(args.cpu_offload)
        self.assertEqual(args.attention_slicing, "off")

    def test_texture_preprocess_matches_official_hunyuan_flow(self) -> None:
        module = self.load_worker_module()
        calls: list[object] = []

        class Floater:
            def __call__(self, mesh):
                calls.append(("floater", mesh))
                return "after-floater"

        class Degenerate:
            def __call__(self, mesh):
                calls.append(("degenerate", mesh))
                return "after-degenerate"

        class Reducer:
            def __call__(self, mesh, max_facenum):
                calls.append(("reduce", mesh, max_facenum))
                return "after-reduce"

        result = module.prepare_texture_mesh(
            "input-mesh",
            max_faces=40000,
            floater_remover_cls=Floater,
            degenerate_face_remover_cls=Degenerate,
            face_reducer_cls=Reducer,
        )

        self.assertEqual(result, "after-reduce")
        self.assertEqual(
            calls,
            [
                ("floater", "input-mesh"),
                ("degenerate", "after-floater"),
                ("reduce", "after-degenerate", 40000),
            ],
        )

    def test_texture_memory_profile_enables_cpu_offload_and_max_attention_slicing(self) -> None:
        module = self.load_worker_module()
        calls: list[object] = []

        class MultiviewPipeline:
            def enable_attention_slicing(self, slice_size):
                calls.append(("attention_slicing", slice_size))

        class PaintPipeline:
            def __init__(self):
                self.models = {
                    "multiview_model": SimpleNamespace(pipeline=MultiviewPipeline())
                }

            def enable_model_cpu_offload(self):
                calls.append(("cpu_offload",))

        pipeline = PaintPipeline()
        module.configure_texture_memory_profile(
            pipeline,
            cpu_offload=True,
            attention_slicing="max",
        )

        self.assertEqual(
            calls,
            [
                ("cpu_offload",),
                ("attention_slicing", "max"),
            ],
        )

    def test_texture_memory_profile_rejects_missing_attention_slicing_api(self) -> None:
        module = self.load_worker_module()
        pipeline = SimpleNamespace(
            models={"multiview_model": SimpleNamespace(pipeline=SimpleNamespace())}
        )

        with self.assertRaisesRegex(RuntimeError, "attention slicing"):
            module.configure_texture_memory_profile(
                pipeline,
                cpu_offload=False,
                attention_slicing="max",
            )

    def test_texture_rejects_missing_mesh_with_json_error(self) -> None:
        missing_mesh = Path(__file__).resolve().parent / "does-not-exist.glb"
        output = Path(__file__).resolve().parent / "unused-textured.glb"
        result = self.run_worker(
            "texture",
            "--mesh",
            str(missing_mesh),
            "--image",
            str(__file__),
            "--output",
            str(output),
        )
        self.assertNotEqual(result.returncode, 0)
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["event"], "error")
        self.assertIn("Input mesh does not exist", payload["error"])

    def test_texture_rejects_missing_image_with_json_error(self) -> None:
        missing_image = Path(__file__).resolve().parent / "does-not-exist.png"
        output = Path(__file__).resolve().parent / "unused-textured.glb"
        result = self.run_worker(
            "texture",
            "--mesh",
            str(__file__),
            "--image",
            str(missing_image),
            "--output",
            str(output),
        )
        self.assertNotEqual(result.returncode, 0)
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["event"], "error")
        self.assertIn("Input image does not exist", payload["error"])

    def test_hunyuan_paint_loader_trusts_local_custom_pipeline_and_restores_module(self) -> None:
        module = self.load_worker_module()
        calls: list[dict[str, object]] = []

        class OriginalDiffusionPipeline:
            @staticmethod
            def from_pretrained(*args, **kwargs):
                calls.append(dict(kwargs))
                return "inner-pipeline"

        multiview_module = SimpleNamespace(DiffusionPipeline=OriginalDiffusionPipeline)

        class FakePaintPipeline:
            @staticmethod
            def from_pretrained(model, subfolder):
                inner = multiview_module.DiffusionPipeline.from_pretrained(
                    "local-checkpoint",
                    custom_pipeline="local-custom-pipeline",
                )
                return (model, subfolder, inner)

        result = module.load_hunyuan_paint_pipeline(
            FakePaintPipeline,
            multiview_module,
            "tencent/Hunyuan3D-2",
            "hunyuan3d-paint-v2-0-turbo",
        )

        self.assertEqual(result[2], "inner-pipeline")
        self.assertTrue(calls[-1]["trust_remote_code"])
        self.assertIs(multiview_module.DiffusionPipeline, OriginalDiffusionPipeline)


if __name__ == "__main__":
    unittest.main()
