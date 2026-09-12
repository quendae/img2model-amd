import unittest

import numpy as np
import trimesh

from backends.mesh_processing.cleanup import cleanup_mesh
from backends.mesh_processing.presets import resolve_cleanup_config


class CleanupGeometryTests(unittest.TestCase):
    def test_light_removes_tiny_disconnected_island(self):
        main = trimesh.creation.box(extents=[1.0, 1.0, 1.0])
        island = trimesh.creation.box(extents=[0.005, 0.005, 0.005])
        island.apply_translation([2.0, 0.0, 0.0])
        source = trimesh.util.concatenate([main, island])
        cleaned, report = cleanup_mesh(source, resolve_cleanup_config("light", {}))
        self.assertLess(report.components_after, report.components_before)
        self.assertGreaterEqual(report.components_removed, 1)
        self.assertLess(len(cleaned.faces), len(source.faces))

    def test_game_ready_reduces_artificial_spike_height(self):
        source = trimesh.creation.icosphere(subdivisions=2, radius=1.0)
        tip = int(np.argmax(source.vertices[:, 2]))
        source.vertices[tip] *= 5.0
        source_max_z = float(source.vertices[:, 2].max())
        cleaned, report = cleanup_mesh(source, resolve_cleanup_config("game-ready", {}))
        self.assertGreaterEqual(report.spikes_adjusted, 1)
        self.assertLess(float(cleaned.vertices[:, 2].max()), source_max_z)

    def test_thin_legitimate_feature_survives_game_ready(self):
        body = trimesh.creation.box(extents=[1.0, 1.0, 1.0])
        stem = trimesh.creation.cylinder(radius=0.05, height=1.0, sections=16)
        stem.apply_translation([0.0, 0.0, 1.0])
        source = trimesh.util.concatenate([body, stem])
        cleaned, report = cleanup_mesh(source, resolve_cleanup_config("game-ready", {}))
        self.assertEqual(report.components_removed, 0)
        self.assertGreater(float(cleaned.bounds[1][2]), 1.4)

    def test_off_preserves_counts(self):
        source = trimesh.creation.box()
        cleaned, report = cleanup_mesh(source, resolve_cleanup_config("off", {}))
        self.assertEqual(len(cleaned.vertices), len(source.vertices))
        self.assertEqual(len(cleaned.faces), len(source.faces))
        self.assertEqual(report.spikes_adjusted, 0)


if __name__ == "__main__":
    unittest.main()
