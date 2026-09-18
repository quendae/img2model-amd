import math
import time
from collections import defaultdict
from dataclasses import dataclass
from typing import Callable

import numpy as np
import trimesh

from .models import CleanupReport, ReductionPolicy, RepairPolicy, RepairStats
from .pymeshlab_backend import adaptive_qem_reduce, repair_with_pymeshlab

ProgressCallback = Callable[[str, float], None]


@dataclass
class _TopologySnapshot:
    vertex_faces: list[list[int]]
    vertex_neighbors: list[list[int]]
    face_neighbors: list[list[int]]
    edge_occurrences: dict[tuple[int, int], list[tuple[int, int]]]
    components: list[np.ndarray]
    manifold: bool
    boundary_edges: int
    watertight: bool
    winding_consistent: bool


def _mesh_scale(mesh: trimesh.Trimesh) -> float:
    return max(float(np.linalg.norm(np.asarray(mesh.extents, dtype=float))), 1e-9)


def _remove_degenerate_faces(mesh: trimesh.Trimesh) -> bool:
    area_eps = max(float(mesh.area) * 1e-12, _mesh_scale(mesh) ** 2 * 1e-14)
    keep = np.asarray(mesh.area_faces) > area_eps
    if bool(np.all(keep)):
        return False
    mesh.update_faces(keep)
    mesh.remove_unreferenced_vertices()
    return True


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


def _topology_snapshot(mesh: trimesh.Trimesh) -> _TopologySnapshot:
    vertex_faces, vertex_neighbors, face_neighbors, edges = _topology(
        np.asarray(mesh.faces), len(mesh.vertices)
    )
    components = _face_components_from_neighbors(face_neighbors)
    boundary_edges = 0
    manifold = True
    winding_consistent = True
    for occurrences in edges.values():
        count = len(occurrences)
        if count == 1:
            boundary_edges += 1
        elif count > 2:
            manifold = False
            winding_consistent = False
        elif count == 2 and occurrences[0][1] == occurrences[1][1]:
            winding_consistent = False
    watertight = bool(len(mesh.faces)) and manifold and boundary_edges == 0
    return _TopologySnapshot(
        vertex_faces=vertex_faces,
        vertex_neighbors=vertex_neighbors,
        face_neighbors=face_neighbors,
        edge_occurrences=edges,
        components=components,
        manifold=manifold,
        boundary_edges=boundary_edges,
        watertight=watertight,
        winding_consistent=winding_consistent,
    )


def _append_faces_to_topology(
    topology: _TopologySnapshot,
    new_faces: np.ndarray,
    original_face_count: int,
) -> None:
    """Patch a topology snapshot after appending a small number of triangles."""

    faces_array = np.asarray(new_faces, dtype=int)
    if len(faces_array) == 0:
        return

    neighbor_additions: dict[int, set[int]] = defaultdict(set)
    old_edge_counts: dict[tuple[int, int], int] = {}
    touched_faces: set[int] = set()

    for offset, raw_face in enumerate(faces_array):
        face_index = original_face_count + offset
        topology.face_neighbors.append([])
        touched_faces.add(face_index)
        a, b, c = (int(raw_face[0]), int(raw_face[1]), int(raw_face[2]))

        for vertex in (a, b, c):
            topology.vertex_faces[vertex].append(face_index)
        neighbor_additions[a].update((b, c))
        neighbor_additions[b].update((a, c))
        neighbor_additions[c].update((a, b))

        for first, second in ((a, b), (b, c), (c, a)):
            key = (first, second) if first < second else (second, first)
            direction = 1 if (first, second) == key else -1
            occurrences = topology.edge_occurrences.setdefault(key, [])
            old_edge_counts.setdefault(key, len(occurrences))
            for neighbor_face, _neighbor_direction in occurrences:
                topology.face_neighbors[face_index].append(neighbor_face)
                topology.face_neighbors[neighbor_face].append(face_index)
                touched_faces.add(neighbor_face)
            occurrences.append((face_index, direction))

    for vertex, additions in neighbor_additions.items():
        topology.vertex_neighbors[vertex] = sorted(
            set(topology.vertex_neighbors[vertex]).union(additions)
        )
    for face_index in touched_faces:
        topology.face_neighbors[face_index] = sorted(set(topology.face_neighbors[face_index]))

    boundary_edges = topology.boundary_edges
    manifold = topology.manifold
    winding_consistent = topology.winding_consistent
    for edge, old_count in old_edge_counts.items():
        occurrences = topology.edge_occurrences[edge]
        new_count = len(occurrences)
        boundary_edges += int(new_count == 1) - int(old_count == 1)
        if new_count > 2:
            manifold = False
            winding_consistent = False
        elif new_count == 2 and occurrences[0][1] == occurrences[1][1]:
            winding_consistent = False

    appended_indices = np.arange(
        original_face_count,
        original_face_count + len(faces_array),
        dtype=int,
    )
    if len(topology.components) == 1:
        topology.components[0] = np.concatenate((topology.components[0], appended_indices))
    else:
        topology.components = _face_components_from_neighbors(topology.face_neighbors)

    topology.boundary_edges = max(0, boundary_edges)
    topology.manifold = manifold
    topology.winding_consistent = winding_consistent
    topology.watertight = bool(topology.face_neighbors) and manifold and topology.boundary_edges == 0


