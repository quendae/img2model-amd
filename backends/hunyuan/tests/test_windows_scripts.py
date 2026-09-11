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

    def test_texture_setup_uses_ninja_and_forces_cpp20_for_pytorch_213(self) -> None:
        text = TEXTURE_SETUP.read_text(encoding="utf-8")
        self.assertIn("pip install --upgrade ninja", text)
        self.assertIn('/std:c++20', text)
        self.assertIn("Ninja build backend", text)

    def test_texture_setup_persists_full_build_log_and_prints_short_failure_tail(self) -> None:
        text = TEXTURE_SETUP.read_text(encoding="utf-8")
        self.assertIn('Join-Path $RuntimeDir "logs"', text)
        self.assertIn('texture-setup-', text)
        self.assertIn('Tee-Object -FilePath $LogPath -Append', text)
        self.assertIn('Get-Content -LiteralPath $LogPath -Tail 80', text)
        self.assertIn('Full log', text)

    def test_texture_setup_keeps_hip_runtime_headers_out_of_msvc_host_compilation(self) -> None:
        text = TEXTURE_SETUP.read_text(encoding="utf-8")
        self.assertIn("Patching Hunyuan rasterizer header for MSVC/HIP split", text)
        self.assertIn("defined(__CUDACC__) || defined(__HIPCC__)", text)
        self.assertIn("#define __host__", text)
        self.assertIn("#define __device__", text)
        self.assertIn("rasterizer_hip.h", text)
        self.assertIn("Remove-Item", text)


if __name__ == "__main__":
    unittest.main()
