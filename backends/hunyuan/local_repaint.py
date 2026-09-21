"""Local Repaint validation, cache lifecycle and SDXL/IP-Adapter backend.

Heavy ML dependencies are imported lazily so worker protocol/validation tests do
not need torch, Diffusers or Transformers installed. Model weights are resolved
through the normal Hugging Face cache and downloaded only when they are absent.
"""

from __future__ import annotations

import argparse
import gc
import time
from pathlib import Path
from typing import Any, Callable, Protocol

from PIL import Image


DEFAULT_LOCAL_REPAINT_MODEL = "diffusers/stable-diffusion-xl-1.0-inpainting-0.1"
DEFAULT_IP_ADAPTER_MODEL = "h94/IP-Adapter"
IP_ADAPTER_WEIGHT = "ip-adapter-plus_sdxl_vit-h.safetensors"
REPAINT_MODEL_SIZE = (1024, 1024)
REPAINT_STEPS = 20
REPAINT_GUIDANCE_SCALE = 7.0
IP_ADAPTER_SCALE = 0.6


class LocalRepaintBackend(Protocol):
    model_id: str

    def repaint(
        self,
        source: Image.Image,
        mask: Image.Image,
        *,
        prompt: str | None,
        reference: Image.Image | None,
    ) -> Image.Image: ...


def snapshot_download(repo_id: str, **kwargs: Any) -> str:
    """Lazy Hugging Face wrapper kept patchable for download-free tests."""

    try:
        from huggingface_hub import snapshot_download as hf_snapshot_download  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "Local Repaint requires huggingface_hub. Install requirements-repaint.txt."
        ) from exc
    return str(hf_snapshot_download(repo_id=repo_id, **kwargs))


def resolve_model_snapshot(repo_id: str, allow_download: bool = True) -> tuple[str, bool]:
    """Resolve a model from the persistent HF cache, downloading only if absent.

    Returns ``(snapshot_path, disk_cache_hit)``. The first probe is always
    local-only so callers can report whether first-use network acquisition was
    required without performing a separate Hub metadata request.
    """

    try:
        return snapshot_download(repo_id, local_files_only=True), True
    except Exception as local_error:
        if not allow_download:
            raise RuntimeError(
                f"Model '{repo_id}' is not available in the local Hugging Face cache."
            ) from local_error

    return snapshot_download(repo_id), False


def _load_repaint_runtime() -> tuple[Any, Any, Any]:
    """Import the heavyweight runtime only on the production load path."""

    try:
        import torch  # type: ignore
        from diffusers import AutoPipelineForInpainting  # type: ignore
        from transformers import CLIPVisionModelWithProjection  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "Local Repaint runtime dependencies are missing. Install requirements-repaint.txt."
        ) from exc
    return torch, AutoPipelineForInpainting, CLIPVisionModelWithProjection


def _release_torch_memory() -> None:
    gc.collect()
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


