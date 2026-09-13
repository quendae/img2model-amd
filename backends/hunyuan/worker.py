#!/usr/bin/env python3
"""Img2Model AMD worker entry point with reusable mesh-cleanup orchestration.

The legacy Hunyuan shape/texture implementation lives in ``worker_base``.
This entry point keeps that behavior intact while adding CPU-side mesh cleanup
and persistent Shape preloading without embedding those concerns into Hunyuan.
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
else:
    import worker_base as _base  # type: ignore

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
_original_emit = _base.emit
_shape_debug_stage: str | None = None


def _diagnostic_emit(event: str, **values: Any) -> None:
    """Keep normal worker events while enriching Shape failures with traceback context."""

    global _shape_debug_stage
    stage = values.get("stage")
    if event == "progress":
        stage_map = {
            "starting_backend": "opening_input",
            "preparing_input": "background_removal",
            "loading_model": "model_cache",
            "running_shape": "pipeline_call",
            "postprocessing": "export",
        }
        if isinstance(stage, str) and stage in stage_map:
            _shape_debug_stage = stage_map[stage]
    elif event == "completed" and stage == "completed":
        _shape_debug_stage = None
    elif event == "error" and stage == "shape":
        debug_stage = _shape_debug_stage or "shape"
        formatted_traceback = traceback.format_exc()
        if formatted_traceback.strip() == "NoneType: None":
            formatted_traceback = ""
        values.setdefault("debug_stage", debug_stage)
        if formatted_traceback:
            values.setdefault("traceback", formatted_traceback)
        error_text = str(values.get("error") or "Shape generation failed")
        technical_parts = [error_text, f"Debug stage: {debug_stage}"]
        if formatted_traceback:
            technical_parts.append(formatted_traceback.rstrip())
        # GenerateResult currently transports the error field end-to-end, so keep
        # the full diagnostic there until structured debug fields are added to the UI.
        values["error"] = "\n\n".join(technical_parts)
        _shape_debug_stage = None

    _original_emit(event, **values)


# worker_base catches generation exceptions internally. Replacing its emitter lets
# us capture traceback.format_exc() while the original exception context is alive,
# without changing the validated Hunyuan inference implementation.
_base.emit = _diagnostic_emit
emit = _diagnostic_emit


class _ShapePipelineNoProgress:
    """Prevent third-party tqdm output from writing into the desktop worker pipes."""

    def __init__(self, pipeline: Any) -> None:
        self._pipeline = pipeline

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        # The desktop owns progress reporting over JSONL. Hunyuan's tqdm writes
        # directly to a terminal stream, which is not a valid console handle for
        # the persistent Windows/Tauri worker and can raise OSError(22).
        kwargs["enable_pbar"] = False
        return self._pipeline(*args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._pipeline, name)


class PipelineCache(_BasePipelineCache):
    """Existing Hunyuan caches plus a distinct one-entry cleanup cache."""

    def __init__(self, event_sink: Callable[[dict[str, Any]], None] | None = None) -> None:
        super().__init__(event_sink=event_sink)
        self.cleanup_mesh_cache = CleanupMeshCache()

    def get_shape_pipeline(
        self,
        loader: Callable[[], Any],
        key: tuple[Any, ...] = (),
    ) -> tuple[Any, bool]:
        pipeline, cache_hit = super().get_shape_pipeline(loader, key)
        return _ShapePipelineNoProgress(pipeline), cache_hit

    def clear(self) -> None:
        self.cleanup_mesh_cache.clear()
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
        config = resolve_cleanup_config(args.preset, args.overrides)
        emit("progress", ok=True, stage="cleaning_mesh", progress=0.20)

        def build_cleaned():
            return cleanup_mesh(load_mesh(input_path), config)

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


def dispatch_serve_command(
    message: dict[str, Any],
    *,
    cache: PipelineCache,
    emit_fn: Callable[[dict[str, Any]], None] | None = None,
) -> bool:
    command = message.get("command")
    if command not in {"mesh_cleanup", "preload_shape"}:
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
    # Base parser points serve at worker_base.run_serve; redirect it to this
    # entry point so protocol-v2 commands are understood in persistent mode.
    subparsers_action.choices["serve"].set_defaults(func=run_serve)

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
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())