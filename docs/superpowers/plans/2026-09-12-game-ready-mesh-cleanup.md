# Game-ready Mesh Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reusable automatic mesh cleanup for generated Shape jobs and imported GLB/OBJ files, with conservative presets, preserved source geometry, Before/After comparison, cleanup telemetry, and retry-safe integration with the existing Hunyuan Paint workflow.

**Architecture:** Introduce a CPU-side `backends/mesh_processing` package that owns preset resolution, geometry operations, atomic export, cache identity, and cleanup reporting. The existing persistent Hunyuan worker remains the JSONL process/orchestrator and gains a `mesh_cleanup` command; Rust/Tauri forwards that command; React adds `Mesh` mode and composes Shape -> Cleanup -> optional Texture without embedding cleanup logic inside the Hunyuan-specific code.

**Tech Stack:** Python 3.11, `trimesh`, `numpy`, existing Hunyuan worker JSONL protocol, Rust/Tauri 2, React + TypeScript, Three.js, Vitest, Rust tests, Python `unittest`.

**Spec:** `docs/superpowers/specs/2026-09-12-game-ready-mesh-cleanup-design.md`

## Global Constraints

- Top-level workflow modes are exactly `Shape | Texture | Mesh`.
- Shape default cleanup preset is `Light`; Mesh default cleanup preset is `Game-ready`.
- Cleanup never overwrites the input mesh.
- Shape + Texture preserves raw `*-shape` and cleaned `*-clean` intermediates when cleanup is enabled.
- Topology-changing cleanup runs before Hunyuan Paint.
- `Retry texture only` reuses the cleaned mesh after a successful cleanup.
- Presets are parameter sets over one common cleanup pipeline; do not implement four separate algorithms.
- `ALGORITHM_VERSION` is owned by the mesh-processing package and is never user-editable.
- Cleanup-derived cache and texture prepared-mesh cache remain separate concepts.
- Image cache and Hunyuan Paint model cache remain valid when only cleanup settings change.
- Light must remain conservative: no general smoothing and no spike cleanup by default.
- Aggressive must surface a visible warning that silhouette/fine detail may change.
- Do not add PyMeshLab, SciPy, or another geometry framework in this milestone; implement Taubin smoothing with NumPy/mesh adjacency.
- No LOD, collision, ground alignment, flatten-bottom, pivot, UV editor, local remesh, or manual face/vertex editor in this milestone.
- Preserve UV seams during vertex welding (`merge_tex=False`, `merge_norm=False`); v1 is geometry-first and does not rebake textures.
- The existing warm Texture benchmark (~29 s for cached Balanced on RX 6950 XT) must not regress because of hidden cleanup work inside texture preprocessing.
- Use test-first development for every behavior change.

---

## File Structure

### New Python mesh-processing package

- `backends/mesh_processing/__init__.py` — stable public exports.
- `backends/mesh_processing/models.py` — preset/settings/report dataclasses and serialization.
- `backends/mesh_processing/presets.py` — stock preset values, normalization, custom-label logic, `ALGORITHM_VERSION`.
- `backends/mesh_processing/cleanup.py` — deterministic geometry operations and `cleanup_mesh`.
- `backends/mesh_processing/io.py` — GLB/OBJ load + atomic export + source-preservation checks.
- `backends/mesh_processing/cache.py` — cleanup cache key and one-entry in-memory cleaned-mesh cache.
- `backends/mesh_processing/tests/test_presets.py`
- `backends/mesh_processing/tests/test_cleanup.py`
- `backends/mesh_processing/tests/test_io.py`
- `backends/mesh_processing/tests/test_cache.py`

### Existing Python worker/runtime

- `backends/hunyuan/worker.py` — import and expose mesh cleanup through CLI/JSONL; keep orchestration only.
- `backends/hunyuan/tests/test_worker.py` — worker protocol tests for `mesh_cleanup` and protocol version.
- `backends/hunyuan/requirements-base.txt` — make `numpy` and `trimesh` explicit runtime dependencies.
- `scripts/setup/windows-native-rocm.ps1` — copy `mesh_processing` package into the persistent runtime next to `worker.py`.
- `backends/hunyuan/tests/test_windows_scripts.py` — verify package copy/install paths.
- `.github/workflows/ci.yml` — install base requirements and run both Hunyuan and mesh-processing Python test suites.

### Rust/Tauri bridge

- `apps/desktop/src-tauri/src/worker.rs` — cleanup request/report/result fields.
- `apps/desktop/src-tauri/src/worker_session.rs` — `mesh_cleanup` JSONL command and manager method.
- `apps/desktop/src-tauri/src/lib.rs` — Tauri `cleanup_mesh` command.

### Frontend domain/API/workflows

- `apps/desktop/src/domain/types.ts` — mesh mode, presets/settings/report, timing fields.
- `apps/desktop/src/lib/tauri.ts` — `MeshCleanupRequest`, cleanup result fields, `cleanupMesh()`.
- `apps/desktop/src/lib/useGenerationJob.ts` — Shape -> Cleanup -> Texture orchestration and standalone Mesh workflow.
- `apps/desktop/src/lib/useGenerationJob.test.ts` — workflow and retry tests.
- `apps/desktop/src/components/GenerationPanel.tsx` — Mesh tab, preset controls, Advanced controls.
- `apps/desktop/src/components/GenerationPanel.test.tsx` — defaults, Mesh mode, custom label, Aggressive warning.
- `apps/desktop/src/components/ModelViewer.tsx` — Before/After comparison controls.
- `apps/desktop/src/components/ModelViewer.test.tsx` — comparison state/labels without testing WebGL rendering itself.
- `apps/desktop/src/App.tsx` — mode-specific input/output selection, comparison paths, Activity report.
- `apps/desktop/src/App.test.tsx` — cleanup Activity/report and standalone Mesh behavior.

---

### Task 1: Define mesh-cleanup domain types, presets, normalization, and reporting

**Files:**
- Create: `backends/mesh_processing/__init__.py`
- Create: `backends/mesh_processing/models.py`
- Create: `backends/mesh_processing/presets.py`
- Create: `backends/mesh_processing/tests/__init__.py`
- Create: `backends/mesh_processing/tests/test_presets.py`

**Interfaces:**
- Produces: `CleanupPreset`, `CleanupSettings`, `ResolvedCleanupConfig`, `CleanupReport`, `ALGORITHM_VERSION`, `resolve_cleanup_config(preset, overrides)`.
- Consumed by: Tasks 2-8.

- [ ] **Step 1: Write the failing preset tests**

Create `test_presets.py`:

```python
import unittest

from backends.mesh_processing.presets import ALGORITHM_VERSION, resolve_cleanup_config


class CleanupPresetTests(unittest.TestCase):
    def test_light_is_conservative(self):
        config = resolve_cleanup_config("light", {})
        self.assertEqual(config.label, "Light")
        self.assertTrue(config.settings.remove_degenerate)
        self.assertTrue(config.settings.remove_small_islands)
        self.assertTrue(config.settings.weld_vertices)
        self.assertFalse(config.settings.spike_cleanup)
        self.assertFalse(config.settings.smooth_surface)

    def test_game_ready_enables_spike_cleanup_and_taubin_smoothing(self):
        config = resolve_cleanup_config("game-ready", {})
        self.assertTrue(config.settings.spike_cleanup)
        self.assertTrue(config.settings.smooth_surface)
        self.assertGreater(config.settings.smoothing_iterations, 0)
        self.assertLess(config.settings.taubin_nu, 0.0)

    def test_advanced_override_becomes_custom(self):
        config = resolve_cleanup_config("game-ready", {"smoothing_iterations": 0})
        self.assertEqual(config.label, "Custom (from Game-ready)")
        self.assertEqual(config.settings.smoothing_iterations, 0)

    def test_algorithm_version_is_internal_nonempty_string(self):
        self.assertTrue(ALGORITHM_VERSION.startswith("mesh-cleanup-v"))

    def test_invalid_preset_raises(self):
        with self.assertRaisesRegex(ValueError, "Unsupported cleanup preset"):
            resolve_cleanup_config("destroy-everything", {})
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
python -m unittest backends.mesh_processing.tests.test_presets -v
```

