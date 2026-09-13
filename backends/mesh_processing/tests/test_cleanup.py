import unittest

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
        self.assertFalse(bool(report.remeshed))

    def test_game_ready_routes_through_repair_and_adaptive_reduction(self):
        source = trimesh.creation.icosphere(subdivisions=4, radius=1.0)
        cleaned, report = cleanup_mesh(source, resolve_cleanup_config("game-ready", {}))

        self.assertTrue(report.remeshed)
        self.assertTrue(str(report.repair_backend).startswith("pymeshlab"))
        self.assertLess(len(cleaned.faces), len(source.faces))
        self.assertLess(report.triangles_after, report.triangles_before)
        self.assertIsNotNone(report.watertight_before)
        self.assertIsNotNone(report.watertight_after)
        self.assertIsNotNone(report.boundary_edges_before)
        self.assertIsNotNone(report.boundary_edges_after)
        self.assertIsNotNone(report.normalized_error)
        self.assertGreater(report.reduction_ratio, 0.0)

    def test_manual_game_ready_target_reduces_near_requested_budget(self):
        source = trimesh.creation.icosphere(subdivisions=4, radius=1.0)
        config = resolve_cleanup_config(
            "game-ready",
            {"triangle_budget_mode": "manual", "target_triangles": 3500},
        )
        cleaned, report = cleanup_mesh(source, config)

        self.assertLessEqual(abs(len(cleaned.faces) - 3500), 400)
        self.assertEqual(report.target_triangles, 3500)

    def test_off_preserves_counts(self):
        source = trimesh.creation.box()
        cleaned, report = cleanup_mesh(source, resolve_cleanup_config("off", {}))
        self.assertEqual(len(cleaned.vertices), len(source.vertices))
        self.assertEqual(len(cleaned.faces), len(source.faces))
        self.assertEqual(report.spikes_adjusted, 0)
        self.assertFalse(bool(report.remeshed))


if __name__ == "__main__":
    unittest.main()
