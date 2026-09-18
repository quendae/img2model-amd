import unittest

import trimesh

from backends.mesh_processing.cleanup import _heavy_policies, cleanup_mesh
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

    def test_light_repairs_single_triangle_hole_and_reports_topology(self):
        source = trimesh.creation.box(extents=[1.0, 1.0, 1.0])
        source.update_faces([False] + [True] * (len(source.faces) - 1))
        source.remove_unreferenced_vertices()
        self.assertFalse(source.is_watertight)

        cleaned, report = cleanup_mesh(source, resolve_cleanup_config("light", {}))

        self.assertFalse(bool(report.watertight_before))
        self.assertTrue(bool(report.watertight_after))
        self.assertGreater(report.boundary_edges_before or 0, 0)
        self.assertEqual(report.boundary_edges_after, 0)
        self.assertTrue(bool(report.manifold_before))
        self.assertTrue(bool(report.manifold_after))
        self.assertGreaterEqual(report.holes_closed or 0, 1)
        self.assertTrue(cleaned.is_watertight)
        self.assertFalse(bool(report.remeshed))

    def test_light_reports_pre_repair_topology_and_stage_timings(self):
        source = trimesh.creation.box(extents=[1.0, 1.0, 1.0])
        source.update_faces([False] + [True] * (len(source.faces) - 1))
        source.remove_unreferenced_vertices()

        _cleaned, report = cleanup_mesh(source, resolve_cleanup_config("light", {}))

        self.assertFalse(bool(report.pre_repair_watertight))
        self.assertTrue(bool(report.pre_repair_manifold))
        self.assertGreater(report.pre_repair_boundary_edges or 0, 0)
        for stage in (
            "input_topology",
            "remove_degenerate",
            "weld_vertices",
            "remove_small_islands",
            "small_hole_fill",
            "repair_winding",
            "final_validation",
        ):
            self.assertIn(stage, report.stage_ms)
            self.assertGreaterEqual(report.stage_ms[stage], 0.0)

    def test_game_ready_clean_watertight_mesh_skips_invasive_remesh_before_qem(self):
        # A healthy dense mesh should be simplified directly. Running isotropic
        # remeshing first can visibly facet otherwise smooth silhouettes before
        # the QEM error metric is even evaluated.
        source = trimesh.creation.icosphere(subdivisions=5, radius=1.0)
        cleaned, report = cleanup_mesh(source, resolve_cleanup_config("game-ready", {}))

        self.assertFalse(bool(report.remeshed))
        self.assertEqual(report.repair_backend, "validation-only")
        self.assertLess(len(cleaned.faces), len(source.faces))
        self.assertLess(report.triangles_after, report.triangles_before)
        self.assertTrue(report.watertight_before)
        self.assertTrue(report.watertight_after)
        self.assertEqual(report.boundary_edges_before, 0)
        self.assertEqual(report.boundary_edges_after, 0)
        self.assertIsNotNone(report.normalized_error)
        self.assertGreater(report.reduction_ratio, 0.0)

    def test_game_ready_reports_repair_reduction_and_validation_progress(self):
        source = trimesh.creation.icosphere(subdivisions=4, radius=1.0)
        events: list[tuple[str, float]] = []

        cleanup_mesh(
            source,
            resolve_cleanup_config("game-ready", {}),
            progress=lambda stage, value: events.append((stage, value)),
        )

        stages = [stage for stage, _value in events]
        self.assertIn("repairing_mesh", stages)
        self.assertIn("reducing_mesh", stages)
        self.assertIn("validating_mesh", stages)
        values = [value for _stage, value in events]
        self.assertEqual(values, sorted(values))
        self.assertGreater(values[-1], values[0])

    def test_game_ready_auto_budget_has_a_less_aggressive_floor(self):
        config = resolve_cleanup_config("game-ready", {})
        _repair, reduction = _heavy_policies(config)

        self.assertGreaterEqual(reduction.min_faces, 6000)
        self.assertGreaterEqual(reduction.start_faces, 48000)

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