Expected: import failure because the package is not implemented.

- [ ] **Step 3: Implement dataclasses in `models.py`**

```python
from dataclasses import asdict, dataclass, field
from typing import Literal

CleanupPreset = Literal["off", "light", "game-ready", "aggressive"]


@dataclass(frozen=True)
class CleanupSettings:
    remove_degenerate: bool
    weld_vertices: bool
    weld_relative_epsilon: float
    remove_small_islands: bool
    min_component_area_ratio: float
    spike_cleanup: bool
    spike_edge_ratio: float
    spike_max_area_ratio: float
    spike_normal_angle_deg: float
    smooth_surface: bool
    smoothing_iterations: int
    taubin_lambda: float
    taubin_nu: float
    recompute_normals: bool


@dataclass(frozen=True)
class ResolvedCleanupConfig:
    preset: CleanupPreset
    label: str
    algorithm_version: str
    settings: CleanupSettings


@dataclass
class CleanupReport:
    preset: str
    config_label: str
    algorithm_version: str
    triangles_before: int
    triangles_after: int
    vertices_before: int
    vertices_after: int
    components_before: int
    components_after: int
    components_removed: int = 0
    vertices_welded: int = 0
    spikes_adjusted: int = 0
    cleanup_ms: float = 0.0
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return asdict(self)
```

- [ ] **Step 4: Implement exact initial preset values in `presets.py`**

```python
from dataclasses import asdict
from .models import CleanupSettings, ResolvedCleanupConfig

ALGORITHM_VERSION = "mesh-cleanup-v1"

PRESET_SETTINGS = {
    "off": CleanupSettings(False, False, 0.0, False, 0.0, False, 0.0, 0.0, 0.0, False, 0, 0.0, 0.0, False),
    "light": CleanupSettings(True, True, 1e-7, True, 1e-5, False, 0.0, 0.0, 0.0, False, 0, 0.0, 0.0, True),
    "game-ready": CleanupSettings(True, True, 1e-6, True, 5e-4, True, 4.0, 5e-4, 55.0, True, 2, 0.25, -0.26, True),
    "aggressive": CleanupSettings(True, True, 5e-6, True, 2e-3, True, 2.75, 1.5e-3, 40.0, True, 4, 0.35, -0.36, True),
}

_LABELS = {
    "off": "Off",
    "light": "Light",
    "game-ready": "Game-ready",
    "aggressive": "Aggressive",
}
_ALLOWED_OVERRIDE_KEYS = set(CleanupSettings.__dataclass_fields__)


def resolve_cleanup_config(preset: str, overrides: dict[str, object] | None) -> ResolvedCleanupConfig:
    if preset not in PRESET_SETTINGS:
        raise ValueError(f"Unsupported cleanup preset: {preset}")
    base = PRESET_SETTINGS[preset]
    values = asdict(base)
    overrides = overrides or {}
    unknown = set(overrides) - _ALLOWED_OVERRIDE_KEYS
    if unknown:
        raise ValueError(f"Unsupported cleanup setting(s): {', '.join(sorted(unknown))}")
    values.update(overrides)
    settings = CleanupSettings(**values)
    if not 0 <= settings.smoothing_iterations <= 20:
        raise ValueError("smoothing_iterations must be between 0 and 20")
    if not 0.0 <= settings.weld_relative_epsilon <= 1e-2:
        raise ValueError("weld_relative_epsilon must be between 0 and 0.01")
    if not 0.0 <= settings.min_component_area_ratio <= 0.25:
        raise ValueError("min_component_area_ratio must be between 0 and 0.25")
    label = _LABELS[preset]
    changed = any(values[key] != getattr(base, key) for key in overrides)
    if changed:
        label = f"Custom (from {label})"
    return ResolvedCleanupConfig(preset, label, ALGORITHM_VERSION, settings)
```

Export stable names from `backends/mesh_processing/__init__.py`.

- [ ] **Step 5: Run preset tests and verify GREEN**

```bash
python -m unittest backends.mesh_processing.tests.test_presets -v
```

Expected: all tests pass.

- [ ] **Step 6: Commit Task 1**

```bash
git add backends/mesh_processing
git commit -m "feat: define mesh cleanup presets and report"
```

---

### Task 2: Implement deterministic cleanup, conservative spike relaxation, and atomic GLB/OBJ export

**Files:**
- Create: `backends/mesh_processing/cleanup.py`
- Create: `backends/mesh_processing/io.py`
- Create: `backends/mesh_processing/tests/test_cleanup.py`
- Create: `backends/mesh_processing/tests/test_io.py`

**Interfaces:**
- Consumes: `ResolvedCleanupConfig`, `CleanupReport`.
- Produces: `cleanup_mesh(mesh, config) -> tuple[trimesh.Trimesh, CleanupReport]`, `load_mesh(path)`, `export_mesh_atomic(mesh, output_path)`, `process_mesh(input_path, output_path, config) -> CleanupReport`.

- [ ] **Step 1: Write failing geometry tests**

```python
import unittest
import numpy as np
import trimesh

from backends.mesh_processing.cleanup import cleanup_mesh
from backends.mesh_processing.presets import resolve_cleanup_config


class CleanupGeometryTests(unittest.TestCase):
    def test_light_removes_tiny_disconnected_island(self):
        main = trimesh.creation.box(extents=[1.0, 1.0, 1.0])
        island = trimesh.creation.box(extents=[0.005, 0.005, 0.005])
        island.apply_translation([2.0, 0.0, 0.0])
        source = trimesh.util.concatenate([main, island])
        cleaned, report = cleanup_mesh(source, resolve_cleanup_config("light", {}))
        self.assertLess(report.components_after, report.components_before)
        self.assertGreaterEqual(report.components_removed, 1)
        self.assertLess(len(cleaned.faces), len(source.faces))

    def test_game_ready_reduces_artificial_spike_height(self):
        source = trimesh.creation.icosphere(subdivisions=2, radius=1.0)
        tip = int(np.argmax(source.vertices[:, 2]))
        source.vertices[tip] *= 5.0
        source_max_z = float(source.vertices[:, 2].max())
        cleaned, report = cleanup_mesh(source, resolve_cleanup_config("game-ready", {}))
        self.assertGreaterEqual(report.spikes_adjusted, 1)
        self.assertLess(float(cleaned.vertices[:, 2].max()), source_max_z)

    def test_thin_legitimate_feature_survives_game_ready(self):
        body = trimesh.creation.box(extents=[1.0, 1.0, 1.0])
        stem = trimesh.creation.cylinder(radius=0.05, height=1.0, sections=16)
        stem.apply_translation([0.0, 0.0, 1.0])
        source = trimesh.util.concatenate([body, stem])
        cleaned, report = cleanup_mesh(source, resolve_cleanup_config("game-ready", {}))
        self.assertEqual(report.components_removed, 0)
        self.assertGreater(float(cleaned.bounds[1][2]), 1.4)

    def test_off_preserves_counts(self):
        source = trimesh.creation.box()
        cleaned, report = cleanup_mesh(source, resolve_cleanup_config("off", {}))
        self.assertEqual(len(cleaned.vertices), len(source.vertices))
        self.assertEqual(len(cleaned.faces), len(source.faces))
        self.assertEqual(report.spikes_adjusted, 0)
```

