import math
import time
from collections import defaultdict
from typing import Callable

import numpy as np
import trimesh

from .models import CleanupReport, ReductionPolicy, RepairPolicy, RepairStats
from .pymeshlab_backend import adaptive_qem_reduce, repair_with_pymeshlab

ProgressCallback = Callable[[str, float], None]


def _mesh_scale(mesh: trimesh.Trimesh) -> float:
    return max(float(np.linalg.norm(np.asarray(mesh.extents, dtype=float))), 1e-9)


def _remove_degenerate_faces(mesh: trimesh.Trimesh) -> None:
    area_eps = max(float(mesh.area) * 1e-12, _mesh_scale(mesh) ** 2 * 1e-14)
    keep = np.asarray(mesh.area_faces) > area_eps
    mesh.update_faces(keep)
    mesh.remove_unreferenced_vertices()


def _weld_near_vertices(mesh: trimesh.Trimesh, relative_epsilon: float) -> int:
    if relative_epsilon <= 0.0 or len(mesh.vertices) == 0:
        return 0
    absolute_epsilon = max(_mesh_scale(mesh) * relative_epsilon, 1e-12)
    digits = max(0, min(12, int(math.ceil(-math.log10(absolute_epsilon)))))
    before = len(mesh.vertices)
    mesh.merge_vertices(digits_vertex=digits, merge_tex=False, merge_norm=False)
    mesh.remove_unreferenced_vertices()
    return max(0, before - len(mesh.vertices))


def _topology(
    faces: np.ndarray,
    vertex_count: int,
) -> tuple[list[list[int]], list[list[int]], list[list[int]], dict[tuple[int, int], list[tuple[int, int]]]]:
    """Build topology from triangles without SciPy/NetworkX."""

    vertex_faces: list[list[int]] = [[] for _ in range(vertex_count)]
    vertex_neighbors: list[set[int]] = [set() for _ in range(vertex_count)]
    edge_occurrences: dict[tuple[int, int], list[tuple[int, int]]] = defaultdict(list)

    for face_index, raw_face in enumerate(np.asarray(faces, dtype=int)):
        a, b, c = (int(raw_face[0]), int(raw_face[1]), int(raw_face[2]))
        for vertex in (a, b, c):
            vertex_faces[vertex].append(face_index)
        vertex_neighbors[a].update((b, c))
        vertex_neighbors[b].update((a, c))
        vertex_neighbors[c].update((a, b))
        for first, second in ((a, b), (b, c), (c, a)):
            key = (first, second) if first < second else (second, first)
            direction = 1 if (first, second) == key else -1
            edge_occurrences[key].append((face_index, direction))

    face_neighbors: list[set[int]] = [set() for _ in range(len(faces))]
    for occurrences in edge_occurrences.values():
        if len(occurrences) < 2:
            continue
        indices = [face_index for face_index, _direction in occurrences]
        for offset, first in enumerate(indices):
            for second in indices[offset + 1 :]:
                face_neighbors[first].add(second)
                face_neighbors[second].add(first)

    return (
        vertex_faces,
        [sorted(values) for values in vertex_neighbors],
        [sorted(values) for values in face_neighbors],
        edge_occurrences,
    )


def _face_components_from_neighbors(face_neighbors: list[list[int]]) -> list[np.ndarray]:
    face_count = len(face_neighbors)
    if face_count == 0:
        return []
    seen = np.zeros(face_count, dtype=bool)
    components: list[np.ndarray] = []
    for start in range(face_count):
        if seen[start]:
            continue
        stack = [start]
        seen[start] = True
        component: list[int] = []
        while stack:
            current = stack.pop()
            component.append(current)
            for neighbor in face_neighbors[current]:
                if seen[neighbor]:
                    continue
                seen[neighbor] = True
                stack.append(neighbor)
        components.append(np.asarray(component, dtype=int))
    return components


def _face_components(mesh: trimesh.Trimesh) -> list[np.ndarray]:
    _vertex_faces, _vertex_neighbors, face_neighbors, _edges = _topology(
        np.asarray(mesh.faces), len(mesh.vertices)
    )
    return _face_components_from_neighbors(face_neighbors)


def _boundary_edge_count(mesh: trimesh.Trimesh) -> int:
    _vertex_faces, _vertex_neighbors, _face_neighbors, edges = _topology(
        np.asarray(mesh.faces), len(mesh.vertices)
    )
    return sum(1 for occurrences in edges.values() if len(occurrences) == 1)


