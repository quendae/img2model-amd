import math
import time
from collections import defaultdict

import numpy as np
import trimesh

from .models import CleanupReport


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

        # Estimate the local contribution from a normal-sized face instead of
        # using the stretched spike triangles themselves, which would make an
        # obvious spike appear artificially important.
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
        # Neighbor orientation multiplier needed so the shared directed edge
        # runs in the opposite direction after applying each face flip.
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

        # For a closed component, choose outward-facing winding using signed volume.
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


def cleanup_mesh(mesh: trimesh.Trimesh, config):
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
    )
    settings = config.settings

    if settings.remove_degenerate:
        _remove_degenerate_faces(working)
    if settings.weld_vertices:
        report.vertices_welded = _weld_near_vertices(working, settings.weld_relative_epsilon)
    if settings.remove_small_islands:
        report.components_removed = _remove_small_components(working, settings.min_component_area_ratio)
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
    report.cleanup_ms = round((time.perf_counter() - started) * 1000.0, 3)

    removed_ratio = (
        0.0
        if report.triangles_before == 0
        else 1.0 - report.triangles_after / report.triangles_before
    )
    if report.components_before > 0 and report.components_removed > max(3, report.components_before // 4):
        report.warnings.append("Large number of small components removed.")
    if config.preset == "light" and removed_ratio > 0.20:
        report.warnings.append("Light cleanup removed more geometry than expected.")
    if config.preset == "game-ready" and removed_ratio > 0.40:
        report.warnings.append("Game-ready cleanup removed a large amount of geometry.")
    if config.preset == "aggressive":
        report.warnings.append("Aggressive cleanup may alter silhouette and fine detail.")
    if not working.is_watertight:
        report.warnings.append("Mesh is still not watertight after cleanup.")
    return working, report
