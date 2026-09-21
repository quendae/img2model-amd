import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
INSTALLER = ROOT / "scripts" / "setup" / "install-img2model-runtime.ps1"
PREPARE_INSTALLER = ROOT / "scripts" / "setup" / "prepare-installer-resources.mjs"
REPAINT_REQUIREMENTS = ROOT / "backends" / "hunyuan" / "requirements-repaint.txt"


class InstallerRuntimeContractTests(unittest.TestCase):
    def test_healthy_existing_runtime_is_reused_before_prerequisite_or_reinstall_work(self) -> None:
        text = INSTALLER.read_text(encoding="utf-8")
        self.assertIn("ForceRepair", text)
        self.assertIn("Test-ExistingRuntimeHealth", text)
        self.assertIn("Reusing healthy existing Img2Model AMD runtime", text)
        self.assertIn("$ExistingRuntimeHealthy = Test-ExistingRuntimeHealth", text)
        self.assertLess(
            text.index("$ExistingRuntimeHealthy = Test-ExistingRuntimeHealth"),
            text.index("$PyLauncher = Get-Command py.exe"),
        )
        self.assertLess(
            text.index("Reusing healthy existing Img2Model AMD runtime"),
            text.index("& $NativeSetup -Channel"),
        )

    def test_force_repair_can_bypass_runtime_reuse(self) -> None:
        text = INSTALLER.read_text(encoding="utf-8")
        self.assertIn("-not $ForceRepair", text)
        self.assertIn("Repairing/installing persistent Radeon runtime", text)

    def test_installer_payload_contains_local_repaint_source_and_requirements(self) -> None:
        staging = PREPARE_INSTALLER.read_text(encoding="utf-8")
        self.assertIn("backends/hunyuan/local_repaint.py", staging)
        self.assertIn("backends/hunyuan/requirements-repaint.txt", staging)
        self.assertTrue(REPAINT_REQUIREMENTS.is_file())

    def test_repaint_requirements_are_bounded_and_do_not_reinstall_torch(self) -> None:
        requirements = REPAINT_REQUIREMENTS.read_text(encoding="utf-8")
        self.assertIn("diffusers>=0.36,<0.38", requirements)
        self.assertIn("transformers>=4.48,<5", requirements)
        self.assertIn("accelerate>=1.2,<2", requirements)
        self.assertIn("safetensors>=0.4.5", requirements)
        self.assertNotIn("torch", requirements.lower())

    def test_healthy_runtime_only_adds_missing_repaint_python_dependencies(self) -> None:
        text = INSTALLER.read_text(encoding="utf-8")
        self.assertIn("Test-RepaintDependencies", text)
        self.assertIn("Install-RepaintDependencies", text)
        self.assertIn("requirements-repaint.txt", text)
        self.assertIn("local_repaint.py", text)
        reuse_start = text.index("Reusing healthy existing Img2Model AMD runtime")
        native_repair = text.index("& $NativeSetup -Channel")
        repaint_install = text.index("Install-RepaintDependencies", reuse_start)
        self.assertLess(repaint_install, native_repair)


if __name__ == "__main__":
    unittest.main()