- [ ] **Step 2: Write failing I/O preservation tests**

```python
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import trimesh

from backends.mesh_processing.io import process_mesh
from backends.mesh_processing.presets import resolve_cleanup_config


class CleanupIoTests(unittest.TestCase):
    def test_process_mesh_keeps_source_unchanged(self):
        with TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.glb"
            output = Path(tmp) / "source-clean.glb"
            trimesh.creation.box().export(source)
            before = source.read_bytes()
            report = process_mesh(source, output, resolve_cleanup_config("light", {}))
            self.assertEqual(source.read_bytes(), before)
            self.assertTrue(output.is_file())
            self.assertGreater(report.triangles_after, 0)

    def test_refuses_same_input_and_output_path(self):
        with TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.glb"
            trimesh.creation.box().export(source)
            with self.assertRaisesRegex(ValueError, "must differ"):
                process_mesh(source, source, resolve_cleanup_config("light", {}))
```

- [ ] **Step 3: Run Task 2 tests and verify RED**

```bash
python -m unittest backends.mesh_processing.tests.test_cleanup backends.mesh_processing.tests.test_io -v
```

Expected: missing cleanup/I/O implementations.

- [ ] **Step 4: Implement common geometry helpers in `cleanup.py`**

Use scale-relative tolerances:

```python
import math
import time
import numpy as np
import trimesh


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


def _face_components(mesh: trimesh.Trimesh) -> list[np.ndarray]:
    if len(mesh.faces) == 0:
        return []
    return [
        np.asarray(component, dtype=int)
        for component in trimesh.graph.connected_components(
            mesh.face_adjacency,
            nodes=np.arange(len(mesh.faces)),
            min_len=1,
        )
    ]


def _remove_small_components(mesh: trimesh.Trimesh, min_area_ratio: float) -> int:
    components = _face_components(mesh)
    if len(components) <= 1:
        return 0
    face_areas = np.asarray(mesh.area_faces)
    areas = [float(face_areas[c].sum()) for c in components]
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
```

- [ ] **Step 5: Implement multi-signal spike relaxation**

Use helpers with exact conditions. Do not delete spike faces.

```python
def _triangle_aspect(vertices: np.ndarray) -> float:
    edges = np.array([
        np.linalg.norm(vertices[0] - vertices[1]),
        np.linalg.norm(vertices[1] - vertices[2]),
        np.linalg.norm(vertices[2] - vertices[0]),
    ])
    shortest = max(float(edges.min()), 1e-12)
    return float(edges.max()) / shortest


def _normal_spread_deg(normals: np.ndarray) -> float:
    if len(normals) < 2:
        return 0.0
    unit = normals / np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
    dots = np.clip(unit @ unit.T, -1.0, 1.0)
    return float(np.degrees(np.arccos(dots.min())))


def _relax_spike_vertices(mesh, edge_ratio, max_area_ratio, normal_angle_deg) -> int:
    vertices = np.asarray(mesh.vertices).copy()
    vertex_faces = np.asarray(mesh.vertex_faces)
    total_area = max(float(mesh.area), 1e-12)
    adjusted: dict[int, np.ndarray] = {}

    for vertex_index, neighbors in enumerate(mesh.vertex_neighbors):
        if len(neighbors) < 3:
            continue
        neighbor_idx = np.asarray(neighbors, dtype=int)
        incident_lengths = np.linalg.norm(vertices[neighbor_idx] - vertices[vertex_index], axis=1)

        reference_lengths: list[float] = []
        for neighbor in neighbors:
            for second in mesh.vertex_neighbors[neighbor]:
                if second == vertex_index:
                    continue
                reference_lengths.append(float(np.linalg.norm(vertices[second] - vertices[neighbor])))
        if not reference_lengths:
            continue
        reference = max(float(np.median(reference_lengths)), 1e-12)
        if float(incident_lengths.max()) / reference < edge_ratio:
            continue

        faces = vertex_faces[vertex_index]
        faces = faces[faces >= 0]
        if len(faces) < 2:
            continue
        incident_area = float(np.asarray(mesh.area_faces)[faces].sum())
        if incident_area / total_area > max_area_ratio:
            continue

        incident_triangles = np.asarray(mesh.vertices)[np.asarray(mesh.faces)[faces]]
        max_aspect = max(_triangle_aspect(triangle) for triangle in incident_triangles)
        if max_aspect < max(6.0, edge_ratio * 2.0):
            continue

        normals = np.asarray(mesh.face_normals)[faces]
        if _normal_spread_deg(normals) < normal_angle_deg:
            continue

        median_neighbor = np.median(vertices[neighbor_idx], axis=0)
        adjusted[vertex_index] = 0.5 * vertices[vertex_index] + 0.5 * median_neighbor

    for vertex_index, position in adjusted.items():
        vertices[vertex_index] = position
    if adjusted:
        mesh.vertices = vertices
    return len(adjusted)
```

- [ ] **Step 6: Implement NumPy Taubin smoothing without SciPy**

```python
def _laplacian_step(vertices: np.ndarray, neighbors: list[list[int]], factor: float) -> np.ndarray:
    source = vertices.copy()
    result = source.copy()
    for index, adjacent in enumerate(neighbors):
        if len(adjacent) < 3:
            continue
        mean = source[np.asarray(adjacent, dtype=int)].mean(axis=0)
        result[index] = source[index] + factor * (mean - source[index])
    return result


def _taubin_smooth(mesh, iterations: int, lamb: float, nu: float) -> None:
    neighbors = [list(values) for values in mesh.vertex_neighbors]
    vertices = np.asarray(mesh.vertices).copy()
    for _iteration in range(iterations):
        vertices = _laplacian_step(vertices, neighbors, lamb)
        vertices = _laplacian_step(vertices, neighbors, nu)
    mesh.vertices = vertices
```

- [ ] **Step 7: Implement `cleanup_mesh` and stable warnings**

```python
def cleanup_mesh(mesh, config):
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
        _taubin_smooth(working, settings.smoothing_iterations, settings.taubin_lambda, settings.taubin_nu)
    if settings.recompute_normals:
        working.fix_normals(multibody=True)

    working.remove_unreferenced_vertices()
    report.triangles_after = len(working.faces)
    report.vertices_after = len(working.vertices)
    report.components_after = len(_face_components(working))
    report.cleanup_ms = round((time.perf_counter() - started) * 1000.0, 3)

    removed_ratio = 0.0 if report.triangles_before == 0 else 1.0 - report.triangles_after / report.triangles_before
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
```

- [ ] **Step 8: Implement atomic I/O**

```python
import os
from pathlib import Path
import trimesh


def load_mesh(path: Path):
    loaded = trimesh.load(str(path), force="mesh", process=False)
    if not isinstance(loaded, trimesh.Trimesh):
        raise ValueError("Mesh input could not be converted to one Trimesh")
    return loaded


def export_mesh_atomic(mesh, output_path: Path) -> None:
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
```

- [ ] **Step 9: Run Task 2 tests and verify GREEN**

```bash
python -m unittest backends.mesh_processing.tests.test_cleanup backends.mesh_processing.tests.test_io -v
```

Expected: all tests pass.

- [ ] **Step 10: Commit Task 2**

```bash
git add backends/mesh_processing
git commit -m "feat: add automatic mesh cleanup engine"
```

---

### Task 3: Add cleanup cache, worker command, runtime packaging, and Python CI

