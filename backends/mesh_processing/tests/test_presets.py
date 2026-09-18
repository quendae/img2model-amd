import unittest

from backends.mesh_processing.presets import ALGORITHM_VERSION, resolve_cleanup_config


class CleanupPresetTests(unittest.TestCase):
    def test_light_is_conservative(self):
        config = resolve_cleanup_config("light", {})
        self.assertEqual(config.label, "Light")
        self.assertTrue(config.settings.remove_degenerate)
        self.assertTrue(config.settings.remove_small_islands)
        self.assertTrue(config.settings.weld_vertices)
        self.assertFalse(config.settings.spike_cleanup)
        self.assertFalse(config.settings.smooth_surface)
        self.assertEqual(config.settings.triangle_budget_mode, "auto")
        self.assertIsNone(config.settings.target_triangles)

    def test_game_ready_defaults_to_auto_triangle_budget(self):
        config = resolve_cleanup_config("game-ready", {})
        self.assertEqual(config.settings.triangle_budget_mode, "auto")
        self.assertIsNone(config.settings.target_triangles)

    def test_manual_triangle_override_becomes_custom(self):
        config = resolve_cleanup_config(
            "game-ready",
            {"triangle_budget_mode": "manual", "target_triangles": 5000},
        )
        self.assertEqual(config.label, "Custom (from Game-ready)")
        self.assertEqual(config.settings.triangle_budget_mode, "manual")
        self.assertEqual(config.settings.target_triangles, 5000)

    def test_algorithm_version_is_v7_for_fast_winding_path(self):
        self.assertEqual(ALGORITHM_VERSION, "mesh-cleanup-v7")

    def test_invalid_manual_triangle_budget_raises(self):
        with self.assertRaisesRegex(ValueError, "target_triangles"):
            resolve_cleanup_config(
                "game-ready",
                {"triangle_budget_mode": "manual", "target_triangles": 100},
            )

    def test_invalid_preset_raises(self):
        with self.assertRaisesRegex(ValueError, "Unsupported cleanup preset"):
            resolve_cleanup_config("destroy-everything", {})


if __name__ == "__main__":
    unittest.main()
