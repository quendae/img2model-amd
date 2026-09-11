import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path


WORKER = Path(__file__).resolve().parents[1] / "worker.py"


class WorkerProtocolTests(unittest.TestCase):
    def run_worker(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(WORKER), *args],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_health_returns_machine_readable_status_without_ml_runtime(self) -> None:
        result = self.run_worker("health", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertIn("ok", payload)
        self.assertIn("python", payload)
        self.assertIn("torch_available", payload)
        self.assertIn("hunyuan_available", payload)
        self.assertIn("hip_version", payload)
        self.assertIn("device_name", payload)

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
        spec = importlib.util.spec_from_file_location("img2model_hunyuan_worker", WORKER)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

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


if __name__ == "__main__":
    unittest.main()
