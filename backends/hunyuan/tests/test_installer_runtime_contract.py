import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
INSTALLER = ROOT / "scripts" / "setup" / "install-img2model-runtime.ps1"


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


if __name__ == "__main__":
    unittest.main()
