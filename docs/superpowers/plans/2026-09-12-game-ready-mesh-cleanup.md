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
- Do not add PyMeshLab in this milestone.
- No LOD, collision, ground alignment, flatten-bottom, pivot, UV editor, local remesh, or manual face/vertex editor in this milestone.
- The existing warm Texture benchmark (~29 s for cached Balanced on RX 6950 XT) must not regress because of hidden cleanup work inside texture preprocessing.
- Use test-first development for every behavior change.

---

## File Structure

### New Python mesh-processing package

- `backends/mesh_processing/__init__.py` — stable public exports.
- `backends/mesh_processing/models.py` — preset/settings/report dataclasses and serialization.
- `backends/mesh_processing/presets.py` — stock preset values, normalization, custom-label logic, `ALGORITHM_VERSION`.
- `backends/mesh_processing/cleanup.py` — deterministic geometry operations and `process_mesh`.
- `backends/mesh_processing/io.py` — GLB/OBJ load + atomic export + source-preservation checks.
- `backends/mesh_processing/cache.py` — cleanup cache key and small in-memory cleaned-mesh cache.
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
- `apps/desktop/src/components/ModelViewer.test.tsx` — comparison state/labels without exercising WebGL internals.
- `apps/desktop/src/App.tsx` — mode-specific input/output selection, comparison paths, Activity report.
- `apps/desktop/src/App.test.tsx` — cleanup Activity/report and standalone Mesh behavior.

---

### Task 1: Define the mesh-cleanup domain, stock presets, normalization, and report

**Files:**
- Create: `backends/mesh_processing/__init__.py`
- Create: `backends/mesh_processing/models.py`
- Create: `backends/mesh_processing/presets.py`
- Create: `backends/mesh_processing/tests/test_presets.py`

**Interfaces:**
- Produces: `CleanupPreset`, `CleanupSettings`, `ResolvedCleanupConfig`, `CleanupReport`, `ALGORITHM_VERSION`, `resolve_cleanup_config(preset, overrides)`.
- Consumed by: Tasks 2, 3, 4, and frontend/Rust contract naming in later tasks.

- [ ] **Step 1: Write failing preset-resolution tests**

Create `backends/mesh_processing/tests/test_presets.py` with tests covering stock defaults, custom labeling, invalid values, and internal algorithm version participation:

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
        self.assertIsInstance(ALGORITHM_VERSION, str)
        self.assertTrue(ALGORITHM_VERSION.startswith("mesh-cleanup-v"))

    def test_invalid_preset_raises(self):
        with self.assertRaisesRegex(ValueError, "Unsupported cleanup preset"):
            resolve_cleanup_config("destroy-everything", {})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
python -m unittest backends.mesh_processing.tests.test_presets -v
```

Expected: FAIL because `backends.mesh_processing.presets` does not exist.

- [ ] **Step 3: Implement domain dataclasses and exact stock settings**

Use these public structures in `models.py`:

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

Use these stock values in `presets.py` as the first conservative baseline:

```python
ALGORITHM_VERSION = "mesh-cleanup-v1"

PRESET_SETTINGS = {
    "off": CleanupSettings(False, False, 0.0, False, 0.0, False, 0.0, 0.0, 0.0, False, 0, 0.0, 0.0, False),
    "light": CleanupSettings(True, True, 1e-7, True, 1e-5, False, 0.0, 0.0, 0.0, False, 0, 0.0, 0.0, True),
    "game-ready": CleanupSettings(True, True, 1e-6, True, 5e-4, True, 4.0, 5e-4, 55.0, True, 2, 0.25, -0.26, True),
    "aggressive": CleanupSettings(True, True, 5e-6, True, 2e-3, True, 2.75, 1.5e-3, 40.0, True, 4, 0.35, -0.36, True),
}
```

`resolve_cleanup_config()` must:

```python
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
    if settings.smoothing_iterations < 0 or settings.smoothing_iterations > 20:
        raise ValueError("smoothing_iterations must be between 0 and 20")
    if settings.weld_relative_epsilon < 0 or settings.weld_relative_epsilon > 1e-2:
        raise ValueError("weld_relative_epsilon must be between 0 and 0.01")
    label = {
        "off": "Off",
        "light": "Light",
        "game-ready": "Game-ready",
        "aggressive": "Aggressive",
    }[preset]
    if overrides and any(values[key] != getattr(base, key) for key in overrides):
        label = f"Custom (from {label})"
    return ResolvedCleanupConfig(preset, label, ALGORITHM_VERSION, settings)
```

- [ ] **Step 4: Run preset tests and verify GREEN**

Run:

```bash
python -m unittest backends.mesh_processing.tests.test_presets -v
```

Expected: all tests PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add backends/mesh_processing
git commit -m "feat: define mesh cleanup presets and report"
```

---

### Task 2: Implement deterministic geometry cleanup and atomic GLB/OBJ output

**Files:**
- Create: `backends/mesh_processing/cleanup.py`
- Create: `backends/mesh_processing/io.py`
- Create: `backends/mesh_processing/tests/test_cleanup.py`
- Create: `backends/mesh_processing/tests/test_io.py`

