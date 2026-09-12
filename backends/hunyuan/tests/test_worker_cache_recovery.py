import importlib.util
import unittest
from pathlib import Path


WORKER = Path(__file__).resolve().parents[1] / "worker.py"


class WorkerCacheRecoveryTests(unittest.TestCase):
    def load_worker_module(self):
        spec = importlib.util.spec_from_file_location("img2model_hunyuan_worker_cache_recovery", WORKER)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_texture_oom_clears_only_texture_cache(self) -> None:
        module = self.load_worker_module()
        cache = module.PipelineCache()
        texture = object()
        cache.get_texture_pipeline(lambda: texture, ("texture",))

        module.recover_pipeline_cache_after_error(cache, "texture", "out_of_memory")

        self.assertIsNone(cache.texture_pipeline)
        self.assertIsNone(cache.shape_pipeline)

    def test_shape_oom_clears_shape_cache(self) -> None:
        module = self.load_worker_module()
        cache = module.PipelineCache()
        shape = object()
        cache.get_shape_pipeline(lambda: shape, ("shape",))

        module.recover_pipeline_cache_after_error(cache, "shape", "out_of_memory")

        self.assertIsNone(cache.shape_pipeline)

    def test_regular_worker_error_keeps_reusable_texture_cache(self) -> None:
        module = self.load_worker_module()
        cache = module.PipelineCache()
        texture = object()
        cache.get_texture_pipeline(lambda: texture, ("texture",))

        module.recover_pipeline_cache_after_error(cache, "texture", "worker_error")

        self.assertIs(cache.texture_pipeline, texture)

    def test_recovery_is_a_noop_without_persistent_cache(self) -> None:
        module = self.load_worker_module()
        module.recover_pipeline_cache_after_error(None, "texture", "out_of_memory")


if __name__ == "__main__":
    unittest.main()