**Files:**
- Create: `backends/mesh_processing/cache.py`
- Create: `backends/mesh_processing/tests/test_cache.py`
- Modify: `backends/hunyuan/worker.py`
- Modify: `backends/hunyuan/tests/test_worker.py`
- Modify: `backends/hunyuan/requirements-base.txt`
- Modify: `scripts/setup/windows-native-rocm.ps1`
- Modify: `backends/hunyuan/tests/test_windows_scripts.py`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `cleanup_cache_key(path, config)`, `CleanupMeshCache`, JSONL command `mesh_cleanup`, worker result fields `cleanup_report`, `mesh_cleanup_ms`, `cleanup_cache_hit`.

- [ ] **Step 1: Write failing cleanup-cache tests**

```python
class CleanupCacheTests(unittest.TestCase):
    def test_preset_changes_key(self):
        light = cleanup_cache_key(self.path, resolve_cleanup_config("light", {}))
        game = cleanup_cache_key(self.path, resolve_cleanup_config("game-ready", {}))
        self.assertNotEqual(light, game)

    def test_override_changes_key(self):
        stock = cleanup_cache_key(self.path, resolve_cleanup_config("game-ready", {}))
        custom = cleanup_cache_key(self.path, resolve_cleanup_config("game-ready", {"smoothing_iterations": 0}))
        self.assertNotEqual(stock, custom)

    def test_file_mtime_changes_key(self):
        first = cleanup_cache_key(self.path, resolve_cleanup_config("light", {}))
        stat = self.path.stat()
        os.utime(self.path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
        second = cleanup_cache_key(self.path, resolve_cleanup_config("light", {}))
        self.assertNotEqual(first, second)
```

- [ ] **Step 2: Run cache tests and verify RED**

```bash
python -m unittest backends.mesh_processing.tests.test_cache -v
```

Expected: missing cache module.

- [ ] **Step 3: Implement the bounded cleanup cache**

```python
import copy
from dataclasses import asdict
from pathlib import Path


def cleanup_cache_key(path: Path, config) -> tuple[object, ...]:
    resolved = path.expanduser().resolve()
    stat = resolved.stat()
    return (
        str(resolved),
        stat.st_size,
        stat.st_mtime_ns,
        config.preset,
        config.algorithm_version,
        tuple(sorted(asdict(config.settings).items())),
    )


class CleanupMeshCache:
    def __init__(self):
        self.key = None
        self.mesh = None
        self.report = None

    def get_or_create(self, key, loader):
        if self.mesh is not None and self.key == key:
            return self.mesh.copy(), copy.deepcopy(self.report), True
        mesh, report = loader()
        self.key = key
        self.mesh = mesh.copy()
        self.report = copy.deepcopy(report)
        return mesh.copy(), copy.deepcopy(report), False

    def clear(self):
        self.key = None
        self.mesh = None
        self.report = None
```

- [ ] **Step 4: Write failing worker JSONL tests**

Add a `mesh_cleanup` dispatch test and change the handshake expectation to protocol version `2`:

```python
def test_mesh_cleanup_command_dispatches_request(self):
    events = []
    message = {
        "command": "mesh_cleanup",
        "job_id": "job-mesh-1",
        "request": {
            "input": "source.glb",
            "output": "source-clean.glb",
            "preset": "game-ready",
            "overrides": {"smoothing_iterations": 1},
        },
    }
    with mock.patch.object(worker, "run_mesh_cleanup", return_value=0) as run:
        worker.dispatch_serve_command(message, cache=worker.PipelineCache(), emit_fn=events.append)
    args = run.call_args.args[0]
    self.assertEqual(args.input, "source.glb")
    self.assertEqual(args.output, "source-clean.glb")
    self.assertEqual(args.preset, "game-ready")
    self.assertEqual(args.overrides["smoothing_iterations"], 1)
```

- [ ] **Step 5: Run worker tests and verify RED**

```bash
python -m unittest backends.hunyuan.tests.test_worker -v
```

Expected: missing command/namespace and version mismatch.

- [ ] **Step 6: Integrate the cleanup cache into `PipelineCache`**

In `PipelineCache.__init__`:

```python
from backends.mesh_processing.cache import CleanupMeshCache
self.cleanup_mesh_cache = CleanupMeshCache()
```

In `PipelineCache.clear()` call:

```python
self.cleanup_mesh_cache.clear()
```

Keep `prepared_mesh` unchanged and separate.

- [ ] **Step 7: Implement `run_mesh_cleanup` in the worker**

```python
def run_mesh_cleanup(args: argparse.Namespace, cache: PipelineCache | None = None) -> int:
    from backends.mesh_processing.cache import cleanup_cache_key
    from backends.mesh_processing.cleanup import cleanup_mesh
    from backends.mesh_processing.io import export_mesh_atomic, load_mesh
    from backends.mesh_processing.presets import resolve_cleanup_config

    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    if input_path == output_path:
        emit("error", ok=False, stage="mesh_cleanup", error_kind="invalid_input", error="Input and output mesh paths must differ")
        return 2
    if not input_path.is_file():
        emit("error", ok=False, stage="mesh_cleanup", error_kind="invalid_input", error=f"Input mesh does not exist: {input_path}")
        return 2
    if input_path.suffix.lower() not in {".glb", ".obj"} or output_path.suffix.lower() not in {".glb", ".obj"}:
        emit("error", ok=False, stage="mesh_cleanup", error_kind="invalid_input", error="Mesh cleanup supports only .glb and .obj")
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

        emit("progress", ok=True, stage="exporting_clean_mesh", progress=0.85, cleanup_cache_hit=cleanup_cache_hit)
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
```

- [ ] **Step 8: Add namespace, CLI command, and JSONL dispatch**

```python
def _mesh_cleanup_namespace(request: dict[str, Any]) -> argparse.Namespace:
    return argparse.Namespace(
        input=request["input"],
        output=request["output"],
        preset=str(request.get("preset", "game-ready")),
        overrides=dict(request.get("overrides") or {}),
    )
```

Add to `dispatch_serve_command`:

```python
if command == "mesh_cleanup":
    request = message.get("request")
    if not isinstance(request, dict):
        raise ValueError("mesh_cleanup command requires a request object")
    run_mesh_cleanup(_mesh_cleanup_namespace(request), cache=cache)
    return True
```

Set Python `PROTOCOL_VERSION = 2`.

Add parser:

```python
mesh_cleanup = subparsers.add_parser("mesh-cleanup", help="Clean an existing GLB/OBJ mesh")
mesh_cleanup.add_argument("--input", required=True)
mesh_cleanup.add_argument("--output", required=True)
mesh_cleanup.add_argument("--preset", choices=["off", "light", "game-ready", "aggressive"], default="game-ready")
mesh_cleanup.set_defaults(overrides={}, func=run_mesh_cleanup)
```

- [ ] **Step 9: Make runtime dependencies and package copy explicit**

Set `requirements-base.txt` to:

```text
# Lightweight worker-side dependencies. PyTorch and Hunyuan3D are installed separately.
Pillow>=10.0
numpy>=1.26
trimesh>=4.0
```

In `windows-native-rocm.ps1` add:

```powershell
$MeshProcessingSource = Join-Path $RepoRoot "backends\mesh_processing"
$InstalledBackendsRoot = Join-Path $RuntimeDir "backends"
$InstalledMeshProcessing = Join-Path $InstalledBackendsRoot "mesh_processing"
New-Item -ItemType Directory -Force -Path $InstalledBackendsRoot | Out-Null
Set-Content -Path (Join-Path $InstalledBackendsRoot "__init__.py") -Value ""
if (Test-Path $InstalledMeshProcessing) { Remove-Item -Recurse -Force $InstalledMeshProcessing }
Copy-Item -Recurse -Force $MeshProcessingSource $InstalledMeshProcessing
```