**Interfaces:**
- Consumes: `ResolvedCleanupConfig`, `CleanupReport` from Task 1.
- Produces: `cleanup_mesh(mesh, config) -> tuple[trimesh.Trimesh, CleanupReport]`, `process_mesh(input_path, output_path, config) -> CleanupReport`.

- [ ] **Step 1: Write failing synthetic-geometry tests**

Use `trimesh.creation.box()` plus explicit synthetic faces. The tests must cover both artifact removal and preservation:

```python
import unittest
import numpy as np
import trimesh

from backends.mesh_processing.cleanup import cleanup_mesh
from backends.mesh_processing.presets import resolve_cleanup_config


class CleanupGeometryTests(unittest.TestCase):
    def test_light_removes_tiny_disconnected_island_without_smoothing_main_body(self):
        main = trimesh.creation.box(extents=[1.0, 1.0, 1.0])
        island = trimesh.creation.box(extents=[0.005, 0.005, 0.005])
        island.apply_translation([2.0, 0.0, 0.0])
        source = trimesh.util.concatenate([main, island])
        cleaned, report = cleanup_mesh(source, resolve_cleanup_config("light", {}))
        self.assertLess(report.components_after, report.components_before)
        self.assertGreaterEqual(report.components_removed, 1)
        self.assertLess(cleaned.faces.shape[0], source.faces.shape[0])

    def test_game_ready_reduces_single_artificial_spike(self):
        mesh = trimesh.creation.icosphere(subdivisions=2, radius=1.0)
        tip = int(np.argmax(mesh.vertices[:, 2]))
        mesh.vertices[tip] *= 5.0
        cleaned, report = cleanup_mesh(mesh, resolve_cleanup_config("game-ready", {}))
        self.assertGreaterEqual(report.spikes_adjusted, 1)
        self.assertLess(cleaned.vertices[tip, 2], mesh.vertices[tip, 2])

    def test_thin_legitimate_feature_survives_game_ready(self):
        body = trimesh.creation.box(extents=[1.0, 1.0, 1.0])
        stem = trimesh.creation.cylinder(radius=0.05, height=1.0, sections=16)
        stem.apply_translation([0.0, 0.0, 1.0])
        source = trimesh.util.concatenate([body, stem])
        cleaned, report = cleanup_mesh(source, resolve_cleanup_config("game-ready", {}))
        self.assertEqual(report.components_removed, 0)
        self.assertGreater(cleaned.bounds[1][2], 1.4)

    def test_off_preserves_vertex_and_face_counts(self):
        source = trimesh.creation.box()
        cleaned, report = cleanup_mesh(source, resolve_cleanup_config("off", {}))
        self.assertEqual(len(cleaned.vertices), len(source.vertices))
        self.assertEqual(len(cleaned.faces), len(source.faces))
        self.assertEqual(report.spikes_adjusted, 0)
```

- [ ] **Step 2: Write failing I/O preservation tests**

`test_io.py` must prove the source is not overwritten and a failed export does not replace a valid output:

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

- [ ] **Step 3: Run cleanup/I/O tests and verify RED**

Run:

```bash
python -m unittest backends.mesh_processing.tests.test_cleanup backends.mesh_processing.tests.test_io -v
```

Expected: FAIL because cleanup/I/O functions do not exist.

- [ ] **Step 4: Implement the common cleanup pipeline**

`cleanup_mesh()` must copy its input and apply the same ordered pipeline for all presets:

```python
def cleanup_mesh(mesh, config):
    working = mesh.copy()
    started = time.perf_counter()
    report = _initial_report(working, config)
    settings = config.settings

    if settings.remove_degenerate:
        _remove_degenerate_faces(working)
    if settings.weld_vertices:
        report.vertices_welded += _weld_near_vertices(working, settings.weld_relative_epsilon)
    if settings.remove_small_islands:
        report.components_removed += _remove_small_components(working, settings.min_component_area_ratio)
    if settings.spike_cleanup:
        report.spikes_adjusted += _relax_spike_vertices(
            working,
            edge_ratio=settings.spike_edge_ratio,
            max_area_ratio=settings.spike_max_area_ratio,
            normal_angle_deg=settings.spike_normal_angle_deg,
        )
    if settings.smooth_surface and settings.smoothing_iterations > 0:
        trimesh.smoothing.filter_taubin(
            working,
            lamb=settings.taubin_lambda,
            nu=settings.taubin_nu,
            iterations=settings.smoothing_iterations,
        )
    if settings.recompute_normals:
        working.fix_normals(multibody=True)

    working.remove_unreferenced_vertices()
    _finish_report(report, working, started)
    _append_safety_warnings(report)
    return working, report
```

Implement helpers with scale-relative thresholds:

```python
def _mesh_scale(mesh) -> float:
    extent = np.asarray(mesh.extents, dtype=float)
    return max(float(np.linalg.norm(extent)), 1e-9)


def _remove_degenerate_faces(mesh) -> None:
    area_eps = max(float(mesh.area) * 1e-12, _mesh_scale(mesh) ** 2 * 1e-14)
    mask = np.asarray(mesh.area_faces) > area_eps
    mesh.update_faces(mask)
    mesh.remove_unreferenced_vertices()
```

