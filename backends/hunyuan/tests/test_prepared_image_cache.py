import importlib.util
import tempfile
import unittest
from pathlib import Path


WORKER = Path(__file__).resolve().parents[1] / "worker.py"


class FakeImage:
    def __init__(self, value: str) -> None:
        self.value = value

    def copy(self):
        return FakeImage(self.value)


class PreparedImageCacheTests(unittest.TestCase):
    def load_worker_module(self):
        spec = importlib.util.spec_from_file_location("img2model_hunyuan_worker_image_cache", WORKER)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_cache_key_changes_when_background_removal_changes(self) -> None:
        module = self.load_worker_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "source.png"
            image_path.write_bytes(b"image")
            keep_background = module.prepared_image_cache_key(image_path, False)
            remove_background = module.prepared_image_cache_key(image_path, True)
        self.assertNotEqual(keep_background, remove_background)

    def test_prepared_image_cache_returns_fresh_copy_on_hit(self) -> None:
        module = self.load_worker_module()
        events: list[dict[str, object]] = []
        cache = module.PipelineCache(event_sink=events.append)
        loads = 0

        def loader():
            nonlocal loads
            loads += 1
            return FakeImage("prepared")

        first, first_hit = cache.get_prepared_image(loader, ("source", True))
        second, second_hit = cache.get_prepared_image(loader, ("source", True))

        self.assertFalse(first_hit)
        self.assertTrue(second_hit)
        self.assertEqual(loads, 1)
        self.assertEqual(first.value, "prepared")
        self.assertEqual(second.value, "prepared")
        self.assertIsNot(first, second)
        self.assertIsNot(first, cache.prepared_image)
        self.assertIsNot(second, cache.prepared_image)
        self.assertTrue(
            any(
                event.get("stage") == "cache_hit"
                and event.get("cache_kind") == "prepared_image"
                for event in events
            )
        )

    def test_load_or_prepare_texture_image_reuses_background_removed_image(self) -> None:
        module = self.load_worker_module()
        cache = module.PipelineCache()
        calls: list[str] = []

        class BackgroundRemover:
            def __call__(self, image):
                calls.append("remove-background")
                return FakeImage(f"removed:{image.value}")

        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "source.png"
            image_path.write_bytes(b"image")

            def load_image(path: Path):
                calls.append(f"load:{path.name}")
                return FakeImage("rgba")

            first, first_hit = module.load_or_prepare_texture_image(
                image_path,
                remove_background=True,
                cache=cache,
                load_image=load_image,
                background_remover_cls=BackgroundRemover,
            )
            second, second_hit = module.load_or_prepare_texture_image(
                image_path,
                remove_background=True,
                cache=cache,
                load_image=load_image,
                background_remover_cls=BackgroundRemover,
            )

        self.assertFalse(first_hit)
        self.assertTrue(second_hit)
        self.assertEqual(first.value, "removed:rgba")
        self.assertEqual(second.value, "removed:rgba")
        self.assertEqual(calls, ["load:source.png", "remove-background"])

    def test_clear_releases_prepared_image(self) -> None:
        module = self.load_worker_module()
        cache = module.PipelineCache()
        cache.get_prepared_image(lambda: FakeImage("prepared"), ("source", True))
        cache.clear()
        self.assertIsNone(cache.prepared_image)
        self.assertIsNone(cache.prepared_image_key)


if __name__ == "__main__":
    unittest.main()