def _face_components(mesh: trimesh.Trimesh) -> list[np.ndarray]:
    return _topology_snapshot(mesh).components


def _boundary_edge_count(mesh: trimesh.Trimesh) -> int:
    return _topology_snapshot(mesh).boundary_edges


def _is_edge_manifold(mesh: trimesh.Trimesh) -> bool:
    return _topology_snapshot(mesh).manifold


def _small_boundary_loops_from_snapshot(
    topology: _TopologySnapshot,
    max_vertices: int = 4,
) -> tuple[list[list[int]], int]:
    """Return isolated triangle/quad boundary loops from an existing topology snapshot."""

    boundary_edges = [
        edge for edge, occurrences in topology.edge_occurrences.items() if len(occurrences) == 1
    ]
    if not boundary_edges:
        return [], 0

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
        if any(len(topology.vertex_faces[vertex]) < 2 for vertex in component):
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
    return loops, len(boundary_edges)


def _small_boundary_loops(
    mesh: trimesh.Trimesh,
    max_vertices: int = 4,
) -> tuple[list[list[int]], int]:
    """Return isolated triangle/quad boundary loops and the boundary-edge count."""

    return _small_boundary_loops_from_snapshot(_topology_snapshot(mesh), max_vertices=max_vertices)


def _fill_small_boundary_holes(
    mesh: trimesh.Trimesh,
    topology: _TopologySnapshot | None = None,
) -> tuple[int, int]:
    """Fill only isolated triangular or quad holes without remeshing."""

    topology = topology or _topology_snapshot(mesh)
    loops, boundary_edges_before = _small_boundary_loops_from_snapshot(topology, max_vertices=4)
    if not loops:
        return 0, boundary_edges_before

    new_faces: list[list[int]] = []
    for loop in loops:
        if len(loop) == 3:
            new_faces.append(loop)
        elif len(loop) == 4:
            new_faces.append([loop[0], loop[1], loop[2]])
            new_faces.append([loop[0], loop[2], loop[3]])

    if not new_faces:
        return 0, boundary_edges_before
    original_face_count = len(mesh.faces)
    new_faces_array = np.asarray(new_faces, dtype=int)
    mesh.faces = np.vstack((np.asarray(mesh.faces, dtype=int), new_faces_array))
    _append_faces_to_topology(topology, new_faces_array, original_face_count)
    return len(loops), boundary_edges_before


def _game_ready_mesh_is_healthy(mesh: trimesh.Trimesh) -> bool:
    """Avoid geometry-changing repair when the source already has sound topology."""

    topology = _topology_snapshot(mesh)
    return (
        topology.watertight
        and topology.manifold
        and topology.boundary_edges == 0
        and len(topology.components) == 1
    )


def _remove_small_components(
    mesh: trimesh.Trimesh,
    min_area_ratio: float,
    topology: _TopologySnapshot | None = None,
) -> int:
    topology = topology or _topology_snapshot(mesh)
    components = topology.components
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
    if removed == 0:
        return 0
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


def _signed_mesh_volume(
    vertices: np.ndarray,
    faces: np.ndarray,
    chunk_size: int = 65536,
) -> float:
    """Compute signed triangle volume in bounded chunks to avoid huge temporary arrays."""

    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    faces_array = np.asarray(faces, dtype=int)
    if len(faces_array) == 0:
        return 0.0
    vertices_array = np.asarray(vertices)
    signed_six_volume = 0.0
    for start in range(0, len(faces_array), chunk_size):
        batch = faces_array[start : start + chunk_size]
        first = vertices_array[batch[:, 0]]
        second = vertices_array[batch[:, 1]]
        third = vertices_array[batch[:, 2]]
        signed_six_volume += float(
            np.einsum("ij,ij->", first, np.cross(second, third))
        )
    return signed_six_volume / 6.0


