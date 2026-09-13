from __future__ import annotations

from collections import defaultdict

import numpy as np
import pymeshlab
import trimesh

from .models import ReductionPolicy, ReductionStats, RepairPolicy, RepairStats


def _edge_counts(faces: np.ndarray) -> dict[tuple[int, int], int]:
    counts: dict[tuple[int, int], int] = defaultdict(int)
    for raw_face in np.asarray(faces, dtype=np.int64):
        a, b, c = (int(raw_face[0]), int(raw_face[1]), int(raw_face[2]))
        for first, second in ((a, b), (b, c), (c, a)):
            key = (first, second) if first < second else (second, first)
            counts[key] += 1
    return counts


def _boundary_edge_count(mesh: trimesh.Trimesh) -> int:
    return sum(1 for count in _edge_counts(np.asarray(mesh.faces)).values() if count == 1)


def _component_count(mesh: trimesh.Trimesh) -> int:
    faces = np.asarray(mesh.faces, dtype=np.int64)
    if len(faces) == 0:
        return 0

    parent = list(range(len(faces)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(first: int, second: int) -> None:
        root_first = find(first)
        root_second = find(second)
        if root_first != root_second:
            parent[root_second] = root_first

    edge_faces: dict[tuple[int, int], list[int]] = defaultdict(list)
    for face_index, raw_face in enumerate(faces):
        a, b, c = (int(raw_face[0]), int(raw_face[1]), int(raw_face[2]))
        for first, second in ((a, b), (b, c), (c, a)):
            key = (first, second) if first < second else (second, first)
            edge_faces[key].append(face_index)

    for adjacent in edge_faces.values():
        if len(adjacent) < 2:
            continue
        anchor = adjacent[0]
        for face_index in adjacent[1:]:
            union(anchor, face_index)

    return len({find(index) for index in range(len(faces))})


def _to_pymeshlab_mesh(mesh: trimesh.Trimesh) -> pymeshlab.Mesh:
    vertices = np.ascontiguousarray(np.asarray(mesh.vertices, dtype=np.float64))
    faces = np.ascontiguousarray(np.asarray(mesh.faces, dtype=np.int32))
    if vertices.ndim != 2 or vertices.shape[1] != 3:
        raise ValueError("Mesh vertices must have shape (N, 3)")
    if faces.ndim != 2 or faces.shape[1] != 3:
        raise ValueError("Mesh faces must have shape (M, 3)")
    if len(vertices) == 0 or len(faces) == 0:
        raise ValueError("Mesh must contain vertices and triangle faces")
    return pymeshlab.Mesh(vertex_matrix=vertices, face_matrix=faces)


def _to_meshset(mesh: trimesh.Trimesh) -> pymeshlab.MeshSet:
    mesh_set = pymeshlab.MeshSet()
    mesh_set.add_mesh(_to_pymeshlab_mesh(mesh), "input")
    return mesh_set


def _from_meshset(mesh_set: pymeshlab.MeshSet) -> trimesh.Trimesh:
    current = mesh_set.current_mesh()
    vertices = np.asarray(current.vertex_matrix(), dtype=np.float64)
    faces = np.asarray(current.face_matrix(), dtype=np.int64)
    if vertices.ndim != 2 or vertices.shape[1] != 3 or len(vertices) == 0:
        raise ValueError("PyMeshLab returned an empty or invalid vertex array")
    if faces.ndim != 2 or faces.shape[1] != 3 or len(faces) == 0:
        raise ValueError("PyMeshLab returned an empty or invalid triangle array")
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=False)


def _try_manifold_finalize(mesh: trimesh.Trimesh, warnings: list[str]) -> tuple[trimesh.Trimesh, bool]:
    try:
        from manifold3d import Error, Manifold, Mesh

        manifold_mesh = Mesh(
            vert_properties=np.ascontiguousarray(np.asarray(mesh.vertices, dtype=np.float32)),
            tri_verts=np.ascontiguousarray(np.asarray(mesh.faces, dtype=np.uint32)),
        )
        manifold = Manifold(manifold_mesh)
        status = manifold.status()
        if status != Error.NoError:
            warnings.append(f"Manifold3D finalization skipped: {status}.")
            return mesh, False

        result = manifold.to_mesh()
        vertices = np.asarray(result.vert_properties, dtype=np.float64)
        faces = np.asarray(result.tri_verts, dtype=np.int64)
        if vertices.ndim != 2 or vertices.shape[1] < 3 or len(vertices) == 0 or len(faces) == 0:
            warnings.append("Manifold3D finalization returned empty geometry; keeping PyMeshLab result.")
            return mesh, False

        finalized = trimesh.Trimesh(vertices=vertices[:, :3], faces=faces, process=False)
        return finalized, True
    except Exception as exc:
        warnings.append(f"Manifold3D finalization unavailable: {type(exc).__name__}: {exc}")
        return mesh, False


def repair_with_pymeshlab(
    mesh: trimesh.Trimesh,
    policy: RepairPolicy,
) -> tuple[trimesh.Trimesh, RepairStats]:
    if len(mesh.vertices) == 0 or len(mesh.faces) == 0:
        raise ValueError("Cannot repair an empty mesh")

    source = mesh.copy()
    components_before = _component_count(source)
    boundary_edges_before = _boundary_edge_count(source)
    watertight_before = bool(source.is_watertight)

    mesh_set = _to_meshset(source)
    mesh_set.apply_filter("meshing_remove_duplicate_faces")
    mesh_set.apply_filter("meshing_remove_duplicate_vertices")
    mesh_set.apply_filter("meshing_remove_null_faces")
    mesh_set.apply_filter("meshing_repair_non_manifold_vertices", vertdispratio=0.0)
    mesh_set.apply_filter("meshing_repair_non_manifold_edges", method=0)

    if policy.remove_component_faces_below > 0:
        mesh_set.apply_filter(
            "meshing_remove_connected_component_by_face_number",
            mincomponentsize=int(policy.remove_component_faces_below),
            removeunref=True,
        )

    if policy.close_holes_max_edges > 0:
        mesh_set.apply_filter(
            "meshing_close_holes",
            maxholesize=int(policy.close_holes_max_edges),
            selected=False,
            newfaceselected=False,
            selfintersection=True,
            refinehole=False,
        )

    remeshed = False
    if policy.isotropic_iterations > 0:
        mesh_set.apply_filter(
            "meshing_isotropic_explicit_remeshing",
            iterations=int(policy.isotropic_iterations),
            adaptive=False,
            selectedonly=False,
            targetlen=pymeshlab.PercentageValue(float(policy.isotropic_target_pct)),
            checksurfdist=True,
        )
        remeshed = True

    mesh_set.apply_filter("meshing_remove_unreferenced_vertices")
    repaired = _from_meshset(mesh_set)

    warnings: list[str] = []
    repair_backend = "pymeshlab"
    if policy.manifold_finalize:
        repaired, manifold_applied = _try_manifold_finalize(repaired, warnings)
        if manifold_applied:
            repair_backend = "pymeshlab+manifold3d"

    components_after = _component_count(repaired)
    boundary_edges_after = _boundary_edge_count(repaired)
    stats = RepairStats(
        watertight_before=watertight_before,
        watertight_after=bool(repaired.is_watertight),
        boundary_edges_before=boundary_edges_before,
        boundary_edges_after=boundary_edges_after,
        holes_closed=None,
        non_manifold_edges_fixed=None,
        components_removed=max(0, components_before - components_after),
        remeshed=remeshed,
        repair_backend=repair_backend,
        warnings=warnings,
    )
    return repaired, stats


def _qem_candidate(reference: trimesh.Trimesh, target_faces: int) -> trimesh.Trimesh:
    if target_faces >= len(reference.faces):
        return reference.copy()
    if target_faces < 4:
        raise ValueError("QEM target must contain at least four faces")

    mesh_set = _to_meshset(reference)
    mesh_set.apply_filter(
        "meshing_decimation_quadric_edge_collapse",
        targetfacenum=int(target_faces),
        qualitythr=1.0,
        preserveboundary=True,
        boundaryweight=3.0,
        preservenormal=True,
        preservetopology=True,
        optimalplacement=True,
        autoclean=True,
    )
    return _from_meshset(mesh_set)


def _hausdorff_max_distance(result: dict[str, object]) -> float:
    preferred = ("max", "max_distance", "maxdist")
    normalized = {str(key).lower(): value for key, value in result.items()}
    for key in preferred:
        if key in normalized:
            return float(normalized[key])
    for key, value in normalized.items():
        if "max" in key and isinstance(value, (int, float, np.integer, np.floating)):
            return float(value)
    raise RuntimeError(f"PyMeshLab Hausdorff result did not expose a maximum distance; keys={sorted(result)}")


def _directional_hausdorff(
    mesh_set: pymeshlab.MeshSet,
    sampled_mesh_id: int,
    target_mesh_id: int,
    sample_count: int,
) -> float:
    result = mesh_set.apply_filter(
        "get_hausdorff_distance",
        sampledmesh=int(sampled_mesh_id),
        targetmesh=int(target_mesh_id),
        savesample=False,
        samplevert=True,
        sampleedge=True,
        samplefauxedge=False,
        sampleface=True,
        samplenum=int(sample_count),
    )
    if not isinstance(result, dict):
        raise RuntimeError(f"PyMeshLab Hausdorff returned unexpected result type: {type(result).__name__}")
    return _hausdorff_max_distance(result)


def _normalized_symmetric_hausdorff(reference: trimesh.Trimesh, candidate: trimesh.Trimesh) -> float:
    if len(reference.faces) == 0 or len(candidate.faces) == 0:
        raise ValueError("Hausdorff comparison requires non-empty meshes")

    mesh_set = pymeshlab.MeshSet()
    mesh_set.add_mesh(_to_pymeshlab_mesh(reference), "reference")
    reference_id = int(mesh_set.current_mesh_id())
    mesh_set.add_mesh(_to_pymeshlab_mesh(candidate), "candidate")
    candidate_id = int(mesh_set.current_mesh_id())

    sample_count = min(50000, max(5000, len(reference.faces), len(candidate.faces)))
    forward = _directional_hausdorff(mesh_set, reference_id, candidate_id, sample_count)
    backward = _directional_hausdorff(mesh_set, candidate_id, reference_id, sample_count)
    bbox_diag = max(float(np.linalg.norm(np.asarray(reference.extents, dtype=np.float64))), 1e-9)
    return max(forward, backward) / bbox_diag


def _auto_targets(face_count: int, policy: ReductionPolicy) -> list[int]:
    if face_count <= policy.min_faces:
        return []

    target = min(face_count - 1, max(policy.min_faces, policy.start_faces))
    targets: list[int] = []
    while target > policy.min_faces:
        targets.append(target)
        next_target = max(policy.min_faces, int(round(target * 0.70)))
        if next_target >= target:
            break
        target = next_target
    if not targets or targets[-1] != policy.min_faces:
        targets.append(policy.min_faces)
    return targets


def adaptive_qem_reduce(
    reference: trimesh.Trimesh,
    policy: ReductionPolicy,
) -> tuple[trimesh.Trimesh, ReductionStats]:
    if len(reference.vertices) == 0 or len(reference.faces) == 0:
        raise ValueError("Cannot reduce an empty mesh")
    if policy.min_faces < 4:
        raise ValueError("min_faces must be at least 4")
    if policy.start_faces < policy.min_faces:
        raise ValueError("start_faces must be greater than or equal to min_faces")
    if policy.error_tolerance < 0.0:
        raise ValueError("error_tolerance must be non-negative")

    if policy.manual_target_faces is not None:
        requested = int(policy.manual_target_faces)
        target = max(4, min(requested, len(reference.faces)))
        candidate = _qem_candidate(reference, target)
        error = _normalized_symmetric_hausdorff(reference, candidate)
        if error > policy.error_tolerance:
            return reference.copy(), ReductionStats(
                requested_target_faces=requested,
                accepted_faces=len(reference.faces),
                normalized_error=error,
                attempts=1,
            )
        return candidate, ReductionStats(
            requested_target_faces=requested,
            accepted_faces=len(candidate.faces),
            normalized_error=error,
            attempts=1,
        )

    targets = _auto_targets(len(reference.faces), policy)
    if not targets:
        return reference.copy(), ReductionStats(
            requested_target_faces=None,
            accepted_faces=len(reference.faces),
            normalized_error=0.0,
            attempts=0,
        )

    accepted = reference.copy()
    accepted_error = 0.0
    attempts = 0
    for target in targets:
        candidate = _qem_candidate(reference, target)
        error = _normalized_symmetric_hausdorff(reference, candidate)
        attempts += 1
        if error > policy.error_tolerance:
            break
        accepted = candidate
        accepted_error = error

    return accepted, ReductionStats(
        requested_target_faces=None,
        accepted_faces=len(accepted.faces),
        normalized_error=accepted_error,
        attempts=attempts,
    )


__all__ = [
    "ReductionPolicy",
    "ReductionStats",
    "RepairPolicy",
    "RepairStats",
    "adaptive_qem_reduce",
    "repair_with_pymeshlab",
]