For small components, use face adjacency and always preserve the largest component:

```python
def _remove_small_components(mesh, min_area_ratio: float) -> int:
    if len(mesh.faces) == 0:
        return 0
    components = trimesh.graph.connected_components(
        mesh.face_adjacency,
        nodes=np.arange(len(mesh.faces)),
        min_len=1,
    )
    if len(components) <= 1:
        return 0
    face_areas = np.asarray(mesh.area_faces)
    areas = [float(face_areas[np.asarray(c, dtype=int)].sum()) for c in components]
    total = max(sum(areas), 1e-12)
    largest = int(np.argmax(areas))
    keep = np.zeros(len(mesh.faces), dtype=bool)
    removed = 0
    for index, component in enumerate(components):
        if index == largest or areas[index] / total >= min_area_ratio:
            keep[np.asarray(component, dtype=int)] = True
        else:
            removed += 1
    mesh.update_faces(keep)
    mesh.remove_unreferenced_vertices()
    return removed
```

Spike handling must *relax* candidate tip vertices rather than delete faces. A vertex becomes a candidate only when all of these are true:

1. its longest incident edge is at least `edge_ratio` times the median edge length in the neighboring one-ring,
2. the incident face area contribution is below `max_area_ratio * total_mesh_area`,
3. at least one incident face-normal pair differs by `normal_angle_deg` or more,
4. it has at least three neighbors.

Move a candidate only halfway toward the median of its neighbors:

```python
new_position = 0.5 * old_position + 0.5 * np.median(neighbor_positions, axis=0)
```

Do not run spike cleanup in Light.

- [ ] **Step 5: Implement atomic load/export**

`process_mesh()` must:

```python
def process_mesh(input_path: Path, output_path: Path, config: ResolvedCleanupConfig) -> CleanupReport:
    source = input_path.expanduser().resolve()
    target = output_path.expanduser().resolve()
    if source == target:
        raise ValueError("Input and output mesh paths must differ")
    if source.suffix.lower() not in {".glb", ".obj"} or target.suffix.lower() not in {".glb", ".obj"}:
        raise ValueError("Mesh cleanup supports only .glb and .obj")
    if not source.is_file():
        raise FileNotFoundError(source)

    loaded = trimesh.load(str(source), force="mesh", process=False)
    cleaned, report = cleanup_mesh(loaded, config)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(f".{target.stem}.partial{target.suffix}")
    try:
        cleaned.export(str(temp), file_type=target.suffix.lower().lstrip("."))
        os.replace(temp, target)
    finally:
        if temp.exists():
            temp.unlink()
    return report
```

Add warnings when:

```text
components_removed > max(3, 25% of components_before)
triangles_after < 80% of triangles_before for Light
triangles_after < 60% of triangles_before for Game-ready
mesh remains non-watertight AND had non-manifold edges before/after
preset == aggressive
```

Use warning identifiers/messages stable enough for frontend tests, for example `"Aggressive cleanup may alter silhouette and fine detail."`.

- [ ] **Step 6: Run geometry/I/O tests and verify GREEN**

Run:

```bash
python -m unittest backends.mesh_processing.tests.test_cleanup backends.mesh_processing.tests.test_io -v
```

Expected: all tests PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add backends/mesh_processing
git commit -m "feat: add automatic mesh cleanup engine"
```

---

### Task 3: Add cleanup cache, worker command, runtime packaging, and Python CI coverage

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
- Produces: `cleanup_cache_key(path, config)`, worker JSONL command `mesh_cleanup`, worker terminal fields `cleanup_report` and `mesh_cleanup_ms`.
- Worker request shape:

```json
{
  "input": "C:/models/model.glb",
  "output": "C:/models/model-clean.glb",
  "preset": "game-ready",
  "overrides": {}
}
```

- [ ] **Step 1: Write failing cleanup-cache tests**

`test_cache.py` must prove file identity, preset, overrides, and `ALGORITHM_VERSION` participate in the key:

```python
class CleanupCacheTests(unittest.TestCase):
    def test_preset_changes_key(self):
        light = cleanup_cache_key(path, resolve_cleanup_config("light", {}))
        game = cleanup_cache_key(path, resolve_cleanup_config("game-ready", {}))
        self.assertNotEqual(light, game)

    def test_override_changes_key(self):
        stock = cleanup_cache_key(path, resolve_cleanup_config("game-ready", {}))
        custom = cleanup_cache_key(path, resolve_cleanup_config("game-ready", {"smoothing_iterations": 0}))
        self.assertNotEqual(stock, custom)

    def test_file_mtime_changes_key(self):
        first = cleanup_cache_key(path, resolve_cleanup_config("light", {}))
        path.touch()
        second = cleanup_cache_key(path, resolve_cleanup_config("light", {}))
        self.assertNotEqual(first, second)