def _repair_face_winding(
    mesh: trimesh.Trimesh,
    topology: _TopologySnapshot | None = None,
    timings: dict[str, float] | None = None,
) -> _TopologySnapshot:
    """Orient adjacent triangle winding consistently without changing connectivity."""

    if timings is not None:
        timings.setdefault("repair_winding_graph_build", 0.0)
        timings.setdefault("repair_winding_graph_walk", 0.0)
        timings.setdefault("repair_winding_volume", 0.0)

    topology = topology or _topology_snapshot(mesh)
    faces_array = np.asarray(mesh.faces, dtype=int)
    if len(faces_array) == 0:
        return topology

    vertices = np.asarray(mesh.vertices)
    if topology.winding_consistent and len(topology.components) == 1:
        if topology.watertight:
            volume_started = time.perf_counter()
            signed_volume = _signed_mesh_volume(vertices, faces_array)
            if timings is not None:
                timings["repair_winding_volume"] += round(
                    (time.perf_counter() - volume_started) * 1000.0,
                    3,
                )
            if signed_volume < 0.0:
                mesh.faces = faces_array[:, [0, 2, 1]]
        return topology

    graph_started = time.perf_counter()
    faces = faces_array.copy()
    relations: list[list[tuple[int, int]]] = [[] for _ in range(len(faces))]
    for occurrences in topology.edge_occurrences.values():
        if len(occurrences) != 2:
            continue
        (first_face, first_direction), (second_face, second_direction) = occurrences
        required = -first_direction * second_direction
        relations[first_face].append((second_face, required))
        relations[second_face].append((first_face, required))
    if timings is not None:
        timings["repair_winding_graph_build"] = round(
            (time.perf_counter() - graph_started) * 1000.0,
            3,
        )

    walk_started = time.perf_counter()
    volume_ms = 0.0
    orientation = np.zeros(len(faces), dtype=np.int8)
    for component in topology.components:
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
        if topology.watertight:
            component_closed = True
        else:
            edge_counts: dict[tuple[int, int], int] = defaultdict(int)
            for face in component_faces:
                a, b, c = (int(face[0]), int(face[1]), int(face[2]))
                for first, second in ((a, b), (b, c), (c, a)):
                    key = (first, second) if first < second else (second, first)
                    edge_counts[key] += 1
            component_closed = bool(edge_counts) and all(
                count == 2 for count in edge_counts.values()
            )
        if component_closed:
            volume_started = time.perf_counter()
            signed_volume = _signed_mesh_volume(vertices, component_faces)
            volume_ms += (time.perf_counter() - volume_started) * 1000.0
            if signed_volume < 0.0:
                faces[component] = faces[component][:, [0, 2, 1]]

    if timings is not None:
        walk_total_ms = (time.perf_counter() - walk_started) * 1000.0
        timings["repair_winding_graph_walk"] = round(max(0.0, walk_total_ms - volume_ms), 3)
        timings["repair_winding_volume"] += round(volume_ms, 3)

    mesh.faces = faces
    return topology


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

    stage_started = time.perf_counter()
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
    report.stage_ms["heavy_repair"] = round((time.perf_counter() - stage_started) * 1000.0, 3)

    if progress is not None:
        progress("reducing_mesh", 0.45)

    def reduction_progress(attempt: int, total: int, _target: int) -> None:
        if progress is None:
            return
        fraction = (attempt - 1) / max(total, 1)
        progress("reducing_mesh", min(0.78, 0.45 + 0.30 * fraction))

    stage_started = time.perf_counter()
    reduced, reduction_stats = adaptive_qem_reduce(
        repaired,
        reduction_policy,
        progress=reduction_progress,
    )
    report.stage_ms["adaptive_reduction"] = round((time.perf_counter() - stage_started) * 1000.0, 3)

    if progress is not None:
        progress("validating_mesh", 0.80)

    stage_started = time.perf_counter()
    input_topology = _topology_snapshot(mesh)
    reduced_topology = _topology_snapshot(reduced)
    report.components_removed = repair_stats.components_removed
    report.watertight_before = repair_stats.watertight_before
    report.watertight_after = reduced_topology.watertight
    report.manifold_before = input_topology.manifold
    report.manifold_after = reduced_topology.manifold
    report.boundary_edges_before = repair_stats.boundary_edges_before
    report.boundary_edges_after = reduced_topology.boundary_edges
    report.holes_closed = repair_stats.holes_closed
    report.non_manifold_edges_fixed = repair_stats.non_manifold_edges_fixed
    report.remeshed = repair_stats.remeshed
    report.repair_backend = repair_stats.repair_backend
    report.normalized_error = reduction_stats.normalized_error
    report.target_triangles = reduction_stats.requested_target_faces
    report.warnings.extend(repair_stats.warnings)
    report.stage_ms["heavy_validation"] = round((time.perf_counter() - stage_started) * 1000.0, 3)

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
    settings = config.settings
    triangles_before = len(working.faces)
    vertices_before = len(working.vertices)

    pre_topology_degenerate_ms: float | None = None
    if config.preset not in {"game-ready", "aggressive"}:
        stage_started = time.perf_counter()
        if settings.remove_degenerate:
            _remove_degenerate_faces(working)
        pre_topology_degenerate_ms = round((time.perf_counter() - stage_started) * 1000.0, 3)

    stage_started = time.perf_counter()
    input_topology = _topology_snapshot(working)
    current_topology: _TopologySnapshot | None = input_topology
    before_components = len(input_topology.components)
    watertight_before = input_topology.watertight
    manifold_before = input_topology.manifold
    boundary_edges_before = input_topology.boundary_edges
    input_topology_ms = round((time.perf_counter() - stage_started) * 1000.0, 3)

    report = CleanupReport(
        preset=config.preset,
        config_label=config.label,
        algorithm_version=config.algorithm_version,
        triangles_before=triangles_before,
        triangles_after=len(working.faces),
        vertices_before=vertices_before,
        vertices_after=len(working.vertices),
        components_before=before_components,
        components_after=before_components,
        watertight_before=watertight_before,
        manifold_before=manifold_before,
        boundary_edges_before=boundary_edges_before,
        stage_ms={"input_topology": input_topology_ms},
    )
    if pre_topology_degenerate_ms is not None:
        report.stage_ms["remove_degenerate"] = pre_topology_degenerate_ms

    if config.preset in {"game-ready", "aggressive"}:
        working = _cleanup_heavy(working, config, report, progress=progress)
        current_topology = None
    else:
        if pre_topology_degenerate_ms is None:
            stage_started = time.perf_counter()
            if settings.remove_degenerate and _remove_degenerate_faces(working):
                current_topology = None
            report.stage_ms["remove_degenerate"] = round((time.perf_counter() - stage_started) * 1000.0, 3)

        stage_started = time.perf_counter()
        if settings.weld_vertices:
            report.vertices_welded = _weld_near_vertices(working, settings.weld_relative_epsilon)
            if report.vertices_welded:
                current_topology = None
        report.stage_ms["weld_vertices"] = round((time.perf_counter() - stage_started) * 1000.0, 3)

        stage_started = time.perf_counter()
        if settings.remove_small_islands:
            if current_topology is None:
                current_topology = _topology_snapshot(working)
            report.components_removed = _remove_small_components(
                working,
                settings.min_component_area_ratio,
                topology=current_topology,
            )
            if report.components_removed:
                current_topology = None
        report.stage_ms["remove_small_islands"] = round((time.perf_counter() - stage_started) * 1000.0, 3)

        stage_started = time.perf_counter()
        if config.preset == "light":
            if current_topology is None:
                current_topology = _topology_snapshot(working)
            pre_repair_topology = current_topology
            report.pre_repair_watertight = pre_repair_topology.watertight
            report.pre_repair_manifold = pre_repair_topology.manifold
            report.pre_repair_boundary_edges = pre_repair_topology.boundary_edges
            if not pre_repair_topology.watertight and pre_repair_topology.manifold:
                report.holes_closed, _boundary_edges = _fill_small_boundary_holes(
                    working,
                    topology=pre_repair_topology,
                )
                if report.holes_closed:
                    report.repair_backend = "native-small-hole-fill"
        report.stage_ms["small_hole_fill"] = round((time.perf_counter() - stage_started) * 1000.0, 3)

        stage_started = time.perf_counter()
        if settings.spike_cleanup:
            report.spikes_adjusted = _relax_spike_vertices(
                working,
                settings.spike_edge_ratio,
                settings.spike_max_area_ratio,
                settings.spike_normal_angle_deg,
            )
        report.stage_ms["spike_cleanup"] = round((time.perf_counter() - stage_started) * 1000.0, 3)

        stage_started = time.perf_counter()
        if settings.smooth_surface and settings.smoothing_iterations > 0:
            _taubin_smooth(
                working,
                settings.smoothing_iterations,
                settings.taubin_lambda,
                settings.taubin_nu,
            )
        report.stage_ms["smoothing"] = round((time.perf_counter() - stage_started) * 1000.0, 3)

        stage_started = time.perf_counter()
        if settings.recompute_normals:
            current_topology = _repair_face_winding(
                working,
                topology=current_topology,
                timings=report.stage_ms,
            )
        report.stage_ms["repair_winding"] = round((time.perf_counter() - stage_started) * 1000.0, 3)

    stage_started = time.perf_counter()
    working.remove_unreferenced_vertices()
    final_topology = current_topology or _topology_snapshot(working)
    report.triangles_after = len(working.faces)
    report.vertices_after = len(working.vertices)
    report.components_after = len(final_topology.components)
    report.watertight_after = final_topology.watertight
    report.manifold_after = final_topology.manifold
    report.boundary_edges_after = final_topology.boundary_edges
    report.reduction_ratio = (
        0.0
        if report.triangles_before == 0
        else max(0.0, 1.0 - report.triangles_after / report.triangles_before)
    )
    report.stage_ms["final_validation"] = round((time.perf_counter() - stage_started) * 1000.0, 3)
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