def _is_edge_manifold(mesh: trimesh.Trimesh) -> bool:
    _vertex_faces, _vertex_neighbors, _face_neighbors, edges = _topology(
        np.asarray(mesh.faces), len(mesh.vertices)
    )
    return all(len(occurrences) <= 2 for occurrences in edges.values())


def _small_boundary_loops(mesh: trimesh.Trimesh, max_vertices: int = 4) -> list[list[int]]:
    """Return isolated triangle/quad boundary loops safe enough for Light repair."""

    vertex_faces, _vertex_neighbors, _face_neighbors, edges = _topology(
        np.asarray(mesh.faces), len(mesh.vertices)
    )
    boundary_edges = [edge for edge, occurrences in edges.items() if len(occurrences) == 1]
    if not boundary_edges:
        return []

    adjacency: dict[int, set[int]] = defaultdict(set)
    for first, second in boundary_edges:
        adjacency[first].add(second)
        adjacency[second].add(first)

    loops: list[list[int]] = []
    seen: set[int] = set()
    for start in sorted(adjacency):
        if start in seen:
            continue
        stack = [start]
        component: set[int] = set()
        while stack:
            current = stack.pop()
            if current in component:
                continue
            component.add(current)
            seen.add(current)
            stack.extend(adjacency[current] - component)

        if len(component) < 3 or len(component) > max_vertices:
            continue
        if any(len(adjacency[vertex]) != 2 for vertex in component):
            continue
        # Do not turn a tiny open sheet into a fake closed shell. A genuine
        # small hole in a surrounding surface has at least two incident source
        # faces at every boundary vertex.
        if any(len(vertex_faces[vertex]) < 2 for vertex in component):
            continue

        first = min(component)
        second = min(adjacency[first])
        ordered = [first, second]
        previous, current = first, second
        valid = True
        while True:
            candidates = [neighbor for neighbor in adjacency[current] if neighbor != previous]
            if len(candidates) != 1:
                valid = False
                break
            next_vertex = candidates[0]
            if next_vertex == first:
                break
            if next_vertex in ordered or len(ordered) >= len(component):
                valid = False
                break
            ordered.append(next_vertex)
            previous, current = current, next_vertex

        if valid and len(ordered) == len(component):
            loops.append(ordered)
    return loops


def _fill_small_boundary_holes(mesh: trimesh.Trimesh) -> int:
    """Fill only isolated triangular or quad holes without remeshing."""

    loops = _small_boundary_loops(mesh, max_vertices=4)
    if not loops:
        return 0

    new_faces: list[list[int]] = []
    for loop in loops:
        if len(loop) == 3:
            new_faces.append(loop)
        elif len(loop) == 4:
            new_faces.append([loop[0], loop[1], loop[2]])
            new_faces.append([loop[0], loop[2], loop[3]])

    if not new_faces:
        return 0
    mesh.faces = np.vstack((np.asarray(mesh.faces, dtype=int), np.asarray(new_faces, dtype=int)))
    mesh.remove_unreferenced_vertices()
    return len(loops)


def _game_ready_mesh_is_healthy(mesh: trimesh.Trimesh) -> bool:
    """Avoid geometry-changing repair when the source already has sound topology."""

    return (
        bool(mesh.is_watertight)
        and _is_edge_manifold(mesh)
        and _boundary_edge_count(mesh) == 0
        and len(_face_components(mesh)) == 1
    )


def _remove_small_components(mesh: trimesh.Trimesh, min_area_ratio: float) -> int:
    components = _face_components(mesh)
    if len(components) <= 1:
        return 0
    face_areas = np.asarray(mesh.area_faces)
    areas = [float(face_areas[component].sum()) for component in components]
    total = max(sum(areas), 1e-12)
    largest = int(np.argmax(areas))
    keep = np.zeros(len(mesh.faces), dtype=bool)
    removed = 0
    for index, component in enumerate(components):
        if index == largest or areas[index] / total >= min_area_ratio:
            keep[component] = True
        else:
            removed += 1
    mesh.update_faces(keep)
    mesh.remove_unreferenced_vertices()
    return removed


def _triangle_aspect(vertices: np.ndarray) -> float:
    edges = np.array(
        [
            np.linalg.norm(vertices[0] - vertices[1]),
            np.linalg.norm(vertices[1] - vertices[2]),
            np.linalg.norm(vertices[2] - vertices[0]),
        ]
    )
    shortest = max(float(edges.min()), 1e-12)
    return float(edges.max()) / shortest


