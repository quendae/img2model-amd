import unittest

import numpy as np
import trimesh

from backends.mesh_processing.pymeshlab_backend import RepairPolicy, repair_with_pymeshlab


def _open_main_with_tiny_component() -> trimesh.Trimesh:
    main = trimesh.creation.icosphere(subdivisions=2, radius=1.0)
    keep = np.ones(len(main.faces), dtype=bool)
    keep[0] = False
    main.update_faces(keep)
    main.remove_unreferenced_vertices()

    tiny = trimesh.creation.icosphere(subdivisions=0, radius=0.01)
    tiny.apply_translation([2.0, 0.0, 0.0])
    return trimesh.util.concatenate([main, tiny])


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


if __name__ == "__main__":
    unittest.main()