The copy happens in the existing worker-install step for both normal setup and `-VerifyOnly`.

Extend `test_windows_scripts.py` to assert these variable names and recursive copy statements exist.

- [ ] **Step 10: Update Python CI**

Change `python-worker` steps to:

```yaml
- run: python -m pip install -r backends/hunyuan/requirements-base.txt
- run: python -m unittest discover -s backends/hunyuan/tests -v
- run: python -m unittest discover -s backends/mesh_processing/tests -v
```

- [ ] **Step 11: Run all Python tests and verify GREEN**

```bash
python -m pip install -r backends/hunyuan/requirements-base.txt
python -m unittest discover -s backends/hunyuan/tests -v
python -m unittest discover -s backends/mesh_processing/tests -v
```

Expected: zero failures.

- [ ] **Step 12: Commit Task 3**

```bash
git add backends/hunyuan backends/mesh_processing scripts/setup/windows-native-rocm.ps1 .github/workflows/ci.yml
git commit -m "feat: expose mesh cleanup through persistent worker"
```

---

### Task 4: Add typed Rust/Tauri cleanup transport

**Files:**
- Modify: `apps/desktop/src-tauri/src/worker.rs`
- Modify: `apps/desktop/src-tauri/src/worker_session.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes worker protocol from Task 3.
- Produces Tauri command `cleanup_mesh` and typed `MeshCleanupRequest`, `MeshCleanupReport`.

- [ ] **Step 1: Write failing Rust request/result tests**

In `worker.rs` tests:

```rust
#[test]
fn mesh_cleanup_request_serializes_expected_fields() {
    let request = MeshCleanupRequest {
        input: "source.glb".into(),
        output: "source-clean.glb".into(),
        preset: "game-ready".into(),
        overrides: Some(serde_json::json!({"smoothing_iterations": 1})),
    };
    let value = serde_json::to_value(request).unwrap();
    assert_eq!(value["input"], "source.glb");
    assert_eq!(value["preset"], "game-ready");
    assert_eq!(value["overrides"]["smoothing_iterations"], 1);
}
```

Add a decode test for `cleanup_report`, `mesh_cleanup_ms`, and `cleanup_cache_hit`.

In `worker_session.rs` tests:

```rust
#[test]
fn mesh_cleanup_command_has_request_and_job_id() {
    let request = MeshCleanupRequest {
        input: "source.glb".into(),
        output: "source-clean.glb".into(),
        preset: "game-ready".into(),
        overrides: None,
    };
    let value = mesh_cleanup_command("job-10", &request);
    assert_eq!(value["command"], "mesh_cleanup");
    assert_eq!(value["job_id"], "job-10");
    assert_eq!(value["request"]["preset"], "game-ready");
}
```

- [ ] **Step 2: Run Rust tests and verify RED**

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
```

Expected: missing cleanup types/functions.

- [ ] **Step 3: Add Rust types to `worker.rs`**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshCleanupRequest {
    pub input: String,
    pub output: String,
    pub preset: String,
    pub overrides: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshCleanupReport {
    pub preset: String,
    pub config_label: String,
    pub algorithm_version: String,
    pub triangles_before: u64,
    pub triangles_after: u64,
    pub vertices_before: u64,
    pub vertices_after: u64,
    pub components_before: u64,
    pub components_after: u64,
    pub components_removed: Option<u64>,
    pub vertices_welded: Option<u64>,
    pub spikes_adjusted: Option<u64>,
    pub cleanup_ms: f64,
    pub warnings: Vec<String>,
}
```

Add these optional fields to both `WorkerProgressEvent` and `GenerateResult`:

```rust
pub cleanup_cache_hit: Option<bool>,
pub cleanup_report: Option<MeshCleanupReport>,
pub mesh_cleanup_ms: Option<f64>,
```

Initialize them to `None` in `failure_result`.

- [ ] **Step 4: Add session command and manager method**

Set Rust `PROTOCOL_VERSION: u64 = 2`.

```rust
fn mesh_cleanup_command(job_id: &str, request: &MeshCleanupRequest) -> Value {
    json!({
        "command": "mesh_cleanup",
        "job_id": job_id,
        "request": request,
    })
}
```

Inside `WorkerSession`:

```rust
fn run_mesh_cleanup<F>(
    &mut self,
    request: MeshCleanupRequest,
    on_event: F,
) -> Result<GenerateResult, SessionError>
where
    F: FnMut(WorkerProgressEvent),
{
    let job_id = self.next_job_id();
    let command = mesh_cleanup_command(&job_id, &request);
    self.run_generation(command, job_id, on_event)
}
```

Inside `WorkerSessionManager`:

```rust
pub fn run_mesh_cleanup<F>(
    &self,
    request: MeshCleanupRequest,
    on_event: F,
) -> Result<GenerateResult, String>
where
    F: FnMut(WorkerProgressEvent),
{
    let mut guard = self
        .inner
        .lock()
        .map_err(|_| "Persistent worker session lock is poisoned.".to_string())?;
    let result = self.get_or_spawn(&mut guard)?.run_mesh_cleanup(request, on_event);
    match result {
        Ok(result) => Ok(result),
        Err(error) => {
            Self::invalidate(&mut guard);
            Ok(failure_result(error.kind, error.message))
        }
    }
}
```

Do not perform `backend_is_implemented` validation because cleanup is CPU-side.

- [ ] **Step 5: Add Tauri command to `lib.rs`**

```rust
#[tauri::command]
async fn cleanup_mesh(
    app: tauri::AppHandle,
    request: worker::MeshCleanupRequest,
    on_event: Channel<worker::WorkerProgressEvent>,
) -> Result<worker::GenerateResult, String> {
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app_handle.state::<worker_session::WorkerSessionManager>();
        manager.run_mesh_cleanup(request, |event| {
            let _ = on_event.send(event);
        })
    })
    .await
    .map_err(|error| format!("Mesh cleanup task failed: {error}"))?
}
```

Register `cleanup_mesh` in `tauri::generate_handler!`.

- [ ] **Step 6: Run Rust verification and verify GREEN**

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: both commands succeed.

- [ ] **Step 7: Commit Task 4**

```bash
git add apps/desktop/src-tauri/src
git commit -m "feat: add tauri mesh cleanup transport"
```

---

### Task 5: Add frontend cleanup domain/API and Mesh-mode controls

**Files:**
- Modify: `apps/desktop/src/domain/types.ts`
- Modify: `apps/desktop/src/lib/tauri.ts`
- Modify: `apps/desktop/src/components/GenerationPanel.tsx`
- Modify: `apps/desktop/src/components/GenerationPanel.test.tsx`

**Interfaces:**
- Produces frontend types `CleanupPreset`, `CleanupAdvancedOverrides`, `MeshCleanupReport`, Tauri `MeshCleanupRequest`, and `cleanupMesh()`.
- `WorkflowMode` becomes `'shape' | 'texture' | 'mesh'`.

- [ ] **Step 1: Write failing `GenerationPanel` tests**

Add assertions for:

```tsx
expect(screen.getByRole('tab', { name: 'Mesh' })).toBeTruthy();
expect(screen.getByText('Mesh cleanup')).toBeTruthy();
```

Test these states explicitly:

```text
Shape + Light: Light is pressed/selected.
Mesh + Game-ready: model picker and cleanup controls render; Shape quality and Remove background do not.
Aggressive: warning matches /may alter silhouette/i.
Custom label: "Custom (from Game-ready)" is visible.
```

- [ ] **Step 2: Run focused frontend test and verify RED**

```bash
npm test -- --run apps/desktop/src/components/GenerationPanel.test.tsx
```

Expected: Mesh tab/props are missing.

- [ ] **Step 3: Add frontend domain types**

In `types.ts`:

```ts
export type WorkflowMode = 'shape' | 'texture' | 'mesh';
export type GenerationPhase = 'shape' | 'mesh' | 'texture';
export type CleanupPreset = 'off' | 'light' | 'game-ready' | 'aggressive';