def _normal_spread_deg(normals: np.ndarray) -> float:
    if len(normals) < 2:
        return 0.0
    unit = normals / np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
    dots = np.clip(unit @ unit.T, -1.0, 1.0)
    return float(np.degrees(np.arccos(dots.min())))


def _relax_spike_vertices(
    mesh: trimesh.Trimesh,
    edge_ratio: float,
    max_area_ratio: float,
    normal_angle_deg: float,
) -> int:
    vertices = np.asarray(mesh.vertices).copy()
    faces_array = np.asarray(mesh.faces, dtype=int)
    vertex_faces, vertex_neighbors, _face_neighbors, _edges = _topology(faces_array, len(vertices))
    face_areas = np.asarray(mesh.area_faces)
    total_area = max(float(mesh.area), 1e-12)
    typical_face_area = max(float(np.median(face_areas)), 1e-12) if len(face_areas) else 1e-12
    face_normals = np.asarray(mesh.face_normals)
    adjusted: dict[int, np.ndarray] = {}

    for vertex_index, neighbors in enumerate(vertex_neighbors):
        if len(neighbors) < 3:
            continue
        neighbor_idx = np.asarray(neighbors, dtype=int)
        incident_lengths = np.linalg.norm(vertices[neighbor_idx] - vertices[vertex_index], axis=1)

        reference_lengths: list[float] = []
        for neighbor in neighbors:
            for second in vertex_neighbors[neighbor]:
                if second == vertex_index:
                    continue
                reference_lengths.append(float(np.linalg.norm(vertices[second] - vertices[neighbor])))
        if not reference_lengths:
            continue
        reference = max(float(np.median(reference_lengths)), 1e-12)
        if float(incident_lengths.max()) / reference < edge_ratio:
            continue

        faces = np.asarray(vertex_faces[vertex_index], dtype=int)
        if len(faces) < 2:
            continue

        baseline_area_ratio = typical_face_area * len(faces) / total_area
        if baseline_area_ratio > max_area_ratio:
            continue

        incident_triangles = vertices[faces_array[faces]]
        max_aspect = max(_triangle_aspect(triangle) for triangle in incident_triangles)
        if max_aspect < max(6.0, edge_ratio * 2.0):
            continue

        normals = face_normals[faces]
        if _normal_spread_deg(normals) < normal_angle_deg:
            continue

        median_neighbor = np.median(vertices[neighbor_idx], axis=0)
        displacement_ratio = float(np.linalg.norm(vertices[vertex_index] - median_neighbor)) / reference
        if displacement_ratio < edge_ratio:
            continue

        adjusted[vertex_index] = 0.5 * vertices[vertex_index] + 0.5 * median_neighbor

    for vertex_index, position in adjusted.items():
        vertices[vertex_index] = position
    if adjusted:
        mesh.vertices = vertices
    return len(adjusted)


def _laplacian_step(vertices: np.ndarray, neighbors: list[list[int]], factor: float) -> np.ndarray:
    source = vertices.copy()
    result = source.copy()
    for index, adjacent in enumerate(neighbors):
        if len(adjacent) < 3:
            continue
        mean = source[np.asarray(adjacent, dtype=int)].mean(axis=0)
        result[index] = source[index] + factor * (mean - source[index])
    return result


def _taubin_smooth(mesh: trimesh.Trimesh, iterations: int, lamb: float, nu: float) -> None:
    faces = np.asarray(mesh.faces, dtype=int)
    _vertex_faces, neighbors, _face_neighbors, _edges = _topology(faces, len(mesh.vertices))
    vertices = np.asarray(mesh.vertices).copy()
    for _iteration in range(iterations):
        vertices = _laplacian_step(vertices, neighbors, lamb)
        vertices = _laplacian_step(vertices, neighbors, nu)
    mesh.vertices = vertices