class SdxlLocalRepaintBackend:
    """SDXL inpainting backend with optional IP-Adapter image guidance."""

    model_id = DEFAULT_LOCAL_REPAINT_MODEL

    def __init__(self, pipeline: Any) -> None:
        self.pipeline = pipeline

    @classmethod
    def load(cls, *, allow_download: bool = True) -> "SdxlLocalRepaintBackend":
        model_path, _ = resolve_model_snapshot(
            DEFAULT_LOCAL_REPAINT_MODEL,
            allow_download=allow_download,
        )
        adapter_path, _ = resolve_model_snapshot(
            DEFAULT_IP_ADAPTER_MODEL,
            allow_download=allow_download,
        )
        torch, auto_pipeline, clip_vision = _load_repaint_runtime()

        image_encoder = clip_vision.from_pretrained(
            adapter_path,
            subfolder="models/image_encoder",
            torch_dtype=torch.float16,
        )
        pipe = auto_pipeline.from_pretrained(
            model_path,
            torch_dtype=torch.float16,
            variant="fp16",
            use_safetensors=True,
            image_encoder=image_encoder,
        )
        pipe.load_ip_adapter(
            adapter_path,
            subfolder="sdxl_models",
            weight_name=IP_ADAPTER_WEIGHT,
        )
        pipe.set_ip_adapter_scale(IP_ADAPTER_SCALE)
        pipe.enable_attention_slicing()
        pipe.enable_vae_slicing()
        pipe.enable_vae_tiling()
        pipe.to("cuda")
        return cls(pipe)

    def repaint(
        self,
        source: Image.Image,
        mask: Image.Image,
        *,
        prompt: str | None,
        reference: Image.Image | None,
    ) -> Image.Image:
        if not prompt and reference is None:
            raise ValueError("Local Repaint requires a prompt or reference image.")

        source_rgba = source.convert("RGBA")
        mask_l = mask.convert("L")
        if source_rgba.size != mask_l.size:
            raise ValueError(
                f"Local Repaint mask dimensions {mask_l.size} do not match source dimensions {source_rgba.size}."
            )
        if mask_l.getbbox() is None:
            raise ValueError("Local Repaint mask is empty.")

        model_image = source_rgba.convert("RGB").resize(REPAINT_MODEL_SIZE, Image.Resampling.LANCZOS)
        model_mask = mask_l.resize(REPAINT_MODEL_SIZE, Image.Resampling.NEAREST)
        call_kwargs: dict[str, Any] = {
            "prompt": prompt or "",
            "image": model_image,
            "mask_image": model_mask,
            "num_inference_steps": REPAINT_STEPS,
            "guidance_scale": REPAINT_GUIDANCE_SCALE,
            "strength": 1.0,
        }
        if reference is not None:
            call_kwargs["ip_adapter_image"] = reference.convert("RGB").resize(
                REPAINT_MODEL_SIZE,
                Image.Resampling.LANCZOS,
            )

        pipeline_result = self.pipeline(**call_kwargs)
        images = getattr(pipeline_result, "images", None)
        if not images:
            raise RuntimeError("SDXL Local Repaint returned no image.")
        generated = images[0]
        if not isinstance(generated, Image.Image):
            raise TypeError("SDXL Local Repaint returned a non-image result.")

        generated_rgba = generated.convert("RGBA").resize(source_rgba.size, Image.Resampling.LANCZOS)

        # The model sees the binary mask, then we enforce the same boundary a
        # second time here. The frontend compositor performs the final
        # mask+feather transaction when the patch is accepted into the atlas.
        binary_mask = mask_l.point(lambda value: 255 if value > 0 else 0)
        return Image.composite(generated_rgba, source_rgba, binary_mask)

    def close(self) -> None:
        self.pipeline = None
        _release_torch_memory()


