#!/usr/bin/env python3
"""Img2Model AMD worker entry point with reusable mesh-cleanup orchestration.

The legacy Hunyuan shape/texture implementation lives in ``worker_base``.
This entry point keeps that behavior intact while adding CPU-side mesh cleanup,
persistent Shape preloading and Local Repaint lifecycle orchestration.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Callable


def _ensure_backend_package_path() -> None:
    current = Path(__file__).resolve()
    module_dir = str(current.parent)
    if module_dir not in sys.path:
        sys.path.insert(0, module_dir)
    for parent in current.parents:
        if (parent / "backends" / "mesh_processing").is_dir():
            value = str(parent)
            if value not in sys.path:
                sys.path.insert(0, value)
            return


_ensure_backend_package_path()

if __package__:
    from . import worker_base as _base
    from .local_repaint import LocalRepaintCache, run_local_repaint
else:
    import worker_base as _base  # type: ignore
    from local_repaint import LocalRepaintCache, run_local_repaint  # type: ignore

# Preserve the established worker module surface for existing imports/tests.
for _name in dir(_base):
    if not _name.startswith("__"):
        globals()[_name] = getattr(_base, _name)

from backends.mesh_processing.cache import CleanupMeshCache, cleanup_cache_key
from backends.mesh_processing.cleanup import cleanup_mesh
from backends.mesh_processing.io import export_mesh_atomic, load_mesh
from backends.mesh_processing.presets import resolve_cleanup_config

PROTOCOL_VERSION = 2
_base.PROTOCOL_VERSION = PROTOCOL_VERSION

_BasePipelineCache = _base.PipelineCache
_original_dispatch_serve_command = _base.dispatch_serve_command
_original_build_parser = _base.build_parser
_original_run_generate = _base.run_generate
_original_run_texture = _base.run_texture
_original_build_texture_pipeline = _base.build_texture_pipeline
_original_texture_namespace = _base._texture_namespace
_original_emit = _base.emit
_shape_debug_stage: str | None = None
_texture_debug_stage: str | None = None
_texture_style_context: dict[str, Any] = {
    'preset': 'match-source',
    'strength': 1.0,
    'preserve_source_colors': True,
    'style_reference': None,
}

_SHAPE_DEBUG_STAGES = {
    "starting_backend": "opening_input",
    "preparing_input": "background_removal",
    "loading_model": "model_cache",
    "running_shape": "pipeline_call",
    "postprocessing": "export",
}

_TEXTURE_DEBUG_STAGES = {
    "starting_backend": "runtime_setup",
    "preparing_input": "image_preprocess",
    "preparing_mesh": "mesh_preprocess",
    "mesh_ready": "mesh_ready",
    "loading_model": "model_load",
    "running_texture": "paint_inference",
    "postprocessing": "texture_export",
}


def _enrich_failure(values: dict[str, Any], debug_stage: str, fallback_message: str) -> None:
    formatted_traceback = traceback.format_exc()
    if formatted_traceback.strip() == "NoneType: None":
        formatted_traceback = ""
    values.setdefault("debug_stage", debug_stage)
    if formatted_traceback:
        values.setdefault("traceback", formatted_traceback)
    error_text = str(values.get("error") or fallback_message)
    technical_parts = [error_text, f"Debug stage: {debug_stage}"]
    if formatted_traceback:
        technical_parts.append(formatted_traceback.rstrip())
    values["error"] = "\n\n".join(technical_parts)


def _diagnostic_emit(event: str, **values: Any) -> None:
    """Keep normal events while enriching Shape and Texture failures with context."""

    global _shape_debug_stage, _texture_debug_stage
    stage = values.get("stage")
    if event == "progress" and isinstance(stage, str):
        if stage in _SHAPE_DEBUG_STAGES:
            _shape_debug_stage = _SHAPE_DEBUG_STAGES[stage]
        if stage in _TEXTURE_DEBUG_STAGES:
            _texture_debug_stage = _TEXTURE_DEBUG_STAGES[stage]
    elif event == "completed" and stage == "completed":
        _shape_debug_stage = None
        _texture_debug_stage = None
    elif event == "error" and stage == "shape":
        debug_stage = _shape_debug_stage or "shape"
        _enrich_failure(values, debug_stage, "Shape generation failed")
        _shape_debug_stage = None
    elif event == "error" and stage == "texture":
        debug_stage = _texture_debug_stage or "texture"
        _enrich_failure(values, debug_stage, "Texture generation failed")
        _texture_debug_stage = None

    _original_emit(event, **values)


_base.emit = _diagnostic_emit
emit = _diagnostic_emit


class _ShapePipelineNoProgress:
    """Prevent third-party tqdm output from writing into the desktop worker pipes."""

    def __init__(self, pipeline: Any) -> None:
        self._pipeline = pipeline

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        kwargs["enable_pbar"] = False
        return self._pipeline(*args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._pipeline, name)


class _ShapeInvocationCache:
    """Wrap Shape only at invocation time without changing cache identity semantics."""

    def __init__(self, cache: Any) -> None:
        self._cache = cache

    def get_shape_pipeline(
        self,
        loader: Callable[[], Any],
        key: tuple[Any, ...] = (),
    ) -> tuple[Any, bool]:
        pipeline, cache_hit = self._cache.get_shape_pipeline(loader, key)
        return _ShapePipelineNoProgress(pipeline), cache_hit

    def __getattr__(self, name: str) -> Any:
        return getattr(self._cache, name)


def run_generate(args: argparse.Namespace, cache: Any | None = None) -> int:
    """Run Shape with Hunyuan's terminal progress bar disabled in persistent mode."""

    if cache is None:
        return _original_run_generate(args, cache=None)
    return _original_run_generate(args, cache=_ShapeInvocationCache(cache))


