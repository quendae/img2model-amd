import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SETUP = ROOT / "scripts" / "setup" / "windows-native-rocm.ps1"
TEXTURE_SETUP = ROOT / "scripts" / "setup" / "windows-hunyuan-texture.ps1"
SMOKE = ROOT / "scripts" / "smoke" / "windows-native-rocm.ps1"


class WindowsScriptRegressionTests(unittest.TestCase):
    def test_windows_scripts_do_not_pass_multiline_python_via_dash_c(self) -> None:
        for path in (SETUP, TEXTURE_SETUP, SMOKE):
            text = path.read_text(encoding="utf-8")
            self.assertNotIn(
                "-c $",
                text,
                f"{path.name} must not pass multiline Python through Windows native argv quoting",
            )

    def test_stable_gfx1030_setup_installs_matching_rocm_torchvision(self) -> None:
        text = SETUP.read_text(encoding="utf-8")
        self.assertIn(
            'torchvision[device-gfx1030]==0.28.0+rocm10.0.0',
            text,
            "Hunyuan imports torchvision, so the Windows ROCm setup must install the matching gfx1030 wheel",
        )

    def test_texture_setup_reuses_existing_rocm_runtime_and_builds_native_extensions(self) -> None:
        text = TEXTURE_SETUP.read_text(encoding="utf-8")
        self.assertIn("IMG2MODEL_PYTHON", text)
        self.assertIn("native-rocm", text)
        self.assertIn("custom_rasterizer", text)
        self.assertIn("differentiable_renderer", text)
        self.assertIn("--no-build-isolation", text)
        self.assertIn("ROCM_HOME", text)
        self.assertIn("texture-health", text)

    def test_texture_setup_does_not_reinstall_torch(self) -> None:
        text = TEXTURE_SETUP.read_text(encoding="utf-8")
        self.assertNotIn("torch[device-gfx1030]", text)
        self.assertNotIn("rocm[libraries", text)


if __name__ == "__main__":
    unittest.main()