class LocalRepaintCache:
    """One-entry heavyweight repaint-model cache with explicit VRAM cleanup."""

    def __init__(self, event_sink: Callable[[dict[str, Any]], None] | None = None) -> None:
        self.backend: LocalRepaintBackend | None = None
        self.key: tuple[Any, ...] | None = None
        self.event_sink = event_sink

    def _event(self, stage: str, cache_hit: bool | None = None) -> None:
        if self.event_sink is None:
            return
        payload: dict[str, Any] = {
            "event": "cache",
            "stage": stage,
            "cache_kind": "local-repaint",
        }
        if cache_hit is not None:
            payload["cache_hit"] = cache_hit
        self.event_sink(payload)

    def get_or_create(
        self,
        key: tuple[Any, ...],
        loader: Callable[[], LocalRepaintBackend],
    ) -> tuple[LocalRepaintBackend, bool]:
        if self.backend is not None and self.key == key:
            self._event("cache_hit", True)
            return self.backend, True
        if self.backend is not None:
            self.clear(evicted=True)
        self._event("cache_miss", False)
        self.backend = loader()
        self.key = key
        return self.backend, False

    def clear(self, *, evicted: bool = False) -> None:
        if self.backend is None:
            self.key = None
            return
        backend = self.backend
        self.backend = None
        self.key = None
        close = getattr(backend, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass
        del backend
        _release_torch_memory()
        self._event("evicted_local_repaint" if evicted else "cache_cleared")


def get_sdxl_backend() -> LocalRepaintBackend:
    """Production backend factory for the persistent worker cache."""

    return SdxlLocalRepaintBackend.load()


def classify_local_repaint_error(exc: Exception) -> str:
    text = f"{type(exc).__name__}: {exc}".lower()
    if any(
        marker in text
        for marker in (
            "out of memory",
            "cuda out of memory",
            "hip out of memory",
            "rocm out of memory",
            "memoryerror",
        )
    ):
        return "out_of_memory"
    if isinstance(exc, (FileNotFoundError, ValueError)):
        return "invalid_input"
    return "local_repaint_error"


def _emit(
    emit_fn: Callable[[dict[str, Any]], None] | None,
    event: str,
    **values: Any,
) -> None:
    payload = {"event": event, **values}
    if emit_fn is None:
        return
    emit_fn(payload)


def _invalid(
    emit_fn: Callable[[dict[str, Any]], None] | None,
    message: str,
) -> int:
    _emit(
        emit_fn,
        "error",
        ok=False,
        stage="preparing_repaint",
        error_kind="invalid_input",
        error=message,
    )
    return 2


def _open_rgba(path: Path) -> Image.Image:
    with Image.open(path) as image:
        return image.convert("RGBA")


def _open_mask(path: Path) -> Image.Image:
    with Image.open(path) as image:
        return image.convert("L")


def run_local_repaint(
    args: argparse.Namespace,
    cache: Any | None = None,
    *,
    emit_fn: Callable[[dict[str, Any]], None] | None = None,
    backend_factory: Callable[[], LocalRepaintBackend] | None = None,
) -> int:
    source_path = Path(str(args.source)).expanduser().resolve()
    mask_path = Path(str(args.mask)).expanduser().resolve()
    output_path = Path(str(args.output)).expanduser().resolve()
    prompt = str(getattr(args, "prompt", "") or "").strip() or None
    reference_raw = str(getattr(args, "reference_image", "") or "").strip()
    reference_path = Path(reference_raw).expanduser().resolve() if reference_raw else None

    if not source_path.is_file():
        return _invalid(emit_fn, f"Local Repaint source PNG does not exist: {source_path}")
    if not mask_path.is_file():
        return _invalid(emit_fn, f"Local Repaint mask PNG does not exist: {mask_path}")
    if not prompt and reference_path is None:
        return _invalid(emit_fn, "Local Repaint requires a prompt or reference image.")
    if reference_path is not None and not reference_path.is_file():
        return _invalid(emit_fn, f"Local Repaint reference image does not exist: {reference_path}")
    if output_path in {source_path, mask_path}:
        return _invalid(emit_fn, "Local Repaint output path must differ from source and mask paths.")

    try:
        source = _open_rgba(source_path)
        mask = _open_mask(mask_path)
    except Exception as exc:
        return _invalid(emit_fn, f"Could not decode Local Repaint source or mask: {type(exc).__name__}: {exc}")

    if mask.size != source.size:
        source.close()
        mask.close()
        return _invalid(
            emit_fn,
            f"Local Repaint mask dimensions {mask.size} do not match source dimensions {source.size}.",
        )
    if mask.getbbox() is None:
        source.close()
        mask.close()
        return _invalid(emit_fn, "Local Repaint mask is empty.")

    reference: Image.Image | None = None
    if reference_path is not None:
        try:
            reference = _open_rgba(reference_path)
        except Exception as exc:
            source.close()
            mask.close()
            return _invalid(
                emit_fn,
                f"Could not decode Local Repaint reference image: {type(exc).__name__}: {exc}",
            )

    _emit(emit_fn, "progress", ok=True, stage="preparing_repaint", progress=0.05)

    repaint_cache: LocalRepaintCache
    if cache is not None and isinstance(getattr(cache, "local_repaint_cache", None), LocalRepaintCache):
        repaint_cache = cache.local_repaint_cache
    else:
        repaint_cache = LocalRepaintCache()

    if cache is not None:
        clear_shape = getattr(cache, "clear_shape", None)
        clear_texture = getattr(cache, "clear_texture", None)
        if callable(clear_shape):
            clear_shape(evicted=True)
        if callable(clear_texture):
            clear_texture(evicted=True)

    factory = backend_factory or get_sdxl_backend
    model_load_started = time.perf_counter()
    cache_hit = False
    backend: LocalRepaintBackend | None = None
    model_id = DEFAULT_LOCAL_REPAINT_MODEL
    try:
        # This is deliberately emitted before the factory is called because the
        # factory may perform the first-use Hugging Face download.
        _emit(
            emit_fn,
            "progress",
            ok=True,
            stage="loading_repaint_model",
            progress=0.15,
            model=model_id,
        )
        backend, cache_hit = repaint_cache.get_or_create(
            (DEFAULT_LOCAL_REPAINT_MODEL, DEFAULT_IP_ADAPTER_MODEL),
            factory,
        )
        model_id = str(getattr(backend, "model_id", DEFAULT_LOCAL_REPAINT_MODEL))
        model_load_ms = (time.perf_counter() - model_load_started) * 1000.0
        _emit(
            emit_fn,
            "cache",
            ok=True,
            stage="cache_hit" if cache_hit else "cache_miss",
            cache_hit=cache_hit,
            cache_kind="local-repaint",
            model=model_id,
            model_load_ms=round(model_load_ms, 3),
        )

        _emit(
            emit_fn,
            "progress",
            ok=True,
            stage="running_repaint",
            progress=0.35,
            model=model_id,
            cache_hit=cache_hit,
            cache_kind="local-repaint",
        )
        inference_started = time.perf_counter()
        edited = backend.repaint(
            source,
            mask,
            prompt=prompt,
            reference=reference,
        )
        inference_ms = (time.perf_counter() - inference_started) * 1000.0
        if not isinstance(edited, Image.Image):
            raise TypeError("Local Repaint backend returned a non-image result.")
        edited = edited.convert("RGBA")
        if edited.size != source.size:
            raise ValueError(
                f"Local Repaint backend returned dimensions {edited.size}; expected {source.size}."
            )

        _emit(
            emit_fn,
            "progress",
            ok=True,
            stage="writing_repaint",
            progress=0.90,
            model=model_id,
        )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_output = output_path.with_name(f".{output_path.name}.tmp.png")
        edited.save(temporary_output, format="PNG")
        temporary_output.replace(output_path)

        _emit(
            emit_fn,
            "completed",
            ok=True,
            stage="completed",
            progress=1.0,
            output=str(output_path),
            model=model_id,
            cache_hit=cache_hit,
            cache_kind="local-repaint",
            model_load_ms=round(model_load_ms, 3),
            inference_ms=round(inference_ms, 3),
        )
        return 0
    except Exception as exc:
        error_kind = classify_local_repaint_error(exc)
        if error_kind == "out_of_memory":
            repaint_cache.clear()
            _release_torch_memory()
        _emit(
            emit_fn,
            "error",
            ok=False,
            stage="local_repaint",
            error_kind=error_kind,
            error=f"{type(exc).__name__}: {exc}",
            model=model_id,
            cache_hit=cache_hit,
            cache_kind="local-repaint",
            model_load_ms=round((time.perf_counter() - model_load_started) * 1000.0, 3),
        )
        return 1
    finally:
        source.close()
        mask.close()
        if reference is not None:
            reference.close()