_base.run_generate = run_generate

_TEXTURE_STYLE_PRESETS = {
    "match-source",
    "realistic",
    "stylized",
    "hand-painted",
    "cartoon",
    "pixel-art",
}


def _texture_namespace(request: dict[str, Any]) -> argparse.Namespace:
    style_preset = str(request.get("stylePreset") or request.get("style_preset") or "match-source")
    if style_preset not in _TEXTURE_STYLE_PRESETS:
        choices = ", ".join(sorted(_TEXTURE_STYLE_PRESETS))
        raise ValueError(f"Texture style preset must be one of: {choices}")
    style_strength = float(request.get('styleStrength', request.get('style_strength', 1.0)))
    if not 0.0 <= style_strength <= 1.0:
        raise ValueError('Texture style strength must be between 0.0 and 1.0')
    preserve_source_colors = bool(request.get('preserveSourceColors', request.get('preserve_source_colors', True)))
    style_reference = request.get('styleReference', request.get('style_reference'))

    args = _original_texture_namespace(request)
    args.style_preset = style_preset
    args.style_strength = style_strength
    args.preserve_source_colors = preserve_source_colors
    args.style_reference = str(style_reference) if style_reference else None
    return args


_base._texture_namespace = _texture_namespace


class _TextureStylePipeline:
    def __init__(self, pipeline: Any) -> None:
        self._pipeline = pipeline

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        textured_mesh = self._pipeline(*args, **kwargs)
        preset = str(_texture_style_context["preset"])
        strength = float(_texture_style_context["strength"])
        if preset == "match-source" or strength <= 0.0:
            return textured_mesh

        try:
            from .texture_stylizer import apply_texture_style_to_mesh
        except ImportError:
            from texture_stylizer import apply_texture_style_to_mesh  # type: ignore
        from PIL import Image  # type: ignore

        emit("progress", ok=True, stage="stylizing_texture", progress=0.88, style_preset=preset, style_strength=strength)
        reference_image = None
        style_reference = _texture_style_context.get("style_reference")
        if style_reference:
            reference_path = Path(str(style_reference)).expanduser().resolve()
            if not reference_path.is_file():
                raise FileNotFoundError(f"Style reference does not exist: {reference_path}")
            with Image.open(reference_path) as source:
                reference_image = source.convert("RGBA")

        return apply_texture_style_to_mesh(
            textured_mesh,
            preset=preset,
            strength=strength,
            preserve_source_colors=bool(_texture_style_context["preserve_source_colors"]),
            reference_image=reference_image,
        )

    def __getattr__(self, name: str) -> Any:
        return getattr(self._pipeline, name)


