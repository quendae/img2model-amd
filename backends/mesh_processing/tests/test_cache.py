import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from backends.mesh_processing.cache import CleanupMeshCache, cleanup_cache_key
from backends.mesh_processing.presets import resolve_cleanup_config


class CleanupCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "source.glb"
        self.path.write_bytes(b"mesh")

    def test_preset_changes_key(self):
        light = cleanup_cache_key(self.path, resolve_cleanup_config("light", {}))
        game = cleanup_cache_key(self.path, resolve_cleanup_config("game-ready", {}))
        self.assertNotEqual(light, game)

    def test_override_changes_key(self):
        stock = cleanup_cache_key(self.path, resolve_cleanup_config("game-ready", {}))
        custom = cleanup_cache_key(
            self.path,
            resolve_cleanup_config(
                "game-ready",
                {"triangle_budget_mode": "manual", "target_triangles": 5000},
            ),
        )
        self.assertNotEqual(stock, custom)

    def test_auto_and_manual_triangle_budget_have_distinct_keys(self):
        auto = cleanup_cache_key(self.path, resolve_cleanup_config("game-ready", {}))
        manual = cleanup_cache_key(
            self.path,
            resolve_cleanup_config(
                "game-ready",
                {"triangle_budget_mode": "manual", "target_triangles": 5000},
            ),
        )
        manual_other = cleanup_cache_key(
            self.path,
            resolve_cleanup_config(
                "game-ready",
                {"triangle_budget_mode": "manual", "target_triangles": 6000},
            ),
        )
        self.assertNotEqual(auto, manual)
        self.assertNotEqual(manual, manual_other)

    def test_file_mtime_changes_key(self):
        first = cleanup_cache_key(self.path, resolve_cleanup_config("light", {}))
        stat = self.path.stat()
        os.utime(self.path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
        second = cleanup_cache_key(self.path, resolve_cleanup_config("light", {}))
        self.assertNotEqual(first, second)

    def test_cache_returns_copies_and_reports_hit(self):
        class FakeMesh:
            def __init__(self, value):
                self.value = value

            def copy(self):
                return FakeMesh(self.value)

        cache = CleanupMeshCache()
        calls = []

        def loader():
            calls.append(1)
            return FakeMesh(7), {"warnings": []}

        first_mesh, first_report, first_hit = cache.get_or_create(("key",), loader)
        second_mesh, second_report, second_hit = cache.get_or_create(("key",), loader)
        first_mesh.value = 99
        first_report["warnings"].append("mutated")

        self.assertFalse(first_hit)
        self.assertTrue(second_hit)
        self.assertEqual(len(calls), 1)
        self.assertEqual(second_mesh.value, 7)
        self.assertEqual(second_report["warnings"], [])


if __name__ == "__main__":
    unittest.main()
