from __future__ import annotations

import types
import unittest
from unittest import mock

from backends.hunyuan import local_repaint as local_repaint_module
from backends.hunyuan.local_repaint import SdxlLocalRepaintBackend, resolve_model_snapshot


class LocalRepaintDownloadScopeTests(unittest.TestCase):
    def test_sdxl_loader_requests_only_required_snapshot_files(self) -> None:
        fake_torch = types.SimpleNamespace(float16=object())
        pipeline = mock.Mock()
        auto_pipeline = mock.Mock()
        auto_pipeline.from_pretrained.return_value = pipeline
        clip_vision = mock.Mock()
        clip_vision.from_pretrained.return_value = mock.Mock()
        calls: list[dict] = []

        def fake_resolve(repo_id: str, allow_download: bool = True, **kwargs):
            calls.append({"repo_id": repo_id, "allow_download": allow_download, **kwargs})
            return f"/models/{len(calls)}", False

        with mock.patch.object(
            local_repaint_module,
            "resolve_model_snapshot",
            side_effect=fake_resolve,
        ), mock.patch.object(
            local_repaint_module,
            "_load_repaint_runtime",
            return_value=(fake_torch, auto_pipeline, clip_vision),
        ):
            SdxlLocalRepaintBackend.load()

        self.assertEqual(len(calls), 2)
        self.assertEqual(
            set(calls[0]["allow_patterns"]),
            {
                "model_index.json",
                "scheduler/*",
                "tokenizer/*",
                "tokenizer_2/*",
                "text_encoder/config.json",
                "text_encoder/model.fp16.safetensors",
                "text_encoder_2/config.json",
                "text_encoder_2/model.fp16.safetensors",
                "unet/config.json",
                "unet/diffusion_pytorch_model.fp16.safetensors",
                "vae/config.json",
                "vae/diffusion_pytorch_model.fp16.safetensors",
            },
        )
        self.assertEqual(
            set(calls[1]["allow_patterns"]),
            {
                "models/image_encoder/config.json",
                "models/image_encoder/model.safetensors",
                "sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors",
            },
        )

    def test_prompt_only_loader_skips_ip_adapter_download_and_setup(self) -> None:
        fake_torch = types.SimpleNamespace(float16=object())
        pipeline = mock.Mock()
        auto_pipeline = mock.Mock()
        auto_pipeline.from_pretrained.return_value = pipeline
        clip_vision = mock.Mock()
        calls: list[dict] = []

        def fake_resolve(repo_id: str, allow_download: bool = True, **kwargs):
            calls.append({"repo_id": repo_id, "allow_download": allow_download, **kwargs})
            return "/models/sdxl", False

        with mock.patch.object(
            local_repaint_module,
            "resolve_model_snapshot",
            side_effect=fake_resolve,
        ), mock.patch.object(
            local_repaint_module,
            "_load_repaint_runtime",
            return_value=(fake_torch, auto_pipeline, clip_vision),
        ):
            SdxlLocalRepaintBackend.load(use_ip_adapter=False)

        self.assertEqual([call["repo_id"] for call in calls], [local_repaint_module.DEFAULT_LOCAL_REPAINT_MODEL])
        clip_vision.from_pretrained.assert_not_called()
        pipeline.load_ip_adapter.assert_not_called()

    def test_snapshot_scope_is_used_for_cache_probe_and_first_download(self) -> None:
        calls: list[dict] = []

        def fake_snapshot_download(repo_id: str, **kwargs):
            calls.append({"repo_id": repo_id, **kwargs})
            if kwargs.get("local_files_only"):
                raise FileNotFoundError("not cached")
            return "/hf-cache/model"

        with mock.patch.object(
            local_repaint_module,
            "snapshot_download",
            side_effect=fake_snapshot_download,
        ):
            path, cache_hit = resolve_model_snapshot(
                "demo/model",
                allow_download=True,
                allow_patterns=("config.json", "weights.safetensors"),
            )

        self.assertEqual(path, "/hf-cache/model")
        self.assertFalse(cache_hit)
        self.assertEqual(calls[0]["allow_patterns"], ("config.json", "weights.safetensors"))
        self.assertEqual(calls[1]["allow_patterns"], ("config.json", "weights.safetensors"))


if __name__ == "__main__":
    unittest.main()
