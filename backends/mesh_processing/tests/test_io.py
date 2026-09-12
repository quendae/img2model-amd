from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import trimesh

from backends.mesh_processing.io import process_mesh
from backends.mesh_processing.presets import resolve_cleanup_config


class CleanupIoTests(unittest.TestCase):
    def test_process_mesh_keeps_source_unchanged(self):
        with TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.glb"
            output = Path(tmp) / "source-clean.glb"
            trimesh.creation.box().export(source)
            before = source.read_bytes()
            report = process_mesh(source, output, resolve_cleanup_config("light", {}))
            self.assertEqual(source.read_bytes(), before)
            self.assertTrue(output.is_file())
            self.assertGreater(report.triangles_after, 0)

    def test_refuses_same_input_and_output_path(self):
        with TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.glb"
            trimesh.creation.box().export(source)
            with self.assertRaisesRegex(ValueError, "must differ"):
                process_mesh(source, source, resolve_cleanup_config("light", {}))


if __name__ == "__main__":
    unittest.main()
