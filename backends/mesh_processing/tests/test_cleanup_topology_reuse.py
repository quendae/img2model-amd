import unittest
from unittest.mock import patch

import trimesh

import backends.mesh_processing.cleanup as cleanup_module
from backends.mesh_processing.cleanup import cleanup_mesh
from backends.mesh_processing.presets import resolve_cleanup_config


class CleanupTopologyReuseTests(unittest.TestCase):
    def test_light_small_hole_fill_does_not_rebuild_full_topology(self):
        source = trimesh.creation.box(extents=[1.0, 1.0, 1.0])
        source.update_faces([False] + [True] * (len(source.faces) - 1))
        source.remove_unreferenced_vertices()

        with patch.object(cleanup_module, "_topology", wraps=cleanup_module._topology) as topology:
            cleaned, report = cleanup_mesh(source, resolve_cleanup_config("light", {}))

        self.assertTrue(cleaned.is_watertight)
        self.assertTrue(bool(report.watertight_after))
        self.assertEqual(report.boundary_edges_after, 0)
        self.assertGreaterEqual(report.holes_closed or 0, 1)
        self.assertEqual(
            topology.call_count,
            1,
            "Small-hole fill should patch the existing topology snapshot instead of rescanning the full mesh before winding repair.",
        )


if __name__ == "__main__":
    unittest.main()
