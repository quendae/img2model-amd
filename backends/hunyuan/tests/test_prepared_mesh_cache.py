import importlib.util
import os
import tempfile
import unittest
from pathlib import Path


WORKER = Path(__file__).resolve().parents[1] / "worker.py"


class CloneableMesh:
    def __init__(self, label: str) -> None:
        self.label = label

    def copy(self):
        return CloneableMesh(self.label)


class PreparedMeshCacheTests(unittest.TestCase):
    def load_worker_module(self):
        spec = importlib.util.spec_from_file_location("img2model_hunyuan_worker_prepared_cache", WORKER)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_reuses_same_prepared_mesh_key_without_rerunning_loader(self) -> None:
        module = self.load_worker_module()
        events: list[dict[str, object]] = []
        cache = module.PipelineCache(event_sink=events.append)
        calls = 0

        def loader():
            nonlocal calls
            calls += 1
            return CloneableMesh("prepared"), 604_308, 20_000

        first, first_hit, first_before, first_after = cache.get_prepared_mesh(
            loader,
            ("C:/shape.glb", 123, 456, 20_000),
        )
        second, second_hit, second_before, second_after = cache.get_prepared_mesh(
            loader,
            ("C:/shape.glb", 123, 456, 20_000),
        )

        self.assertEqual(calls, 1)
        self.assertFalse(first_hit)
        self.assertTrue(second_hit)
        self.assertIsNot(first, second)
        self.assertEqual(first.label, "prepared")
        self.assertEqual(second.label, "prepared")
        self.assertEqual((first_before, first_after), (604_308, 20_000))
        self.assertEqual((second_before, second_after), (604_308, 20_000))
        self.assertTrue(
            any(
                event.get("stage") == "cache_hit" and event.get("cache_kind") == "prepared_mesh"
                for event in events
            )
        )

    def test_reloads_prepared_mesh_when_key_changes(self) -> None:
        module = self.load_worker_module()
        cache = module.PipelineCache()
        calls = 0

        def loader():
            nonlocal calls
            calls += 1
            return CloneableMesh(f"prepared-{calls}"), 604_308, 20_000

        first, first_hit, _, _ = cache.get_prepared_mesh(loader, ("mesh", 1, 2, 20_000))
        second, second_hit, _, _ = cache.get_prepared_mesh(loader, ("mesh", 1, 2, 40_000))

        self.assertFalse(first_hit)
        self.assertFalse(second_hit)
        self.assertEqual(calls, 2)
        self.assertEqual(first.label, "prepared-1")
        self.assertEqual(second.label, "prepared-2")

    def test_prepared_mesh_key_changes_with_file_identity_or_triangle_budget(self) -> None:
        module = self.load_worker_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            mesh_path = Path(temp_dir) / "mesh.glb"
            mesh_path.write_bytes(b"mesh-a")

            key_20k = module.prepared_mesh_cache_key(mesh_path, 20_000)
            key_40k = module.prepared_mesh_cache_key(mesh_path, 40_000)
            self.assertNotEqual(key_20k, key_40k)

            mesh_path.write_bytes(b"mesh-a-expanded")
            os.utime(mesh_path, None)
            key_changed_file = module.prepared_mesh_cache_key(mesh_path, 20_000)
            self.assertNotEqual(key_20k, key_changed_file)

    def test_clear_releases_prepared_mesh_entry(self) -> None:
        module = self.load_worker_module()
        cache = module.PipelineCache()
        cache.get_prepared_mesh(
            lambda: (CloneableMesh("prepared"), 604_308, 20_000),
            ("mesh", 1, 2, 20_000),
        )

        cache.clear()

        self.assertIsNone(cache.prepared_mesh)
        self.assertIsNone(cache.prepared_mesh_key)


if __name__ == "__main__":
    unittest.main()