export interface CleanupAdvancedOverrides {
  remove_degenerate?: boolean;
  weld_vertices?: boolean;
  weld_relative_epsilon?: number;
  remove_small_islands?: boolean;
  min_component_area_ratio?: number;
  spike_cleanup?: boolean;
  spike_edge_ratio?: number;
  spike_max_area_ratio?: number;
  spike_normal_angle_deg?: number;
  smooth_surface?: boolean;
  smoothing_iterations?: number;
  taubin_lambda?: number;
  taubin_nu?: number;
  recompute_normals?: boolean;
}

export interface MeshCleanupReport {
  preset: CleanupPreset;
  config_label: string;
  algorithm_version: string;
  triangles_before: number;
  triangles_after: number;
  vertices_before: number;
  vertices_after: number;
  components_before: number;
  components_after: number;
  components_removed?: number;
  vertices_welded?: number;
  spikes_adjusted?: number;
  cleanup_ms: number;
  warnings: string[];
}
```

Extend `GenerationTimingSummary`:

```ts
meshCleanupMs?: number;
cleanupCacheHit?: boolean;
cleanupReport?: MeshCleanupReport;
```

- [ ] **Step 4: Add Tauri cleanup API in `tauri.ts`**

```ts
export interface MeshCleanupRequest {
  input: string;
  output: string;
  preset: CleanupPreset;
  overrides?: CleanupAdvancedOverrides;
}

export async function cleanupMesh(
  request: MeshCleanupRequest,
  onProgress?: ProgressHandler,
): Promise<GenerateResult> {
  if (!isTauri()) throw new Error('Mesh cleanup requires the Tauri desktop runtime.');
  return invoke<GenerateResult>('cleanup_mesh', {
    request,
    onEvent: progressChannel(onProgress),
  });
}
```

Add fields:

```ts
cleanup_cache_hit?: boolean | null;
cleanup_report?: MeshCleanupReport | null;
mesh_cleanup_ms?: number | null;
```

to `GenerateResult` and `WorkerProgressEvent`.

- [ ] **Step 5: Add Mesh tab and preset-first controls**

Add `GenerationPanelProps` fields:

```ts
cleanupPreset: CleanupPreset;
cleanupConfigLabel: string;
cleanupOverrides: CleanupAdvancedOverrides;
meshInputPath: string | null;
onCleanupPresetChange: (preset: CleanupPreset) => void;
onCleanupOverridesChange: (overrides: CleanupAdvancedOverrides) => void;
```

Render third tab `Mesh`.

Behavior:

```text
Shape: show Shape quality, Output, Mesh cleanup, optional Texture profile, Remove background.
Texture: show Texture engine/profile, Existing model, Remove background.
Mesh: show Existing model, Mesh cleanup, Advanced, Process mesh; hide Backend and Remove background.
```

Advanced UI exposes only:

```text
Remove small islands -> remove_small_islands
Weld nearby vertices -> weld_vertices
Spike cleanup -> spike_cleanup
Smooth surface -> smooth_surface
Smoothing iterations -> smoothing_iterations
Recompute normals -> recompute_normals
Minimum component size -> min_component_area_ratio
```

Taubin coefficients and spike thresholds remain internal preset values in v1.

- [ ] **Step 6: Run `GenerationPanel` tests and verify GREEN**

```bash
npm test -- --run apps/desktop/src/components/GenerationPanel.test.tsx
```

Expected: all tests pass.

- [ ] **Step 7: Commit Task 5**

```bash
git add apps/desktop/src/domain/types.ts apps/desktop/src/lib/tauri.ts apps/desktop/src/components/GenerationPanel.tsx apps/desktop/src/components/GenerationPanel.test.tsx
git commit -m "feat: add mesh cleanup controls"
```

---

### Task 6: Orchestrate Shape -> Cleanup -> Texture and standalone Mesh jobs

**Files:**
- Modify: `apps/desktop/src/lib/useGenerationJob.ts`
- Modify: `apps/desktop/src/lib/useGenerationJob.test.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/App.test.tsx`

**Interfaces:**
- Produces `MeshWorkflowRequest`, `runMeshWorkflow()`, `cleanedShapePath`, cleanup timing/report state.
- Shape request gains `cleanupPreset` and `cleanupOverrides`.

- [ ] **Step 1: Write failing workflow tests**

Mock `generateShape`, `cleanupMesh`, and `textureMesh`. Prove these flows:

```text
Shape model-only + Light:
  generate -> raw *-shape -> cleanup -> user-selected final path
Shape model-only + Off:
  generate directly to selected final path; no cleanup call
Shape model+texture + Light:
  generate *-shape -> cleanup *-clean -> texture user-selected final path
Cleanup failure:
  raw shape remains preserved; texture is not called
Texture failure after cleanup:
  retryContext.mesh equals cleaned path
Standalone Mesh:
  imported mesh -> selected output, with before=input and after=output
