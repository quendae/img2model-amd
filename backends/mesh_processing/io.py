import os
from pathlib import Path

import trimesh

from .cleanup import cleanup_mesh
from .models import CleanupReport


def load_mesh(path: Path) -> trimesh.Trimesh:
    loaded = trimesh.load(str(path), force="mesh", process=False)
    if not isinstance(loaded, trimesh.Trimesh):
        raise ValueError("Mesh input could not be converted to one Trimesh")
    return loaded


def export_mesh_atomic(mesh: trimesh.Trimesh, output_path: Path) -> None:
    target = output_path.expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(f".{target.stem}.partial{target.suffix}")
    try:
        mesh.export(str(temp), file_type=target.suffix.lower().lstrip("."))
        os.replace(temp, target)
    finally:
        if temp.exists():
            temp.unlink()


def process_mesh(input_path: Path, output_path: Path, config) -> CleanupReport:
    source = input_path.expanduser().resolve()
    target = output_path.expanduser().resolve()
    if source == target:
        raise ValueError("Input and output mesh paths must differ")
    if source.suffix.lower() not in {".glb", ".obj"} or target.suffix.lower() not in {".glb", ".obj"}:
        raise ValueError("Mesh cleanup supports only .glb and .obj")
    if not source.is_file():
        raise FileNotFoundError(source)
    cleaned, report = cleanup_mesh(load_mesh(source), config)
    export_mesh_atomic(cleaned, target)
    return report