def build_texture_pipeline(args: argparse.Namespace, *, cpu_offload: bool, attention_slicing: str) -> Any:
    return _TextureStylePipeline(
        _original_build_texture_pipeline(
            args,
            cpu_offload=cpu_offload,
            attention_slicing=attention_slicing,
        )
    )


def run_texture(args: argparse.Namespace, cache: Any | None = None) -> int:
    previous = dict(_texture_style_context)
    _texture_style_context.update(
        preset=str(getattr(args, "style_preset", "match-source")),
        strength=float(getattr(args, "style_strength", 1.0)),
        preserve_source_colors=bool(getattr(args, "preserve_source_colors", True)),
        style_reference=getattr(args, "style_reference", None),
    )
    try:
        return _original_run_texture(args, cache=cache)
    finally:
        _texture_style_context.clear()
        _texture_style_context.update(previous)


_base.build_texture_pipeline = build_texture_pipeline
_base.run_texture = run_texture


class PipelineCache(_BasePipelineCache):
    """Hunyuan, cleanup and Local Repaint caches with bounded GPU residency."""

    def __init__(self, event_sink: Callable[[dict[str, Any]], None] | None = None) -> None:
        super().__init__(event_sink=event_sink)
        self.cleanup_mesh_cache = CleanupMeshCache()
        self.local_repaint_cache = LocalRepaintCache(event_sink=event_sink)

    def get_shape_pipeline(
        self,
        loader: Callable[[], Any],
        key: tuple[Any, ...] = (),
    ) -> tuple[Any, bool]:
        if self.local_repaint_cache.backend is not None:
            self.local_repaint_cache.clear(evicted=True)
        return super().get_shape_pipeline(loader, key)

    def get_texture_pipeline(
        self,
        loader: Callable[[], Any],
        key: tuple[Any, ...] = (),
    ) -> tuple[Any, bool]:
        if self.local_repaint_cache.backend is not None:
            self.local_repaint_cache.clear(evicted=True)
        return super().get_texture_pipeline(loader, key)

    def clear(self) -> None:
        self.cleanup_mesh_cache.clear()
        self.local_repaint_cache.clear()
        super().clear()


def _preload_shape_namespace(request: dict[str, Any]) -> argparse.Namespace:
    return argparse.Namespace(
        model=request.get("model") or "tencent/Hunyuan3D-2mini",
        subfolder=request.get("subfolder") or "hunyuan3d-dit-v2-mini",
        variant=request.get("variant") or "fp16",
    )


def run_preload_shape(args: argparse.Namespace, cache: PipelineCache) -> int:
    started = time.perf_counter()
    cache_hit = False
    try:
        emit("progress", ok=True, stage="preloading_shape", progress=0.25)
        pipeline, cache_hit = cache.get_shape_pipeline(
            lambda: _base.build_shape_pipeline(args),
            (args.model, args.subfolder, args.variant),
        )
        _ = pipeline
        model_load_ms = (time.perf_counter() - started) * 1000.0
        emit(
            "completed",
            ok=True,
            stage="shape_preloaded",
            progress=1.0,
            cache_hit=cache_hit,
            cache_kind="shape",
            model=args.model,
            subfolder=args.subfolder,
            model_load_ms=round(model_load_ms, 3),
        )
        return 0
    except Exception as exc:
        emit(
            "error",
            ok=False,
            stage="preloading_shape",
            error_kind=classify_generation_error(exc),
            error=f"{type(exc).__name__}: {exc}",
            cache_hit=cache_hit,
            cache_kind="shape",
            model_load_ms=round((time.perf_counter() - started) * 1000.0, 3),
        )
        return 1