```

Use assertions such as:

```ts
expect(cleanupMesh).toHaveBeenCalledWith(
  expect.objectContaining({
    input: expect.stringMatching(/-shape\.glb$/),
    output: expect.stringMatching(/-clean\.glb$/),
    preset: 'light',
  }),
  expect.any(Function),
);
expect(textureMesh).toHaveBeenCalledWith(
  expect.objectContaining({ mesh: expect.stringMatching(/-clean\.glb$/) }),
  expect.any(Function),
);
```

- [ ] **Step 2: Run hook tests and verify RED**

```bash
npm test -- --run apps/desktop/src/lib/useGenerationJob.test.ts
```

Expected: cleanup workflow APIs are missing.

- [ ] **Step 3: Add deterministic intermediate-path helper**

Keep the Save-dialog path as the final user artifact:

```ts
function shapeWorkflowPaths(finalOutput: string, includesTexture: boolean, cleanupEnabled: boolean) {
  if (!cleanupEnabled) {
    return { raw: finalOutput, cleaned: finalOutput, final: finalOutput };
  }
  if (includesTexture) {
    return {
      raw: addSuffixBeforeExtension(finalOutput, '-shape'),
      cleaned: addSuffixBeforeExtension(finalOutput, '-clean'),
      final: finalOutput,
    };
  }
  return {
    raw: addSuffixBeforeExtension(finalOutput, '-shape'),
    cleaned: finalOutput,
    final: finalOutput,
  };
}
```

- [ ] **Step 4: Extend hook metadata mapping and cleanup state**

Add:

```ts
cleanupCacheHit: result.cleanup_cache_hit ?? undefined,
meshCleanupMs: result.mesh_cleanup_ms ?? undefined,
cleanupReport: result.cleanup_report ?? undefined,
```

Add state:

```ts
const [cleanedShapePath, setCleanedShapePath] = useState<string | null>(null);
```

Reset it in `resetForNewInput`.

Add labels:

```ts
cleaning_mesh: 'Cleaning mesh…',
exporting_clean_mesh: 'Saving cleaned mesh…',
```

- [ ] **Step 5: Implement `runCleanupInternal`**

```ts
const runCleanupInternal = useCallback(async (
  request: MeshCleanupRequest,
  options: { keepBusy: boolean; includesTexture: boolean; totalStartedAt: number },
): Promise<string | null> => {
  const startedAt = nowMs();
  setProgress({ phase: 'mesh', value: options.includesTexture ? 0.3 : 0, label: 'Cleaning mesh…' });
  setMessage('Cleaning mesh…');
  try {
    const result = await cleanupMesh(
      request,
      event => setProgressFromEvent('mesh', event, options.includesTexture),
    );
    const finishedAt = nowMs();
    if (!result.ok) {
      setTechnicalError(result.error ?? null);
      setError('Mesh cleanup failed. The original mesh was preserved.');
      setMessage('Mesh cleanup failed; original mesh was preserved.');
      setTimingSummary({
        totalMs: finishedAt - options.totalStartedAt,
        ...resultMetadata(result),
      });
      return null;
    }
    const output = result.output ?? request.output;
    setCleanedShapePath(output);
    setResultPath(output);
    setTimingSummary({
      totalMs: finishedAt - options.totalStartedAt,
      ...resultMetadata(result),
      meshCleanupMs: result.mesh_cleanup_ms ?? finishedAt - startedAt,
    });
    return output;
  } catch (reason) {
    setTechnicalError(String(reason));
    setError('Mesh cleanup failed. The original mesh was preserved.');
    setMessage('Mesh cleanup failed; original mesh was preserved.');
    return null;
  } finally {
    if (!options.keepBusy) setBusy(false);
  }
}, [setProgressFromEvent]);
```

- [ ] **Step 6: Compose Shape workflow**

Extend request:

```ts
cleanupPreset: CleanupPreset;
cleanupOverrides: CleanupAdvancedOverrides;
```

Use exact flow:

```ts
const cleanupEnabled = request.cleanupPreset !== 'off';
const paths = shapeWorkflowPaths(request.output, includesTexture, cleanupEnabled);
const shapeResult = await generateShape({
  backend: request.backend,
  input: request.image,
  output: paths.raw,
  model: 'tencent/Hunyuan3D-2mini',
  subfolder: 'hunyuan3d-dit-v2-mini',
  steps: request.steps,
  seed: request.seed,
  removeBackground: request.removeBackground,
}, event => setProgressFromEvent('shape', event, includesTexture));
```

After successful Shape:

```ts
setPreservedShapePath(paths.raw);
let nextMesh = paths.raw;
if (cleanupEnabled) {
  const cleaned = await runCleanupInternal({
    input: paths.raw,
    output: paths.cleaned,
    preset: request.cleanupPreset,
    overrides: request.cleanupOverrides,
  }, {
    keepBusy: true,
    includesTexture,
    totalStartedAt,
  });
  if (!cleaned) return null;
  nextMesh = cleaned;
}
if (!includesTexture) return nextMesh;
return runTextureInternal({
  backend: request.backend,
  engine: request.textureEngine,
  profile: request.textureProfile,
  mesh: nextMesh,
  image: request.image,
  output: paths.final,
  removeBackground: request.removeBackground,
}, {
  includesShape: true,
  shapeMs,
  totalStartedAt,
  keepBusy: true,
});
```

Because `runTextureInternal` receives `nextMesh`, its existing `retryContext` automatically points to the cleaned mesh.

- [ ] **Step 7: Add standalone Mesh workflow**

```ts
export interface MeshWorkflowRequest {
  input: string;
  output: string;
  preset: CleanupPreset;
  overrides: CleanupAdvancedOverrides;
}
```

Implement `runMeshWorkflow()` by setting `busy`, preserving the input path, and calling `runCleanupInternal` with `keepBusy: false`, `includesTexture: false`.

- [ ] **Step 8: Wire App defaults and prerequisites**

Add App state:

```ts
const [shapeCleanupPreset, setShapeCleanupPreset] = useState<CleanupPreset>('light');
const [shapeCleanupOverrides, setShapeCleanupOverrides] = useState<CleanupAdvancedOverrides>({});
const [meshCleanupPreset, setMeshCleanupPreset] = useState<CleanupPreset>('game-ready');
const [meshCleanupOverrides, setMeshCleanupOverrides] = useState<CleanupAdvancedOverrides>({});
const [meshInputPath, setMeshInputPath] = useState<string | null>(null);
```

Keep Shape and Mesh preset state separate so switching tabs does not reset user choices.

Prerequisites:

```text
Shape: image required + native-rocm backend.
Texture: image + mesh + texture runtime + native-rocm backend.
Mesh: mesh required; image, texture runtime, and ROCm backend are not required.
```

Modify `chooseOutputModel(defaultPath?: string)` in `tauri.ts` so Mesh mode can suggest `<source-stem>-clean.glb` while still allowing any selected GLB/OBJ path.

- [ ] **Step 9: Run hook/App tests and verify GREEN**

```bash
npm test -- --run apps/desktop/src/lib/useGenerationJob.test.ts apps/desktop/src/App.test.tsx
```

Expected: all tests pass.

- [ ] **Step 10: Commit Task 6**

```bash
git add apps/desktop/src/lib/useGenerationJob.ts apps/desktop/src/lib/useGenerationJob.test.ts apps/desktop/src/App.tsx apps/desktop/src/App.test.tsx apps/desktop/src/lib/tauri.ts
git commit -m "feat: integrate cleanup into shape and mesh workflows"
```

---

### Task 7: Add Before/After viewer and cleanup Activity telemetry

**Files:**
- Modify: `apps/desktop/src/components/ModelViewer.tsx`
- Create: `apps/desktop/src/components/ModelViewer.test.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/App.test.tsx`

**Interfaces:**
- `ModelViewer` gains optional `comparison` data.
- App consumes `cleanedShapePath` and `cleanupReport` from Task 6.

- [ ] **Step 1: Write failing comparison UI test**

Use a mocked loader/helper so WebGL itself is not under test. Assert:

```tsx
expect(screen.getByRole('button', { name: 'Before' })).toBeTruthy();
expect(screen.getByRole('button', { name: 'After' })).toBeTruthy();
```

Click Before then After and assert the selected URL changes from `before.glb` to `after.glb`.

- [ ] **Step 2: Write failing Activity telemetry test**

Mock `timingSummary` with a concrete cleanup report and assert labels:

```text
Mesh cleanup
Cleanup cache
Cleanup preset
Components removed
Vertices welded
Spikes adjusted
```

Also assert a warning string is rendered in warning styling, not hard-error styling.

- [ ] **Step 3: Run viewer/App tests and verify RED**

```bash
npm test -- --run apps/desktop/src/components/ModelViewer.test.tsx apps/desktop/src/App.test.tsx
```

Expected: comparison/telemetry UI is missing.

- [ ] **Step 4: Add typed comparison props and selected URL**

```ts
interface ModelComparison {
  beforeUrl: string;
  afterUrl: string;
  beforeTriangles?: number;
  afterTriangles?: number;
}

interface ModelViewerProps {
  modelUrl: string | null;
  comparison?: ModelComparison | null;
  busy: boolean;
  progress?: number | null;
  progressLabel?: string | null;
}
```

Inside the component:

```ts
const [comparisonSide, setComparisonSide] = useState<'before' | 'after'>('after');
useEffect(() => setComparisonSide('after'), [comparison?.beforeUrl, comparison?.afterUrl]);
const activeModelUrl = comparison
  ? comparisonSide === 'before' ? comparison.beforeUrl : comparison.afterUrl
  : modelUrl;
