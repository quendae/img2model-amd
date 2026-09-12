from __future__ import annotations

import copy
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable

from .models import ResolvedCleanupConfig


def cleanup_cache_key(mesh_path: Path, config: ResolvedCleanupConfig) -> tuple[Any, ...]:
    resolved = mesh_path.expanduser().resolve()
    stat = resolved.stat()
    settings = tuple(sorted(asdict(config.settings).items()))
    return (
        str(resolved),
        stat.st_size,
        stat.st_mtime_ns,
        config.preset,
        config.algorithm_version,
        settings,
    )


class CleanupMeshCache:
    """One-entry in-memory cache for cleaned geometry and its report."""

    def __init__(self) -> None:
        self.key: tuple[Any, ...] | None = None
        self.mesh: Any | None = None
        self.report: Any | None = None

    def clear(self) -> None:
        self.key = None
        self.mesh = None
        self.report = None

    def get_or_create(
        self,
        key: tuple[Any, ...],
        loader: Callable[[], tuple[Any, Any]],
    ) -> tuple[Any, Any, bool]:
        if self.mesh is not None and self.key == key:
            return self.mesh.copy(), copy.deepcopy(self.report), True

        mesh, report = loader()
        self.key = key
        self.mesh = mesh.copy()
        self.report = copy.deepcopy(report)
        return mesh.copy(), copy.deepcopy(report), False
