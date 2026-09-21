"""Local Repaint validation, cache lifecycle and backend adapter seam.

The real SDXL/IP-Adapter implementation is intentionally loaded lazily by
``get_sdxl_backend``.  This module owns the stable worker contract so protocol,
validation and cache behavior remain testable without torch/diffusers.
"""

from __future__ import annotations

import argparse
import gc
import time
from pathlib import Path
from typing import Any, Callable, Protocol

from PIL import Image


DEFAULT_LOCAL_REPAINT_MODEL = "diffusers/stable-diffusion-xl-1.0-inpainting-0.1"


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


def _release_torch_memory() -> None:
    gc.collect()
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


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
    """Production backend factory; Task 6 replaces this placeholder lazily."""

    raise RuntimeError(
        "Local Repaint model backend is not installed yet. Install the repaint runtime dependencies."
    )


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
        return _invalid(
            emit_fn,
            f"Local Repaint mask dimensions {mask.size} do not match source dimensions {source.size}.",
        )
    if mask.getbbox() is None:
        return _invalid(emit_fn, "Local Repaint mask is empty.")

    reference: Image.Image | None = None
    if reference_path is not None:
        try:
            reference = _open_rgba(reference_path)
        except Exception as exc:
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
        _emit(
            emit_fn,
            "progress",
            ok=True,
            stage="loading_repaint_model",
            progress=0.15,
            model=model_id,
        )
        backend, cache_hit = repaint_cache.get_or_create(
            (DEFAULT_LOCAL_REPAINT_MODEL,),
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
