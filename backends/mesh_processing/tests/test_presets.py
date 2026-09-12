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

    def test_game_ready_enables_spike_cleanup_and_taubin_smoothing(self):
        config = resolve_cleanup_config("game-ready", {})
        self.assertTrue(config.settings.spike_cleanup)
        self.assertTrue(config.settings.smooth_surface)
        self.assertGreater(config.settings.smoothing_iterations, 0)
        self.assertLess(config.settings.taubin_nu, 0.0)

    def test_advanced_override_becomes_custom(self):
        config = resolve_cleanup_config("game-ready", {"smoothing_iterations": 0})
        self.assertEqual(config.label, "Custom (from Game-ready)")
        self.assertEqual(config.settings.smoothing_iterations, 0)

    def test_algorithm_version_is_internal_nonempty_string(self):
        self.assertTrue(ALGORITHM_VERSION.startswith("mesh-cleanup-v"))

    def test_invalid_preset_raises(self):
        with self.assertRaisesRegex(ValueError, "Unsupported cleanup preset"):
            resolve_cleanup_config("destroy-everything", {})


if __name__ == "__main__":
    unittest.main()