```

- [ ] **Step 2: Run cache tests and verify RED**

Run:

```bash
python -m unittest backends.mesh_processing.tests.test_cache -v
```

Expected: FAIL because `cache.py` does not exist.

- [ ] **Step 3: Implement bounded cleanup cache**

Use one cleaned mesh/report entry only; this mirrors the existing prepared-mesh cache and avoids unbounded RAM use:

```python
def cleanup_cache_key(path: Path, config: ResolvedCleanupConfig) -> tuple[object, ...]:
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
        self.mesh = mesh
        self.report = copy.deepcopy(report)
        return mesh.copy(), copy.deepcopy(report), False

    def clear(self):
        self.key = self.mesh = self.report = None
```

- [ ] **Step 4: Write failing worker JSONL tests**

Extend `backends/hunyuan/tests/test_worker.py` with a `mesh_cleanup` dispatch test that stubs `run_mesh_cleanup` and verifies request conversion, plus a protocol version test expecting version `2`:

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
    self.assertEqual(args.preset, "game-ready")
    self.assertEqual(args.overrides["smoothing_iterations"], 1)
```

- [ ] **Step 5: Run worker tests and verify RED**

Run:

```bash
python -m unittest backends.hunyuan.tests.test_worker -v
```

Expected: FAIL because the command/namespace/version are not implemented.

- [ ] **Step 6: Integrate cleanup into `worker.py` without moving geometry logic there**

Change both Python and Rust protocol constants to `2` in this task and Task 4 respectively.

Add imports only at cleanup execution time:

```python
def run_mesh_cleanup(args: argparse.Namespace, cache: PipelineCache | None = None) -> int:
    from backends.mesh_processing.cache import cleanup_cache_key
    from backends.mesh_processing.cleanup import cleanup_mesh
    from backends.mesh_processing.io import export_mesh_atomic, load_mesh
    from backends.mesh_processing.presets import resolve_cleanup_config

    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    config = resolve_cleanup_config(args.preset, args.overrides)
    started = time.perf_counter()
    # load/cache/cleanup, then atomic export
    # emit progress stage="cleaning_mesh" before cleanup
    # emit completed with cleanup_report and mesh_cleanup_ms
```

Do not reuse the texture prepared-mesh cache for this command. Add `cleanup_mesh_cache` as a distinct member of `PipelineCache` or compose a `CleanupMeshCache` instance inside it. `PipelineCache.clear()` must clear it together with prepared image/mesh/model caches.

Add `_mesh_cleanup_namespace(request)` and dispatch:

```python
if command == "mesh_cleanup":
    request = message.get("request")
    if not isinstance(request, dict):
        raise ValueError("mesh_cleanup command requires a request object")
    run_mesh_cleanup(_mesh_cleanup_namespace(request), cache=cache)
    return True
```

Also add a direct CLI subcommand for diagnostics/manual testing:

```text
worker.py mesh-cleanup --input source.glb --output source-clean.glb --preset game-ready
```

- [ ] **Step 7: Make runtime dependencies/package copy explicit**

Update `requirements-base.txt` to:

```text
# Lightweight worker-side dependencies. PyTorch and Hunyuan3D are installed separately.
Pillow>=10.0
numpy>=1.26
trimesh>=4.0
```

In `windows-native-rocm.ps1`, copy the package next to the installed worker:

```powershell
$MeshProcessingSource = Join-Path $RepoRoot "backends\mesh_processing"
$InstalledMeshProcessing = Join-Path $RuntimeDir "backends\mesh_processing"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $InstalledMeshProcessing) | Out-Null
if (Test-Path $InstalledMeshProcessing) { Remove-Item -Recurse -Force $InstalledMeshProcessing }
Copy-Item -Recurse -Force $MeshProcessingSource $InstalledMeshProcessing
```

Also create `$RuntimeDir\backends\__init__.py` if absent so `from backends.mesh_processing...` resolves from the runtime directory.

Extend `test_windows_scripts.py` to assert the script contains `MeshProcessingSource`, `InstalledMeshProcessing`, and recursive copy logic.

- [ ] **Step 8: Update Python CI to exercise the real geometry package**

Change the `python-worker` job to:

```yaml
- run: python -m pip install -r backends/hunyuan/requirements-base.txt
- run: python -m unittest discover -s backends/hunyuan/tests -v
- run: python -m unittest discover -s backends/mesh_processing/tests -v
```

- [ ] **Step 9: Run all Python tests and verify GREEN**

Run:

```bash
python -m pip install -r backends/hunyuan/requirements-base.txt
python -m unittest discover -s backends/hunyuan/tests -v
python -m unittest discover -s backends/mesh_processing/tests -v
```

Expected: all tests PASS.

- [ ] **Step 10: Commit Task 3**

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
- Consumes worker command/result from Task 3.
- Produces Tauri command `cleanup_mesh(request, on_event)` and typed `MeshCleanupRequest`/`MeshCleanupReport`.

- [ ] **Step 1: Write failing Rust serialization/session tests**

Add to `worker.rs` tests:

```rust
#[test]
fn mesh_cleanup_request_serializes_camel_case_overrides() {
    let request = MeshCleanupRequest {
        input: "source.glb".into(),
        output: "source-clean.glb".into(),
        preset: "game-ready".into(),
        overrides: Some(serde_json::json!({"smoothing_iterations": 1})),
    };
    let value = serde_json::to_value(request).unwrap();
    assert_eq!(value["preset"], "game-ready");
    assert_eq!(value["overrides"]["smoothing_iterations"], 1);
}
```