def run_mesh_cleanup(args: argparse.Namespace, cache: PipelineCache | None = None) -> int:
    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()

    if input_path == output_path:
        emit(
            "error",
            ok=False,
            stage="mesh_cleanup",
            error_kind="invalid_input",
            error="Input and output mesh paths must differ",
        )
        return 2
    if not input_path.is_file():
        emit(
            "error",
            ok=False,
            stage="mesh_cleanup",
            error_kind="invalid_input",
            error=f"Input mesh does not exist: {input_path}",
        )
        return 2
    if input_path.suffix.lower() not in {".glb", ".obj"} or output_path.suffix.lower() not in {".glb", ".obj"}:
        emit(
            "error",
            ok=False,
            stage="mesh_cleanup",
            error_kind="invalid_input",
            error="Mesh cleanup supports only .glb and .obj",
        )
        return 2

    started = time.perf_counter()
    cleanup_cache_hit = False
    try:
        # Mesh cleanup is CPU-only. Keeping Hunyuan Shape/Paint resident wastes
        # most of the Radeon VRAM and can starve the Tauri/WebView GPU context.
        # Preserve the cleanup cache, but evict only heavyweight ML pipelines.
        if cache is not None:
            cache.clear_shape(evicted=True)
            cache.clear_texture(evicted=True)
            cache.local_repaint_cache.clear(evicted=True)

        config = resolve_cleanup_config(args.preset, args.overrides)
        emit("progress", ok=True, stage="cleaning_mesh", progress=0.20)

        def build_cleaned():
            return cleanup_mesh(
                load_mesh(input_path),
                config,
                progress=lambda stage, value: emit(
                    "progress",
                    ok=True,
                    stage=stage,
                    progress=value,
                ),
            )

        if cache is None:
            cleaned, report = build_cleaned()
        else:
            key = cleanup_cache_key(input_path, config)
            cleaned, report, cleanup_cache_hit = cache.cleanup_mesh_cache.get_or_create(key, build_cleaned)

        emit(
            "progress",
            ok=True,
            stage="exporting_clean_mesh",
            progress=0.85,
            cleanup_cache_hit=cleanup_cache_hit,
        )
        export_mesh_atomic(cleaned, output_path)
        mesh_cleanup_ms = (time.perf_counter() - started) * 1000.0
        report.cleanup_ms = round(mesh_cleanup_ms, 3)
        emit(
            "completed",
            ok=True,
            stage="completed",
            progress=1.0,
            output=str(output_path),
            cleanup_cache_hit=cleanup_cache_hit,
            mesh_cleanup_ms=round(mesh_cleanup_ms, 3),
            cleanup_report=report.to_dict(),
        )
        return 0
    except Exception as exc:
        emit(
            "error",
            ok=False,
            stage="mesh_cleanup",
            error_kind="mesh_cleanup_error",
            error=f"{type(exc).__name__}: {exc}",
            cleanup_cache_hit=cleanup_cache_hit,
            mesh_cleanup_ms=round((time.perf_counter() - started) * 1000.0, 3),
        )
        return 1


def _mesh_cleanup_namespace(request: dict[str, Any]) -> argparse.Namespace:
    return argparse.Namespace(
        input=request["input"],
        output=request["output"],
        preset=str(request.get("preset", "game-ready")),
        overrides=dict(request.get("overrides") or {}),
    )


def _local_repaint_namespace(request: dict[str, Any]) -> argparse.Namespace:
    return argparse.Namespace(
        source=request["source"],
        mask=request["mask"],
        output=request["output"],
        prompt=request.get("prompt"),
        reference_image=request.get("referenceImage", request.get("reference_image")),
        feather_px=int(request.get("featherPx", request.get("feather_px", 0))),
    )


