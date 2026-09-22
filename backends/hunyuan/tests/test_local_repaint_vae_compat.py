from __future__ import annotations

import types
import unittest
from unittest import mock

from backends.hunyuan import local_repaint as local_repaint_module
from backends.hunyuan.local_repaint import SdxlLocalRepaintBackend


class _FakeVae:
    def __init__(self) -> None:
        self.slicing_calls = 0
        self.tiling_calls = 0

    def enable_slicing(self) -> None:
        self.slicing_calls += 1

    def enable_tiling(self) -> None:
        self.tiling_calls += 1


class _DiffusersCompatiblePipeline:
    """Matches the installed SDXL pipeline API observed on RX 6950 XT.

    VAE memory helpers live on ``pipeline.vae`` instead of the pipeline itself.
    Deliberately does not define enable_vae_slicing/enable_vae_tiling.
    """

    def __init__(self) -> None:
        self.vae = _FakeVae()
        self.attention_slicing_calls = 0
        self.to_calls: list[str] = []

    def enable_attention_slicing(self) -> None:
        self.attention_slicing_calls += 1

    def to(self, device: str):
        self.to_calls.append(device)
        return self


class LocalRepaintVaeCompatibilityTests(unittest.TestCase):
    def test_loader_uses_vae_component_helpers_when_pipeline_helpers_are_missing(self) -> None:
        fake_torch = types.SimpleNamespace(float16=object())
        pipeline = _DiffusersCompatiblePipeline()
        auto_pipeline = mock.Mock()
        auto_pipeline.from_pretrained.return_value = pipeline
        clip_vision = mock.Mock()

        with mock.patch.object(
            local_repaint_module,
            "resolve_model_snapshot",
            return_value=("/models/sdxl", True),
        ), mock.patch.object(
            local_repaint_module,
            "_load_repaint_runtime",
            return_value=(fake_torch, auto_pipeline, clip_vision),
        ):
            backend = SdxlLocalRepaintBackend.load(use_ip_adapter=False)

        self.assertIs(backend.pipeline, pipeline)
        self.assertEqual(pipeline.attention_slicing_calls, 1)
        self.assertEqual(pipeline.vae.slicing_calls, 1)
        self.assertEqual(pipeline.vae.tiling_calls, 1)
        self.assertEqual(pipeline.to_calls, ["cuda"])


if __name__ == "__main__":
    unittest.main()