Add to `worker_session.rs` tests:

```rust
#[test]
fn mesh_cleanup_command_has_request_and_job_id() {
    let value = mesh_cleanup_command("job-10", &fixture_mesh_cleanup_request());
    assert_eq!(value["command"], "mesh_cleanup");
    assert_eq!(value["job_id"], "job-10");
    assert_eq!(value["request"]["preset"], "game-ready");
}
```

Add a terminal-result decode test containing:

```json
{"cleanup_report":{"preset":"light","config_label":"Light","algorithm_version":"mesh-cleanup-v1","triangles_before":100,"triangles_after":90,"vertices_before":60,"vertices_after":55,"components_before":2,"components_after":1,"components_removed":1,"vertices_welded":2,"spikes_adjusted":0,"cleanup_ms":12.5,"warnings":[]},"mesh_cleanup_ms":12.5}
```

- [ ] **Step 2: Run Rust tests and verify RED**

Run:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
```

Expected: compile/test failure because cleanup types/functions do not exist.

- [ ] **Step 3: Add Rust cleanup request/report/result fields**

In `worker.rs`:

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

Add optional fields to both `WorkerProgressEvent` and `GenerateResult`:

```rust
pub cleanup_report: Option<MeshCleanupReport>,
pub mesh_cleanup_ms: Option<f64>,
```

Increment `worker_session.rs` `PROTOCOL_VERSION` to `2`, matching Task 3.

- [ ] **Step 4: Add session command and manager method**

Implement:

```rust
fn mesh_cleanup_command(job_id: &str, request: &MeshCleanupRequest) -> Value {
    json!({"command":"mesh_cleanup","job_id":job_id,"request":request})
}

fn run_mesh_cleanup<F>(&mut self, request: MeshCleanupRequest, on_event: F) -> Result<GenerateResult, SessionError>
where F: FnMut(WorkerProgressEvent) { ... }

pub fn run_mesh_cleanup<F>(&self, request: MeshCleanupRequest, on_event: F) -> Result<GenerateResult, String>
where F: FnMut(WorkerProgressEvent) { ... }
```

Do not require `native-rocm` for mesh cleanup because it is CPU-side and has no backend field.

- [ ] **Step 5: Add Tauri command**

In `lib.rs`:

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
        manager.run_mesh_cleanup(request, |event| { let _ = on_event.send(event); })
    })
    .await
    .map_err(|error| format!("Mesh cleanup task failed: {error}"))?
}
```

Register `cleanup_mesh` in `tauri::generate_handler!`.

- [ ] **Step 6: Run Rust tests and cargo check**

Run:

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

### Task 5: Add frontend cleanup types/API and Mesh-mode controls

**Files:**
- Modify: `apps/desktop/src/domain/types.ts`
- Modify: `apps/desktop/src/lib/tauri.ts`
- Modify: `apps/desktop/src/components/GenerationPanel.tsx`
- Modify: `apps/desktop/src/components/GenerationPanel.test.tsx`

**Interfaces:**
- Produces frontend types `CleanupPreset`, `CleanupAdvancedOverrides`, `MeshCleanupReport`, `MeshCleanupRequest` and `cleanupMesh()`.
- `WorkflowMode` becomes `'shape' | 'texture' | 'mesh'`.

- [ ] **Step 1: Write failing GenerationPanel tests**

Add tests asserting:

```tsx
expect(screen.getByRole('tab', { name: 'Mesh' })).toBeTruthy();
```

For `workflowMode="shape"`, assert `Light` is selected through props. For `workflowMode="mesh"`, assert model picker + cleanup preset controls render, image background-removal and shape controls do not. For `preset="aggressive"`, assert warning text matching `/may alter silhouette/i`. For an override, assert label `Custom (from Game-ready)`.

- [ ] **Step 2: Run focused frontend test and verify RED**

Run:

```bash
npm test -- --run apps/desktop/src/components/GenerationPanel.test.tsx
```

Expected: FAIL because Mesh mode/cleanup props do not exist.

- [ ] **Step 3: Add exact frontend domain types**

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

Extend `GenerationTimingSummary` with:

```ts
meshCleanupMs?: number;
cleanupReport?: MeshCleanupReport;
```

- [ ] **Step 4: Add Tauri cleanup API**

In `tauri.ts`:

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

Add `cleanup_report` and `mesh_cleanup_ms` to `GenerateResult` and `WorkerProgressEvent`.

- [ ] **Step 5: Add preset-first GenerationPanel UI**

Add props:

```ts
cleanupPreset: CleanupPreset;
cleanupConfigLabel: string;
cleanupOverrides: CleanupAdvancedOverrides;
meshInputPath: string | null;
onCleanupPresetChange: (preset: CleanupPreset) => void;
onCleanupOverridesChange: (overrides: CleanupAdvancedOverrides) => void;
```

Render a third `Mesh` tab. In Shape, render cleanup presets below Output. In Mesh, render existing-model picker, cleanup presets, and `Process mesh` action. Hide Backend selector in Mesh mode because cleanup is CPU-side. Hide Remove background in Mesh mode.

