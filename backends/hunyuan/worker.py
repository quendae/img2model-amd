#!/usr/bin/env python3
"""Img2Model AMD worker entry point with reusable mesh-cleanup orchestration.

The legacy Hunyuan shape/texture implementation lives in ``worker_base``.
This entry point keeps that behavior intact while adding the CPU-side mesh
cleanup command without embedding geometry algorithms into Hunyuan code.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import sys
import time
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


class PipelineCache(_BasePipelineCache):
    """Existing Hunyuan caches plus a distinct one-entry cleanup cache."""

    def __init__(self, event_sink: Callable[[dict[str, Any]], None] | None = None) -> None:
        super().__init__(event_sink=event_sink)
        self.cleanup_mesh_cache = CleanupMeshCache()

    def clear(self) -> None:
        self.cleanup_mesh_cache.clear()
        super().clear()


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
    if message.get("command") != "mesh_cleanup":
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
            raise ValueError("mesh_cleanup command requires a request object")
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
    protocol_stdout = sys.stdout

    def protocol_emit(payload: dict[str, Any]) -> None:
        protocol_stdout.write(json.dumps(payload, ensure_ascii=False))
        protocol_stdout.write("\n")
        protocol_stdout.flush()

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
            protocol_emit(
                {
                    "event": "error",
                    "ok": False,
                    "error_kind": "protocol_error",
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )
            continue

        # stdout is the JSONL protocol channel. Third-party libraries in
        # Hunyuan3D occasionally use plain print(), so isolate ambient output
        # on stderr while protocol events keep writing to the captured stream.
        with contextlib.redirect_stdout(sys.stderr):
            keep_running = dispatch_serve_command(
                message,
                cache=cache,
                emit_fn=protocol_emit,
            )
        if not keep_running:
            return 0

    with contextlib.redirect_stdout(sys.stderr):
        cache.clear()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = _original_build_parser()
    subparsers_action = next(
        action for action in parser._actions if isinstance(action, argparse._SubParsersAction)
    )
    # Base parser points serve at worker_base.run_serve; redirect it to this
    # entry point so mesh_cleanup is understood in persistent mode.
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