from __future__ import annotations

import argparse
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

from backends.hunyuan import worker
from backends.hunyuan.local_repaint import LocalRepaintCache, run_local_repaint


class FakeLocalRepaintBackend:
    model_id = "fake/local-repaint"

    def __init__(self, *, fail: Exception | None = None) -> None:
        self.fail = fail
        self.calls = 0

    def repaint(self, source, mask, *, prompt, reference):
        self.calls += 1
        if self.fail is not None:
            raise self.fail
        result = source.convert("RGBA").copy()
        source_pixels = result.load()
        mask_pixels = mask.convert("L").load()
        for y in range(result.height):
            for x in range(result.width):
                if mask_pixels[x, y] > 0:
                    source_pixels[x, y] = (240, 20, 30, 255)
        return result


class FakePipelineCache:
    def __init__(self) -> None:
        self.local_repaint_cache = LocalRepaintCache()
        self.shape_evicted = 0
        self.texture_evicted = 0

    def clear_shape(self, *, evicted=False):
        if evicted:
            self.shape_evicted += 1

    def clear_texture(self, *, evicted=False):
        if evicted:
            self.texture_evicted += 1


def make_images(root: Path, *, mask_size=(4, 4), non_empty=True) -> tuple[Path, Path]:
    source = root / "source.png"
    mask = root / "mask.png"
    Image.new("RGBA", (4, 4), (10, 20, 30, 255)).save(source)
    mask_image = Image.new("L", mask_size, 0)
    if non_empty and mask_size[0] > 1 and mask_size[1] > 1:
        mask_image.putpixel((1, 1), 255)
    mask_image.save(mask)
    return source, mask


def repaint_args(root: Path, **overrides) -> argparse.Namespace:
    source_override = overrides.pop("source", None)
    mask_override = overrides.pop("mask", None)
    if (source_override is None) != (mask_override is None):
        raise ValueError("Test helper requires both source and mask overrides, or neither.")
    if source_override is None:
        source, mask = make_images(root)
        source_value = str(source)
        mask_value = str(mask)
    else:
        source_value = str(source_override)
        mask_value = str(mask_override)

    values = {
        "source": source_value,
        "mask": mask_value,
        "output": str(root / "edited.png"),
        "prompt": "red leather",
        "reference_image": None,
        "feather_px": 8,
    }
    values.update(overrides)
    return argparse.Namespace(**values)