Preset labels are exactly:

```text
Off
Light
Game-ready
Aggressive
```

Advanced section initially exposes only these user-friendly controls, mapped to the full backend settings:

```text
Remove small islands -> remove_small_islands
Weld nearby vertices -> weld_vertices
Spike cleanup -> spike_cleanup
Smooth surface -> smooth_surface
Smoothing iterations -> smoothing_iterations
Recompute normals -> recompute_normals
Minimum component size -> min_component_area_ratio
```

Do not expose Taubin lambda/nu or spike heuristic thresholds in the first UI; they remain stock-preset internals unless later required.

- [ ] **Step 6: Run GenerationPanel tests and verify GREEN**

Run:

```bash
npm test -- --run apps/desktop/src/components/GenerationPanel.test.tsx
```

Expected: all tests PASS.

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
- Produces: `MeshWorkflowRequest`, `runMeshWorkflow()`, `cleanedShapePath`, cleanup timing/report in job state.
- Shape request gains `cleanupPreset` and `cleanupOverrides`.

- [ ] **Step 1: Write failing orchestration tests**

Mock `generateShape`, `cleanupMesh`, and `textureMesh` and prove exact call order for Shape + Texture:

```ts
expect(generateShape).toHaveBeenCalledTimes(1);
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

Add tests for:

```text
Shape model-only + Light: generate raw -shape, cleanup to selected final output, return cleaned output.
Shape model-only + Off: generate directly to selected final output, skip cleanup.
Shape model+texture + Light: raw -shape -> intermediate -clean -> selected final texture output.
Cleanup failure: preserve raw shape, do not invoke texture.
Texture failure after cleanup: retryContext.mesh equals cleaned path.
Standalone Mesh: cleanup source -> selected output, beforePath=source, afterPath=output.
```

- [ ] **Step 2: Run hook tests and verify RED**

Run:

```bash
npm test -- --run apps/desktop/src/lib/useGenerationJob.test.ts
```

Expected: FAIL because cleanup workflow does not exist.

- [ ] **Step 3: Add output-path helpers with backward-compatible final-output semantics**

Keep the user-selected path as the final output. Add:

```ts
function addSuffixBeforeExtension(path: string, suffix: string): string { ... }

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

This preserves the source mesh without changing the meaning of the Save dialog: the selected path remains the final artifact.

- [ ] **Step 4: Add cleanup execution helper to the hook**

Implement `runCleanupInternal()` that:

```ts
setProgress({ phase: 'mesh', value: ..., label: 'Cleaning mesh…' });
const startedAt = nowMs();
const result = await cleanupMesh(request, event => setProgressFromEvent('mesh', event, includesTexture));
const meshCleanupMs = result.mesh_cleanup_ms ?? (nowMs() - startedAt);
```

On success:

```ts
setCleanedShapePath(result.output ?? request.output);
merge timingSummary with meshCleanupMs and cleanupReport;
```

On failure:

```text
keep preservedShapePath pointing at the raw mesh
set error to "Mesh cleanup failed. The raw shape was preserved."
never call texture
```

Add stage label:

```ts
cleaning_mesh: 'Cleaning mesh…'
```

- [ ] **Step 5: Compose Shape workflow**

Extend `ShapeWorkflowRequest`:

```ts
cleanupPreset: CleanupPreset;
cleanupOverrides: CleanupAdvancedOverrides;
```

Flow:

```ts
const cleanupEnabled = request.cleanupPreset !== 'off';
const paths = shapeWorkflowPaths(request.output, includesTexture, cleanupEnabled);
const shape = await generateShape({ ... output: paths.raw ... });
if (!shape.ok) return null;
setPreservedShapePath(paths.raw);

let textureInput = paths.raw;
if (cleanupEnabled) {
  const cleaned = await runCleanupInternal({
    input: paths.raw,
    output: paths.cleaned,
    preset: request.cleanupPreset,
    overrides: request.cleanupOverrides,
  }, { keepBusy: true, ... });
  if (!cleaned) return null;
  textureInput = cleaned;
}

if (!includesTexture) return textureInput;
return runTextureInternal({ ... mesh: textureInput ... }, { keepBusy: true, ... });
```

For texture failure, `retryContext.mesh` automatically becomes `textureInput`, which is the cleaned path when cleanup succeeded.

- [ ] **Step 6: Add standalone Mesh workflow**

Add:

```ts
export interface MeshWorkflowRequest {
  input: string;
  output: string;
  preset: CleanupPreset;
  overrides: CleanupAdvancedOverrides;
}
```

`runMeshWorkflow()` runs only cleanup, sets `preservedShapePath=input`, `cleanedShapePath=output`, `resultPath=output`, and stores report/timing.

- [ ] **Step 7: Wire App state/defaults and mode-specific prerequisites**

In `App.tsx` add:

```ts
const [cleanupPreset, setCleanupPreset] = useState<CleanupPreset>('light');
const [cleanupOverrides, setCleanupOverrides] = useState<CleanupAdvancedOverrides>({});
const [meshInputPath, setMeshInputPath] = useState<string | null>(null);
```