def _repair_face_winding(mesh: trimesh.Trimesh) -> None:
    """Orient adjacent triangle winding consistently without graph extras."""

    faces = np.asarray(mesh.faces, dtype=int).copy()
    vertices = np.asarray(mesh.vertices)
    if len(faces) == 0:
        return

    _vertex_faces, _vertex_neighbors, face_neighbors, edge_occurrences = _topology(faces, len(vertices))
    relations: list[list[tuple[int, int]]] = [[] for _ in range(len(faces))]
    for occurrences in edge_occurrences.values():
        if len(occurrences) != 2:
            continue
        (first_face, first_direction), (second_face, second_direction) = occurrences
        required = -first_direction * second_direction
        relations[first_face].append((second_face, required))
        relations[second_face].append((first_face, required))

    orientation = np.zeros(len(faces), dtype=np.int8)
    components = _face_components_from_neighbors(face_neighbors)
    for component in components:
        if len(component) == 0:
            continue
        start = int(component[0])
        orientation[start] = 1
        stack = [start]
        while stack:
            current = stack.pop()
            for neighbor, relation in relations[current]:
                expected = int(orientation[current]) * relation
                if orientation[neighbor] == 0:
                    orientation[neighbor] = expected
                    stack.append(neighbor)
        component_flips = component[orientation[component] < 0]
        if len(component_flips):
            faces[component_flips] = faces[component_flips][:, [0, 2, 1]]

        component_faces = faces[component]
        edge_counts: dict[tuple[int, int], int] = defaultdict(int)
        for face in component_faces:
            a, b, c = (int(face[0]), int(face[1]), int(face[2]))
            for first, second in ((a, b), (b, c), (c, a)):
                key = (first, second) if first < second else (second, first)
                edge_counts[key] += 1
        if edge_counts and all(count == 2 for count in edge_counts.values()):
            triangles = vertices[component_faces]
            signed_volume = float(
                np.einsum("ij,ij->i", triangles[:, 0], np.cross(triangles[:, 1], triangles[:, 2])).sum()
                / 6.0
            )
            if signed_volume < 0.0:
                faces[component] = faces[component][:, [0, 2, 1]]

    mesh.faces = faces


def _heavy_policies(config) -> tuple[RepairPolicy, ReductionPolicy]:
    manual_target = (
        config.settings.target_triangles
        if config.settings.triangle_budget_mode == "manual"
        else None
    )
    if config.preset == "game-ready":
        return (
            RepairPolicy(
                close_holes_max_edges=100,
                remove_component_faces_below=25,
                isotropic_iterations=1,
                isotropic_target_pct=1.0,
                manifold_finalize=True,
            ),
            ReductionPolicy(
                min_faces=6000,
                start_faces=48000,
                error_tolerance=0.006,
                manual_target_faces=manual_target,
            ),
        )
    if config.preset == "aggressive":
        return (
            RepairPolicy(
                close_holes_max_edges=250,
                remove_component_faces_below=50,
                isotropic_iterations=2,
                isotropic_target_pct=1.5,
                manifold_finalize=True,
            ),
            ReductionPolicy(
                min_faces=1500,
                start_faces=24000,
                error_tolerance=0.012,
                manual_target_faces=manual_target,
            ),
        )
    raise ValueError(f"Heavy cleanup policy is not defined for preset: {config.preset}")


def _cleanup_heavy(
    mesh: trimesh.Trimesh,
    config,
    report: CleanupReport,
    progress: ProgressCallback | None = None,
) -> trimesh.Trimesh:
    repair_policy, reduction_policy = _heavy_policies(config)
    if progress is not None:
        progress("repairing_mesh", 0.25)

    if config.preset == "game-ready" and _game_ready_mesh_is_healthy(mesh):
        repaired = mesh.copy()
        repair_stats = RepairStats(
            watertight_before=True,
            watertight_after=True,
            boundary_edges_before=0,
            boundary_edges_after=0,
            holes_closed=0,
            non_manifold_edges_fixed=0,
            components_removed=0,
            remeshed=False,
            repair_backend="validation-only",
        )
    else:
        repaired, repair_stats = repair_with_pymeshlab(mesh, repair_policy)

    if progress is not None:
        progress("reducing_mesh", 0.45)

    def reduction_progress(attempt: int, total: int, _target: int) -> None:
        if progress is None:
            return
        fraction = (attempt - 1) / max(total, 1)
        progress("reducing_mesh", min(0.78, 0.45 + 0.30 * fraction))

    reduced, reduction_stats = adaptive_qem_reduce(
        repaired,
        reduction_policy,
        progress=reduction_progress,
    )

    if progress is not None:
        progress("validating_mesh", 0.80)

    report.components_removed = repair_stats.components_removed
    report.watertight_before = repair_stats.watertight_before
    report.watertight_after = bool(reduced.is_watertight)
    report.manifold_before = _is_edge_manifold(mesh)
    report.manifold_after = _is_edge_manifold(reduced)
    report.boundary_edges_before = repair_stats.boundary_edges_before
    report.boundary_edges_after = _boundary_edge_count(reduced)
    report.holes_closed = repair_stats.holes_closed
    report.non_manifold_edges_fixed = repair_stats.non_manifold_edges_fixed
    report.remeshed = repair_stats.remeshed
    report.repair_backend = repair_stats.repair_backend
    report.normalized_error = reduction_stats.normalized_error
    report.target_triangles = reduction_stats.requested_target_faces
    report.warnings.extend(repair_stats.warnings)

    if len(repaired.faces) > reduction_policy.min_faces and len(reduced.faces) == len(repaired.faces):
        report.warnings.append(
            "Adaptive reduction kept the repaired reference because smaller candidates exceeded the geometry-error tolerance."
        )
    return reduced