```

Change the existing load effect dependency and loader input from `modelUrl` to `activeModelUrl`.

Render:

```tsx
{comparison && (
  <div className="viewer-comparison" aria-label="Mesh comparison">
    <button type="button" aria-pressed={comparisonSide === 'before'} onClick={() => setComparisonSide('before')}>
      Before{comparison.beforeTriangles !== undefined ? ` · ${comparison.beforeTriangles.toLocaleString()}` : ''}
    </button>
    <button type="button" aria-pressed={comparisonSide === 'after'} onClick={() => setComparisonSide('after')}>
      After{comparison.afterTriangles !== undefined ? ` · ${comparison.afterTriangles.toLocaleString()}` : ''}
    </button>
  </div>
)}
```

- [ ] **Step 5: Wire Mesh-mode comparison from App**

Enable only when:

```ts
workflowMode === 'mesh' && meshInputPath && job.cleanedShapePath
```

Use `localAssetUrl(meshInputPath)` and `localAssetUrl(job.cleanedShapePath)`. Triangle counts come from `timingSummary.cleanupReport`.

- [ ] **Step 6: Add cleanup Activity rows**

Render when available:

```text
Mesh cleanup       formatDuration(meshCleanupMs)
Cleanup cache      hit/miss
Cleanup preset     config_label
Mesh               triangles_before -> triangles_after
Components removed count
Vertices welded    count
Spikes adjusted    count
```

Render `cleanupReport.warnings` in a separate nonfatal warning block. Keep `algorithm_version` in Technical details or a compact `Algorithm` row.

- [ ] **Step 7: Run viewer/App tests and verify GREEN**

```bash
npm test -- --run apps/desktop/src/components/ModelViewer.test.tsx apps/desktop/src/App.test.tsx
```

Expected: all tests pass.

- [ ] **Step 8: Commit Task 7**

```bash
git add apps/desktop/src/components/ModelViewer.tsx apps/desktop/src/components/ModelViewer.test.tsx apps/desktop/src/App.tsx apps/desktop/src/App.test.tsx
git commit -m "feat: add mesh before-after comparison"
```

---

### Task 8: Full integration verification and RX 6950 XT hardware acceptance

**Files:**
- Create: `docs/benchmarks/2026-09-12-game-ready-mesh-cleanup.md`
- Modify: `docs/benchmarks/2026-09-12-rx6950xt-texture-baseline.md`
- Modify implementation/tests only if verification exposes a concrete defect; every such defect gets a failing regression test before its fix.

**Interfaces:**
- No new runtime interface. This task proves the milestone and records measured results.

- [ ] **Step 1: Run complete Python verification**

```bash
python -m pip install -r backends/hunyuan/requirements-base.txt
python -m unittest discover -s backends/hunyuan/tests -v
python -m unittest discover -s backends/mesh_processing/tests -v
```

Expected: zero failures.

- [ ] **Step 2: Run complete frontend verification**

```bash
npm test -- --run
npm run build
```

Expected: zero failures and successful production build.

- [ ] **Step 3: Run complete Rust verification**

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: both commands succeed.

- [ ] **Step 4: Refresh the persistent Windows runtime**

On the RX 6950 XT machine:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup\windows-native-rocm.ps1 -VerifyOnly
```

Verify these exact paths exist afterward:

```text
%LOCALAPPDATA%\Img2ModelAMD\runtime\native-rocm\worker.py
%LOCALAPPDATA%\Img2ModelAMD\runtime\native-rocm\backends\mesh_processing\__init__.py
```

- [ ] **Step 5: Run hardware acceptance matrix**

Use the current steak regression asset and record actual Activity values for each run:

```text
A. Shape -> Model only, Light
   Raw shape preserved; cleaned final opens; no obvious silhouette damage.

B. Shape -> Model + texture, Light
   Raw -shape and intermediate -clean remain on disk; Paint consumes -clean.

C. Mesh mode, Game-ready
   Imported GLB creates a separate clean output; Before/After switches correctly; known protruding artifact improves without obvious valid-detail loss.

D. Mesh mode, Aggressive
   Nonfatal silhouette warning is visible; output is a valid GLB/OBJ.

E. Texture retry
   After a controlled Paint failure following successful cleanup, Retry texture only submits the cleaned path.

F. Cached Balanced texture after cleanup
   Model/image caches still hit when valid; cleanup has its own timing row; warm Paint inference stays in the established ~28-33 s band unless the hardware measurement proves a new baseline.
```

- [ ] **Step 6: Record measured cleanup benchmark**

Create `docs/benchmarks/2026-09-12-game-ready-mesh-cleanup.md` after Step 5. Include one row each for Light, Game-ready, and Aggressive with the actual measured values from Activity:

```text
Preset
Cleanup ms
Triangles before
Triangles after
Components removed
Vertices welded
Spikes adjusted
Warnings
Visual assessment
```

Also record pass/fail for Before/After and retry-cleaned-mesh behavior.

- [ ] **Step 7: Update existing RX 6950 XT baseline**

Append a section that states the previously validated cached Balanced Paint inference baseline (~28-33 s) and records the new measured post-cleanup warm run. State “no regression” only if Step 5 confirms it.

- [ ] **Step 8: Verify final GitHub Actions run**

On the final HEAD, require all four jobs to finish successfully:

```text
frontend
python-worker
rust-core
desktop-windows
```

Do not call the feature complete before both final CI and the hardware acceptance matrix pass.

- [ ] **Step 9: Commit benchmark documentation**

```bash
git add docs/benchmarks
git commit -m "docs: record game-ready mesh cleanup validation"
```

---

## Plan Self-Review Checklist

### Spec coverage

- Reusable cleanup module: Tasks 1-2.
- Shape and imported Mesh workflows: Tasks 5-6.
- `Shape | Texture | Mesh`: Task 5.
- Shape default Light / Mesh default Game-ready: Tasks 5-6.
- Preserve source/raw geometry: Tasks 2 and 6.
- Automatic cleanup before Paint: Task 6.
- Before/After viewer: Task 7.
- Off/Light/Game-ready/Aggressive: Tasks 1-2 and 5.
- Conservative multi-signal spike handling: Task 2.
- Shrinkage-resistant Taubin smoothing: Task 2.
- Cleanup report/telemetry: Tasks 1, 3, 4, 5, 7.
- Separate cleanup/texture cache concepts: Task 3.
- Clear-cache integration: Task 3.
- Errors/warnings/atomic output: Tasks 2, 3, 6, 7.
- Retry texture with cleaned mesh: Task 6.
- Advanced changes become visible Custom configuration: Tasks 1 and 5.
- Synthetic geometry tests include a legitimate thin feature: Task 2.
- Steak visual regression and RX 6950 XT validation: Task 8.
- No PyMeshLab/manual editor/LOD/collision scope creep: Global Constraints.

### Placeholder scan

- No `TBD` or `TODO` requirements.
- No implementation body is represented by an ellipsis.
- Measured benchmark values are intentionally obtained during Task 8 hardware validation and the plan defines exactly which values must be recorded.

### Type consistency

- Python worker emits snake_case `cleanup_report`, `mesh_cleanup_ms`, `cleanup_cache_hit`; Rust and TypeScript result structs use those JSON keys.
- Tauri request top-level fields use the existing camelCase serialization boundary; the `overrides` JSON object deliberately uses the Python `CleanupSettings` snake_case field names.
- Cleanup preset values are consistently `off | light | game-ready | aggressive`.
- `GenerationPhase` includes `mesh` before cleanup progress is wired.
- Python and Rust persistent-worker protocol versions both become `2` in the same implementation series.

### Execution note

Create an isolated worktree/feature branch from `feat/persistent-worker-cache-impl` before implementation. Recommended branch name: `feat/game-ready-mesh-cleanup`.