class LocalRepaintWorkerTests(unittest.TestCase):
    def run_job(self, args, backend, cache=None):
        events: list[dict] = []
        cache = cache or FakePipelineCache()
        code = run_local_repaint(
            args,
            cache=cache,
            emit_fn=events.append,
            backend_factory=lambda: backend,
        )
        return code, events, cache

    def test_request_rejects_neither_prompt_nor_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = repaint_args(root, prompt=None, reference_image=None)
            code, events, _ = self.run_job(args, FakeLocalRepaintBackend())
        self.assertEqual(code, 2)
        self.assertEqual(events[-1]["error_kind"], "invalid_input")

    def test_request_rejects_missing_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = repaint_args(root)
            Path(args.source).unlink()
            code, events, _ = self.run_job(args, FakeLocalRepaintBackend())
        self.assertEqual(code, 2)
        self.assertEqual(events[-1]["error_kind"], "invalid_input")

    def test_request_rejects_mismatched_mask_dimensions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, mask = make_images(root, mask_size=(3, 4))
            args = repaint_args(root, source=str(source), mask=str(mask))
            code, events, _ = self.run_job(args, FakeLocalRepaintBackend())
        self.assertEqual(code, 2)
        self.assertIn("dimensions", events[-1]["error"].lower())

    def test_request_rejects_empty_mask(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, mask = make_images(root, non_empty=False)
            args = repaint_args(root, source=str(source), mask=str(mask))
            code, events, _ = self.run_job(args, FakeLocalRepaintBackend())
        self.assertEqual(code, 2)
        self.assertIn("empty", events[-1]["error"].lower())

    def test_request_rejects_missing_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = repaint_args(root, prompt=None, reference_image=str(root / "missing.png"))
            code, events, _ = self.run_job(args, FakeLocalRepaintBackend())
        self.assertEqual(code, 2)
        self.assertEqual(events[-1]["error_kind"], "invalid_input")

    def test_fake_backend_changes_only_masked_pixel_and_preserves_dimensions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = repaint_args(root)
            backend = FakeLocalRepaintBackend()
            code, events, cache = self.run_job(args, backend)
            self.assertEqual(code, 0)
            with Image.open(args.output) as result:
                rgba = result.convert("RGBA")
                self.assertEqual(rgba.size, (4, 4))
                self.assertEqual(rgba.getpixel((1, 1)), (240, 20, 30, 255))
                self.assertEqual(rgba.getpixel((0, 0)), (10, 20, 30, 255))
            self.assertEqual(events[-1]["event"], "completed")
            self.assertEqual(events[-1]["model"], "fake/local-repaint")
            self.assertEqual(events[-1]["cache_kind"], "local-repaint")
            self.assertEqual(cache.shape_evicted, 1)
            self.assertEqual(cache.texture_evicted, 1)

    def test_backend_is_cached_for_second_request(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = FakePipelineCache()
            backend = FakeLocalRepaintBackend()
            factory_calls = 0

            def factory():
                nonlocal factory_calls
                factory_calls += 1
                return backend

            first_events: list[dict] = []
            second_events: list[dict] = []
            args = repaint_args(root)
            self.assertEqual(run_local_repaint(args, cache=cache, emit_fn=first_events.append, backend_factory=factory), 0)
            self.assertEqual(run_local_repaint(args, cache=cache, emit_fn=second_events.append, backend_factory=factory), 0)

            self.assertEqual(factory_calls, 1)
            self.assertFalse(first_events[-1]["cache_hit"])
            self.assertTrue(second_events[-1]["cache_hit"])

    def test_oom_clears_repaint_cache_and_maps_error_kind(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = FakePipelineCache()
            backend = FakeLocalRepaintBackend(fail=RuntimeError("HIP out of memory"))
            code, events, cache = self.run_job(repaint_args(root), backend, cache=cache)
            self.assertEqual(code, 1)
            self.assertEqual(events[-1]["error_kind"], "out_of_memory")
            self.assertIsNone(cache.local_repaint_cache.backend)

    def test_shape_and_texture_pipeline_loads_evict_repaint_cache(self):
        cache = worker.PipelineCache()
        cached_backend = FakeLocalRepaintBackend()
        cache.local_repaint_cache.get_or_create(("fake",), lambda: cached_backend)
        cache.get_shape_pipeline(lambda: object(), ("shape",))
        self.assertIsNone(cache.local_repaint_cache.backend)

        cache.local_repaint_cache.get_or_create(("fake",), lambda: cached_backend)
        cache.get_texture_pipeline(lambda: object(), ("texture",))
        self.assertIsNone(cache.local_repaint_cache.backend)

    def test_serve_dispatch_keeps_job_id_for_local_repaint_terminal_event(self):
        events: list[dict] = []
        message = {
            "command": "local_repaint",
            "job_id": "job-repaint-77",
            "request": {
                "source": "source.png",
                "mask": "mask.png",
                "output": "edited.png",
                "prompt": "red leather",
                "referenceImage": None,
                "featherPx": 8,
            },
        }

        def fake_run(_args, cache=None, emit_fn=None, backend_factory=None):
            worker.emit("completed", ok=True, stage="completed", output="edited.png")
            return 0

        with mock.patch.object(worker, "run_local_repaint", side_effect=fake_run):
            handled = worker.dispatch_serve_command(
                message,
                cache=worker.PipelineCache(),
                emit_fn=events.append,
            )

        self.assertTrue(handled)
        self.assertEqual(events[-1]["job_id"], "job-repaint-77")
        self.assertEqual(events[-1]["event"], "completed")


if __name__ == "__main__":
    unittest.main()