def dispatch_serve_command(
    message: dict[str, Any],
    *,
    cache: PipelineCache,
    emit_fn: Callable[[dict[str, Any]], None] | None = None,
) -> bool:
    command = message.get("command")
    if command not in {"mesh_cleanup", "preload_shape", "local_repaint"}:
        return _original_dispatch_serve_command(message, cache=cache, emit_fn=emit_fn)

    job_id = message.get("job_id")
    if not isinstance(job_id, str) or not job_id.strip():
        sink = emit_fn or (lambda payload: print(json.dumps(payload, ensure_ascii=False), flush=True))
        sink(
            {
                "event": "error",
                "ok": False,
                "error_kind": "protocol_error",
                "error": "Missing non-empty job_id",
            }
        )
        return True

    previous_job_id = _base._CURRENT_JOB_ID
    previous_sink = _base._EVENT_SINK
    _base._CURRENT_JOB_ID = job_id
    _base._EVENT_SINK = emit_fn
    try:
        request = message.get("request")
        if not isinstance(request, dict):
            raise ValueError(f"{command} command requires a request object")
        if command == "preload_shape":
            run_preload_shape(_preload_shape_namespace(request), cache)
        elif command == "local_repaint":
            run_local_repaint(
                _local_repaint_namespace(request),
                cache=cache,
                emit_fn=_base._emit_payload,
            )
        else:
            run_mesh_cleanup(_mesh_cleanup_namespace(request), cache=cache)
        return True
    except Exception as exc:
        emit(
            "error",
            ok=False,
            stage="worker",
            error_kind="protocol_error",
            error=f"{type(exc).__name__}: {exc}",
        )
        return True
    finally:
        _base._CURRENT_JOB_ID = previous_job_id
        _base._EVENT_SINK = previous_sink


def run_serve(_args: argparse.Namespace) -> int:
    cache = PipelineCache(event_sink=_emit_payload)
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("Serve command must be a JSON object")
        except Exception as exc:
            print(
                json.dumps(
                    {
                        "event": "error",
                        "ok": False,
                        "error_kind": "protocol_error",
                        "error": f"{type(exc).__name__}: {exc}",
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
            continue
        if not dispatch_serve_command(message, cache=cache):
            return 0
    cache.clear()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = _original_build_parser()
    subparsers_action = next(
        action for action in parser._actions if isinstance(action, argparse._SubParsersAction)
    )
    subparsers_action.choices["serve"].set_defaults(func=run_serve)
    texture_parser = subparsers_action.choices["texture"]
    texture_parser.add_argument(
        "--style-preset",
        choices=sorted(_TEXTURE_STYLE_PRESETS),
        default="match-source",
    )
    texture_parser.add_argument("--style-strength", type=float, default=1.0)
    texture_parser.add_argument("--style-reference")
    texture_parser.add_argument("--preserve-source-colors", dest="preserve_source_colors", action="store_true", default=True)
    texture_parser.add_argument("--no-preserve-source-colors", dest="preserve_source_colors", action="store_false")

    mesh_cleanup = subparsers_action.add_parser(
        "mesh-cleanup",
        help="Clean an existing GLB/OBJ mesh",
    )
    mesh_cleanup.add_argument("--input", required=True)
    mesh_cleanup.add_argument("--output", required=True)
    mesh_cleanup.add_argument(
        "--preset",
        choices=["off", "light", "game-ready", "aggressive"],
        default="game-ready",
    )
    mesh_cleanup.set_defaults(overrides={}, func=run_mesh_cleanup)

    local_repaint = subparsers_action.add_parser(
        "local-repaint",
        help="Repaint a masked local texture patch",
    )
    local_repaint.add_argument("--source", required=True)
    local_repaint.add_argument("--mask", required=True)
    local_repaint.add_argument("--output", required=True)
    local_repaint.add_argument("--prompt")
    local_repaint.add_argument("--reference-image")
    local_repaint.add_argument("--feather-px", type=int, default=0)
    local_repaint.set_defaults(func=run_local_repaint)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