When switching mode:

```text
Shape default preset -> Light
Mesh default preset -> Game-ready unless the user already changed Mesh settings in the current app session
Texture does not alter cleanup settings
```

`canGenerate` rules become:

```text
Shape: source image required
Texture: source image + mesh required + texture runtime ready
Mesh: mesh input required; image and ROCm backend are not required
```

In Mesh mode, Save dialog should default to the imported stem plus `-clean` where platform dialog API permits; otherwise keep the existing save picker and pass the chosen output unchanged.

- [ ] **Step 8: Run hook/App tests and verify GREEN**

Run:

```bash
npm test -- --run apps/desktop/src/lib/useGenerationJob.test.ts apps/desktop/src/App.test.tsx
```

Expected: all tests PASS.

- [ ] **Step 9: Commit Task 6**

```bash
git add apps/desktop/src/lib/useGenerationJob.ts apps/desktop/src/lib/useGenerationJob.test.ts apps/desktop/src/App.tsx apps/desktop/src/App.test.tsx
git commit -m "feat: integrate cleanup into shape and mesh workflows"
```

---

### Task 7: Add Before/After viewer and cleanup Activity telemetry

**Files:**
- Modify: `apps/desktop/src/components/ModelViewer.tsx`
- Create or Modify: `apps/desktop/src/components/ModelViewer.test.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/App.test.tsx`

**Interfaces:**
- `ModelViewer` gains optional comparison props.
- App consumes `cleanedShapePath` and `cleanupReport` from Task 6.

- [ ] **Step 1: Write failing comparison UI test**

Mock/avoid Three.js rendering and assert these controls render when comparison paths are present:

```tsx
expect(screen.getByRole('button', { name: 'Before' })).toBeTruthy();
expect(screen.getByRole('button', { name: 'After' })).toBeTruthy();
```

Click Before/After and assert the active model URL passed to the loader/helper changes accordingly.

- [ ] **Step 2: Write failing Activity telemetry test**

In `App.test.tsx`, mock timing summary:

```ts
timingSummary: {
  totalMs: 1200,
  meshCleanupMs: 245,
  cleanupReport: {
    preset: 'game-ready',
    config_label: 'Game-ready',
    algorithm_version: 'mesh-cleanup-v1',
    triangles_before: 604308,
    triangles_after: 598120,
    vertices_before: 302100,
    vertices_after: 299500,
    components_before: 12,
    components_after: 2,
    components_removed: 10,
    vertices_welded: 110,
    spikes_adjusted: 4,
    cleanup_ms: 245,
    warnings: ['Large number of small components removed.'],
  },
}
```

Assert labels `Mesh cleanup`, `Components removed`, `Spikes adjusted`, `Cleanup preset`, and warning text.

- [ ] **Step 3: Run viewer/App tests and verify RED**

Run:

```bash
npm test -- --run apps/desktop/src/components/ModelViewer.test.tsx apps/desktop/src/App.test.tsx
```

Expected: FAIL because comparison/cleanup telemetry UI is absent.

- [ ] **Step 4: Implement viewer comparison state**

Add props:

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
  ...
}
```

Inside `ModelViewer`, keep local `comparisonSide: 'before' | 'after'` reset to `after` whenever comparison paths change. Derive:

```ts
const activeModelUrl = comparison
  ? comparisonSide === 'before' ? comparison.beforeUrl : comparison.afterUrl
  : modelUrl;
```

Use `activeModelUrl` in the existing Three loader effect. Overlay two buttons:

```tsx
<div className="viewer-comparison" aria-label="Mesh comparison">
  <button aria-pressed={comparisonSide === 'before'} onClick={() => setComparisonSide('before')}>Before</button>
  <button aria-pressed={comparisonSide === 'after'} onClick={() => setComparisonSide('after')}>After</button>
</div>
```

Show triangle counts beside labels when available.

- [ ] **Step 5: Wire Mesh-mode comparison from App**

Only enable comparison when:

```text
workflowMode === 'mesh'
meshInputPath exists
job.cleanedShapePath exists
```

Pass local asset URLs for both paths. Shape/Texture continue to use the existing single model preview.

- [ ] **Step 6: Add cleanup Activity rows**

Render when available:

```text
Mesh cleanup       245 ms / formatted duration
Cleanup preset     Game-ready or Custom (from ...)
Mesh               604,308 -> 598,120 triangles
Components removed 10
Vertices welded    110
Spikes adjusted    4
Algorithm          mesh-cleanup-v1 (technical/details section is acceptable)
```

Warnings render in a dedicated warning block and do not reuse the hard-error styling.

Do not fold `meshCleanupMs` into `Image prep`, `Mesh prep`, or `Inference` rows.

- [ ] **Step 7: Run viewer/App tests and verify GREEN**

Run:

```bash
npm test -- --run apps/desktop/src/components/ModelViewer.test.tsx apps/desktop/src/App.test.tsx
```

Expected: all tests PASS.

- [ ] **Step 8: Commit Task 7**

```bash
git add apps/desktop/src/components/ModelViewer.tsx apps/desktop/src/components/ModelViewer.test.tsx apps/desktop/src/App.tsx apps/desktop/src/App.test.tsx
git commit -m "feat: add mesh before-after comparison"
```

---

### Task 8: Full integration verification, regression documentation, and hardware validation handoff

**Files:**
- Modify: `docs/benchmarks/2026-09-12-rx6950xt-texture-baseline.md`
- Create: `docs/benchmarks/2026-09-12-game-ready-mesh-cleanup.md`
- Modify tests only if verification finds a concrete regression.

**Interfaces:**
- No new runtime interface. This task proves the milestone is stable and records the hardware/visual acceptance checklist.

- [ ] **Step 1: Run the complete Python suite**

Run:

```bash
python -m pip install -r backends/hunyuan/requirements-base.txt
python -m unittest discover -s backends/hunyuan/tests -v
python -m unittest discover -s backends/mesh_processing/tests -v
```

Expected: zero failures.

- [ ] **Step 2: Run the complete frontend suite and build**

Run:

```bash
npm test -- --run
npm run build
```

Expected: zero test failures and successful build.

- [ ] **Step 3: Run Rust tests/check**

Run:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: both succeed.

- [ ] **Step 4: Verify persistent Windows runtime packaging**

On the RX 6950 XT Windows machine:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup\windows-native-rocm.ps1 -VerifyOnly
```