def cleanup_mesh(
    mesh: trimesh.Trimesh,
    config,
    progress: ProgressCallback | None = None,
):
    working = mesh.copy()
    started = time.perf_counter()
    before_components = len(_face_components(working))
    report = CleanupReport(
        preset=config.preset,
        config_label=config.label,
        algorithm_version=config.algorithm_version,
        triangles_before=len(working.faces),
        triangles_after=len(working.faces),
        vertices_before=len(working.vertices),
        vertices_after=len(working.vertices),
        components_before=before_components,
        components_after=before_components,
        watertight_before=bool(working.is_watertight),
        manifold_before=_is_edge_manifold(working),
        boundary_edges_before=_boundary_edge_count(working),
    )
    settings = config.settings

    if config.preset in {"game-ready", "aggressive"}:
        working = _cleanup_heavy(working, config, report, progress=progress)
    else:
        if settings.remove_degenerate:
            _remove_degenerate_faces(working)
        if settings.weld_vertices:
            report.vertices_welded = _weld_near_vertices(working, settings.weld_relative_epsilon)
        if settings.remove_small_islands:
            report.components_removed = _remove_small_components(working, settings.min_component_area_ratio)
        if config.preset == "light" and not working.is_watertight and _is_edge_manifold(working):
            report.holes_closed = _fill_small_boundary_holes(working)
            if report.holes_closed:
                report.repair_backend = "native-small-hole-fill"
        if settings.spike_cleanup:
            report.spikes_adjusted = _relax_spike_vertices(
                working,
                settings.spike_edge_ratio,
                settings.spike_max_area_ratio,
                settings.spike_normal_angle_deg,
            )
        if settings.smooth_surface and settings.smoothing_iterations > 0:
            _taubin_smooth(
                working,
                settings.smoothing_iterations,
                settings.taubin_lambda,
                settings.taubin_nu,
            )
        if settings.recompute_normals:
            _repair_face_winding(working)

    working.remove_unreferenced_vertices()
    report.triangles_after = len(working.faces)
    report.vertices_after = len(working.vertices)
    report.components_after = len(_face_components(working))
    report.watertight_after = bool(working.is_watertight)
    report.manifold_after = _is_edge_manifold(working)
    report.boundary_edges_after = _boundary_edge_count(working)
    report.reduction_ratio = (
        0.0
        if report.triangles_before == 0
        else max(0.0, 1.0 - report.triangles_after / report.triangles_before)
    )
    report.cleanup_ms = round((time.perf_counter() - started) * 1000.0, 3)

    if report.components_before > 0 and report.components_removed > max(3, report.components_before // 4):
        report.warnings.append("Large number of small components removed.")
    if config.preset == "light" and report.reduction_ratio > 0.20:
        report.warnings.append("Light cleanup removed more geometry than expected.")
    if config.preset == "aggressive":
        report.warnings.append("Aggressive cleanup may alter silhouette and fine detail.")
    if not report.watertight_after:
        if report.manifold_after is False:
            report.warnings.append(
                "Mesh remains non-manifold after cleanup; texture generation can continue, but stronger geometry repair may be needed."
            )
        elif (report.boundary_edges_after or 0) > 0:
            next_step = (
                "Try Game-ready or Aggressive cleanup for stronger hole repair."
                if config.preset in {"off", "light"}
                else "Try Aggressive cleanup or an external mesh-repair tool."
                if config.preset == "game-ready"
                else "External mesh repair may be required for a fully closed shell."
            )
            report.warnings.append(
                f"Mesh still has {report.boundary_edges_after} open boundary edges after cleanup. {next_step}"
            )
        else:
            report.warnings.append("Mesh is still not watertight after cleanup.")
    return working, report
