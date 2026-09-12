from pathlib import Path
import unittest


SETUP = Path(__file__).resolve().parents[3] / "scripts" / "setup" / "windows-native-rocm.ps1"


class MeshCleanupRuntimePackagingTests(unittest.TestCase):
    def test_native_rocm_setup_copies_worker_base_and_mesh_processing_package(self):
        text = SETUP.read_text(encoding="utf-8")
        self.assertIn("worker_base.py", text)
        self.assertIn("backends\\mesh_processing", text)
        self.assertIn("Copy-Item -Recurse -Force $MeshProcessingSource $InstalledMeshProcessing", text)


if __name__ == "__main__":
    unittest.main()