Then verify these files exist:

```text
%LOCALAPPDATA%\Img2ModelAMD\runtime\native-rocm\worker.py
%LOCALAPPDATA%\Img2ModelAMD\runtime\native-rocm\backends\mesh_processing\__init__.py
```

Expected: VerifyOnly succeeds without reinstalling ROCm/models and refreshes worker + mesh-processing package.

- [ ] **Step 5: Run manual hardware acceptance matrix**

Use the same steak source/model currently used for texture benchmarks. Record:

```text
A. Shape -> Model only, Light
   - raw shape preserved
   - cleaned final opens
   - Light does not visibly distort silhouette

B. Shape -> Model + texture, Light
   - raw -shape preserved
   - intermediate -clean preserved
   - texture uses cleaned mesh
   - retry texture only points at -clean after a forced/reproduced texture failure

C. Mesh mode, Game-ready
   - imported GLB -> new clean output
   - Before/After works
   - protruding artifact improves without obvious valid-detail loss

D. Mesh mode, Aggressive
   - visible warning shown
   - output remains valid GLB/OBJ

E. Cached Balanced texture after cleanup
   - Image cache and Paint cache still hit when valid
   - cleanup time is a separate Activity row
   - warm Hunyuan Paint inference remains around the previous ~28-33 s range; cleanup must not silently reappear inside Texture prep
```

- [ ] **Step 6: Record cleanup benchmark document**

Create `docs/benchmarks/2026-09-12-game-ready-mesh-cleanup.md` with one table:

```markdown
| Preset | Cleanup ms | Triangles before | Triangles after | Components removed | Spikes adjusted | Visual result |
|---|---:|---:|---:|---:|---:|---|
| Light | ... | ... | ... | ... | ... | ... |
| Game-ready | ... | ... | ... | ... | ... | ... |
| Aggressive | ... | ... | ... | ... | ... | ... |
```

Also note whether Before/After and retry behavior passed.

- [ ] **Step 7: Update the existing RX 6950 XT baseline note**

Append a short section stating that the ~29 s cached Balanced texture result remains the Paint inference baseline and mesh cleanup is measured separately. Do not claim no regression unless the hardware run from Step 5 confirms it.

- [ ] **Step 8: Confirm GitHub Actions on the final HEAD**

Wait for the final branch CI run and verify all jobs are successful:

```text
frontend
python-worker
rust-core
desktop-windows
```

Do not declare the feature complete before this check and the hardware acceptance matrix both pass.

- [ ] **Step 9: Commit benchmark/docs changes**

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
- Taubin smoothing: Task 2.
- Cleanup report/telemetry: Tasks 1, 3, 4, 5, 7.
- Separate cleanup/texture cache concepts: Task 3.
- Clear-cache integration: Task 3.
- Errors/warnings/atomic output: Tasks 2, 6, 7.
- Retry texture with cleaned mesh: Task 6.
- Advanced -> visible Custom config: Tasks 1 and 5.
- Synthetic geometry tests with legitimate thin feature: Task 2.
- Steak visual regression and RX 6950 XT validation: Task 8.
- No PyMeshLab/manual editor/LOD/collision scope creep: Global Constraints.

### Type consistency

- Python uses snake_case report keys; Rust and TypeScript consume those same JSON keys for worker results.
- Tauri request is camelCase at the Rust boundary and worker namespace accepts request keys from JSONL.
- Cleanup preset values are consistently `off | light | game-ready | aggressive`.
- `meshCleanupMs` in TypeScript maps to worker `mesh_cleanup_ms`; `cleanupReport` maps to `cleanup_report`.
- `GenerationPhase` includes `mesh` before cleanup progress is wired.

### Execution note

Implement on a fresh feature branch/worktree created from `feat/persistent-worker-cache-impl`, not directly on the validated cache baseline branch. Recommended branch name: `feat/game-ready-mesh-cleanup`.
