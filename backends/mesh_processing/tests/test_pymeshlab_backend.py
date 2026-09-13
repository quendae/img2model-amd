import unittest

import numpy as np
import trimesh

from backends.mesh_processing.pymeshlab_backend import (
    ReductionPolicy,
    RepairPolicy,
    adaptive_qem_reduce,
    repair_with_pymeshlab,
)


def _open_main_with_tiny_component() -> trimesh.Trimesh:
    main = trimesh.creation.icosphere(subdivisions=2, radius=1.0)
    keep = np.ones(len(main.faces), dtype=bool)
    keep[0] = False
    main.update_faces(keep)
    main.remove_unreferenced_vertices()

    tiny = trimesh.creation.icosphere(subdivisions=0, radius=0.01)
    tiny.apply_translation([2.0, 0.0, 0.0])
    return trimesh.util.concatenate([main, tiny])


def _dense_simple_prop() -> trimesh.Trimesh:
    return trimesh.creation.icosphere(subdivisions=4, radius=1.0)


def _thin_feature_prop() -> trimesh.Trimesh:
    body = trimesh.creation.icosphere(subdivisions=3, radius=1.0)
    stem = trimesh.creation.cylinder(radius=0.05, height=2.0, sections=32)
    stem.apply_translation([0.0, 0.0, 2.0])
    return trimesh.util.concatenate([body, stem])


class PyMeshLabRepairBackendTests(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = RepairPolicy(
            close_holes_max_edges=100,
            remove_component_faces_below=25,
            isotropic_iterations=0,
            isotropic_target_pct=1.0,
            manifold_finalize=True,
        )

    def test_repair_closes_small_hole_and_removes_tiny_component(self) -> None:
        source = _open_main_with_tiny_component()
        repaired, stats = repair_with_pymeshlab(source, self.policy)

        self.assertGreater(len(repaired.faces), 0)
        self.assertGreaterEqual(stats.components_removed, 1)
        self.assertTrue(stats.repair_backend.startswith("pymeshlab"))
        self.assertTrue(stats.watertight_before is False)
        self.assertLessEqual(
            stats.boundary_edges_after if stats.boundary_edges_after is not None else 0,
            stats.boundary_edges_before if stats.boundary_edges_before is not None else 0,
        )

    def test_conversion_round_trip_preserves_nonempty_triangular_mesh(self) -> None:
        source = trimesh.creation.icosphere(subdivisions=1, radius=1.0)
        repaired, stats = repair_with_pymeshlab(source, self.policy)

        self.assertEqual(repaired.vertices.shape[1], 3)
        self.assertEqual(repaired.faces.shape[1], 3)
        self.assertGreater(len(repaired.vertices), 0)
        self.assertGreater(len(repaired.faces), 0)
        self.assertTrue(stats.repair_backend.startswith("pymeshlab"))

    def test_auto_qem_reduction_accepts_smallest_candidate_within_error(self) -> None:
        source = _dense_simple_prop()
        policy = ReductionPolicy(
            min_faces=900,
            start_faces=3000,
            error_tolerance=0.02,
        )

        reduced, stats = adaptive_qem_reduce(source, policy)

        self.assertLess(len(reduced.faces), len(source.faces) * 0.70)
        self.assertGreaterEqual(len(reduced.faces), 800)
        self.assertIsNotNone(stats.normalized_error)
        self.assertLessEqual(float(stats.normalized_error), policy.error_tolerance)
        self.assertGreaterEqual(stats.attempts, 1)
        self.assertEqual(stats.accepted_faces, len(reduced.faces))

    def test_manual_target_is_honored_approximately(self) -> None:
        source = _dense_simple_prop()
        policy = ReductionPolicy(
            min_faces=900,
            start_faces=3000,
            error_tolerance=0.10,
            manual_target_faces=1200,
        )

        reduced, stats = adaptive_qem_reduce(source, policy)

        self.assertLessEqual(abs(len(reduced.faces) - 1200), 150)
        self.assertEqual(stats.requested_target_faces, 1200)
        self.assertEqual(stats.accepted_faces, len(reduced.faces))

    def test_auto_qem_preserves_thin_legitimate_extent_within_tolerance(self) -> None:
        source = _thin_feature_prop()
        source_max_z = float(source.bounds[1][2])
        policy = ReductionPolicy(
            min_faces=600,
            start_faces=1000,
            error_tolerance=0.008,
        )

        reduced, stats = adaptive_qem_reduce(source, policy)

        self.assertGreaterEqual(float(reduced.bounds[1][2]), source_max_z - 0.10)
        self.assertIsNotNone(stats.normalized_error)
        self.assertLessEqual(float(stats.normalized_error), policy.error_tolerance)


if __name__ == "__main__":
    unittest.main()
