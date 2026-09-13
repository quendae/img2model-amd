# Adaptive Game-ready Remesh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace heuristic `Game-ready` / `Aggressive` cleanup with PyMeshLab repair, isotropic remeshing, adaptive QEM reduction, and optional Manifold3D validation while preserving conservative `Light` behavior.

**Architecture:** `Light` remains on the current Trimesh path. `Game-ready` and `Aggressive` use a new `pymeshlab_backend.py`: repair topology, remove debris, close holes, isotropically remesh, generate QEM candidates, measure symmetric Hausdorff error normalized by bounding-box diagonal, and keep the smallest candidate within the preset tolerance. Manifold3D only validates/finalizes an already repaired mesh; failure there is reported as a warning.

**Tech Stack:** Python 3.11, NumPy, Trimesh, PyMeshLab `2025.7.post1`, Manifold3D `3.5.3`, existing persistent JSONL worker, React/TypeScript/Tauri.

**Spec:** `docs/superpowers/specs/2026-09-13-game-ready-remesh-startup-design.md`

## Global Constraints

- `Light` must work without PyMeshLab.
- `Game-ready` / `Aggressive` must never silently fall back to v1 and claim success.
- Source meshes are never overwritten.
- Algorithm version becomes `mesh-cleanup-v2`, invalidating v1 cleanup cache entries.
- Auto reduction is geometric-error-driven and scale-independent.
- Steak acceptance target is low-thousands triangles when error tolerance permits, not a fixed 5k.
- Manual triangle target overrides Auto and participates in cache identity.
- Topology-changing cleanup remains before Hunyuan Paint.

---

### Task 1: Pin and verify mesh-repair dependencies

**Files:**
- Modify: `backends/hunyuan/requirements-base.txt`
- Modify: `scripts/setup/windows-native-rocm.ps1`
- Modify: `backends/hunyuan/tests/test_windows_scripts.py`

**Produces:** Python 3.11 runtime with `pymeshlab==2025.7.post1` and `manifold3d==3.5.3`; `-VerifyOnly` verifies imports without reinstalling.

- [ ] **Step 1: Write RED test**

Add to `test_windows_scripts.py`:

```python
requirements = Path("backends/hunyuan/requirements-base.txt").read_text(encoding="utf-8")
self.assertIn("pymeshlab==2025.7.post1", requirements)
self.assertIn("manifold3d==3.5.3", requirements)
script = Path("scripts/setup/windows-native-rocm.ps1").read_text(encoding="utf-8")
self.assertIn("import pymeshlab", script)
self.assertIn("import manifold3d", script)
```

- [ ] **Step 2: Verify RED**

```bash
python -m unittest backends.hunyuan.tests.test_windows_scripts -v
```

Expected: FAIL on missing dependency/probe text.

- [ ] **Step 3: Implement**

Append to `requirements-base.txt`:

```text
pymeshlab==2025.7.post1
manifold3d==3.5.3
```

Add a verification call after worker sync in `windows-native-rocm.ps1` that executes `$PythonExe` with a temporary `.py` file containing:

```python
import pymeshlab
import manifold3d
print("PyMeshLab OK")
print("Manifold3D OK")
```

Normal setup installs the requirements; `-VerifyOnly` skips installation but runs this probe.

- [ ] **Step 4: Verify GREEN**

```bash
python -m unittest backends.hunyuan.tests.test_windows_scripts -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backends/hunyuan/requirements-base.txt scripts/setup/windows-native-rocm.ps1 backends/hunyuan/tests/test_windows_scripts.py
git commit -m "feat: add game-ready mesh runtime dependencies"
```

---

### Task 2: Add PyMeshLab repair/remesh adapter

**Files:**
- Create: `backends/mesh_processing/pymeshlab_backend.py`
- Create: `backends/mesh_processing/tests/test_pymeshlab_backend.py`
- Modify: `backends/mesh_processing/models.py`

**Produces:**

```python
@dataclass(frozen=True)
class RepairPolicy:
    close_holes_max_edges: int
    remove_component_faces_below: int
    isotropic_iterations: int
    isotropic_target_percent: float
    manifold_finalize: bool

@dataclass
class RepairStats:
    watertight_before: bool
    watertight_after: bool
    boundary_edges_before: int | None
    boundary_edges_after: int | None
    holes_closed: int | None
    non_manifold_edges_fixed: int | None
    components_removed: int
    remeshed: bool
    repair_backend: str
    warnings: list[str]

def repair_with_pymeshlab(mesh: trimesh.Trimesh, policy: RepairPolicy) -> tuple[trimesh.Trimesh, RepairStats]: ...
```

- [ ] **Step 1: Write RED tests**

Build a box with two deleted faces plus a tiny disconnected tetrahedron and assert repair returns a non-empty mesh, removes the tiny component, and marks backend `pymeshlab`. Add a round-trip icosphere test.

- [ ] **Step 2: Verify RED**

```bash
python -m unittest backends.mesh_processing.tests.test_pymeshlab_backend -v
```

Expected: FAIL because module/functions do not exist.

- [ ] **Step 3: Implement deterministic repair**

Convert using `pymeshlab.Mesh(vertex_matrix=..., face_matrix=...)`; call filters by string through `MeshSet.apply_filter` to avoid 2025.7 convenience-method churn:

```python
ms.apply_filter("meshing_remove_duplicate_faces")
ms.apply_filter("meshing_remove_duplicate_vertices")
ms.apply_filter("meshing_remove_null_faces")
ms.apply_filter("meshing_repair_non_manifold_vertices", vertdispratio=0.0)
ms.apply_filter("meshing_repair_non_manifold_edges", method=0)
ms.apply_filter(
    "meshing_remove_connected_component_by_face_number",
    mincomponentsize=policy.remove_component_faces_below,
    removeunref=True,
)
ms.apply_filter(
    "meshing_close_holes",
    maxholesize=policy.close_holes_max_edges,
    selected=False,
    newfaceselected=False,
    selfintersection=True,
)
```

When `policy.isotropic_iterations > 0`, run:

```python
ms.apply_filter(
    "meshing_isotropic_explicit_remeshing",
    iterations=policy.isotropic_iterations,
    targetlen=pymeshlab.PercentageValue(policy.isotropic_target_percent),
    adaptive=True,
    selectedonly=False,
    checksurfdist=True,
)
```

Before finalizing these parameters, execute `pymeshlab.print_filter_parameter_list()` for the three parameterized filters in the pinned 2025.7 runtime and make the test assert the adapter uses the names actually accepted there.

Convert back with `vertex_matrix()` / `face_matrix()` and `trimesh.Trimesh(..., process=False)`.

- [ ] **Step 4: Add optional Manifold3D finalization**

```python
from manifold3d import Manifold, Mesh
m3 = Mesh(
    vert_properties=np.asarray(mesh.vertices, dtype=np.float32),
    tri_verts=np.asarray(mesh.faces, dtype=np.uint32),
)
manifold = Manifold(m3)
if str(manifold.status()).endswith("NoError") and not manifold.is_empty():
    out = manifold.to_mesh()
    mesh = trimesh.Trimesh(
        vertices=np.asarray(out.vert_properties)[:, :3],
        faces=np.asarray(out.tri_verts),
        process=False,
    )
else:
    stats.warnings.append(f"Manifold3D finalization skipped: {manifold.status()}")
```

- [ ] **Step 5: Verify GREEN**

```bash
python -m unittest backends.mesh_processing.tests.test_pymeshlab_backend -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backends/mesh_processing/pymeshlab_backend.py backends/mesh_processing/models.py backends/mesh_processing/tests/test_pymeshlab_backend.py
git commit -m "feat: add pymeshlab repair and remesh backend"
```

---

### Task 3: Add adaptive QEM reduction

**Files:**
- Modify: `backends/mesh_processing/pymeshlab_backend.py`
- Modify: `backends/mesh_processing/models.py`
- Modify: `backends/mesh_processing/tests/test_pymeshlab_backend.py`

**Produces:**

```python
@dataclass(frozen=True)
class ReductionPolicy:
    min_faces: int
    start_faces: int
    error_tolerance: float
    manual_target_faces: int | None = None

@dataclass
class ReductionStats:
    requested_target_faces: int | None
    accepted_faces: int
    normalized_error: float | None
    attempts: int

def adaptive_qem_reduce(reference: trimesh.Trimesh, policy: ReductionPolicy) -> tuple[trimesh.Trimesh, ReductionStats]: ...
```

- [ ] **Step 1: Write RED tests**

Use deterministic dense icosphere/rounded-prop fixtures. Assert Auto substantially reduces face count while staying within tolerance; Manual 5000 lands within ±500 faces; a thin legitimate feature keeps its overall extent within tolerance.

- [ ] **Step 2: Verify RED**

```bash
python -m unittest backends.mesh_processing.tests.test_pymeshlab_backend -v
```

Expected: FAIL on missing adaptive reducer.

- [ ] **Step 3: Implement QEM candidates**

For every candidate create a fresh MeshSet and apply:

```python
ms.apply_filter(
    "meshing_decimation_quadric_edge_collapse",
    targetfacenum=target_faces,
    preserveboundary=True,
    preservenormal=True,
    optimalplacement=True,
    autoclean=True,
)
```

Auto candidates start at `min(len(reference.faces), start_faces)` and multiply by `0.70` until `min_faces`. Manual mode evaluates only the requested target.

Initial policies:

```python
GAME_READY_REDUCTION = ReductionPolicy(3000, 48000, 0.006)
AGGRESSIVE_REDUCTION = ReductionPolicy(1500, 24000, 0.012)
```

- [ ] **Step 4: Implement normalized symmetric Hausdorff scoring**

Put reference and candidate in one MeshSet. Call `get_hausdorff_distance` reference→candidate and candidate→reference with deterministic sampling; use the returned maximum distance from each run and take their maximum. Normalize:

```python
bbox_diag = max(float(np.linalg.norm(reference.extents)), 1e-9)
normalized_error = symmetric_max / bbox_diag
```

Keep the smallest candidate with `normalized_error <= error_tolerance`. If no candidate passes, keep the repaired reference and report a warning.

- [ ] **Step 5: Verify GREEN**

```bash
python -m unittest backends.mesh_processing.tests.test_pymeshlab_backend -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backends/mesh_processing/pymeshlab_backend.py backends/mesh_processing/models.py backends/mesh_processing/tests/test_pymeshlab_backend.py
git commit -m "feat: add adaptive qem game-ready reduction"
```

---

### Task 4: Integrate `mesh-cleanup-v2`, reports, and cache identity

**Files:**
- Modify: `backends/mesh_processing/presets.py`
- Modify: `backends/mesh_processing/cleanup.py`
- Modify: `backends/mesh_processing/models.py`
- Modify: `backends/mesh_processing/cache.py`
- Modify: `backends/mesh_processing/tests/test_cleanup.py`
- Modify: cleanup-cache tests in `backends/mesh_processing/tests/`

- [ ] **Step 1: Write RED tests**

Assert `ALGORITHM_VERSION == "mesh-cleanup-v2"`; Light stays conservative; Game-ready reports `remeshed=True`, `repair_backend="pymeshlab"`, topology fields, and meaningful reduction; cache key changes between Auto and Manual 5000.

- [ ] **Step 2: Verify RED**

```bash
python -m unittest discover -s backends/mesh_processing/tests -v
```

- [ ] **Step 3: Implement v2 routing/report**

Extend `CleanupReport` with optional `watertight_before/after`, `manifold_before/after`, `boundary_edges_before/after`, `holes_closed`, `non_manifold_edges_fixed`, `reduction_ratio`, `remeshed`, `repair_backend`, `normalized_error`, and `target_triangles`. Add settings `triangle_budget_mode: str = "auto"` and `target_triangles: int | None = None`.

`Light` executes current conservative functions. `Game-ready` / `Aggressive` execute repair/remesh then adaptive QEM. Set `ALGORITHM_VERSION = "mesh-cleanup-v2"`.

- [ ] **Step 4: Verify GREEN**

```bash
python -m unittest discover -s backends/mesh_processing/tests -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backends/mesh_processing
git commit -m "feat: integrate mesh cleanup v2"
```

---

### Task 5: Expose Auto/manual budget and v2 Activity telemetry

**Files:**
- Modify: `backends/hunyuan/worker.py`
- Modify: `apps/desktop/src/domain/types.ts`
- Modify: `apps/desktop/src/components/GenerationPanel.tsx`
- Modify: `apps/desktop/src/lib/useGenerationJob.ts`
- Modify: `apps/desktop/src/lib/tauri.ts` if request types are duplicated there
- Modify: `apps/desktop/src/App.tsx`
- Modify: existing worker/frontend tests covering cleanup requests and Activity.

- [ ] **Step 1: Write RED tests**

Frontend: Game-ready/Aggressive Advanced defaults to `Auto`; selecting `Manual` reveals numeric target and sends `target_triangles=5000`. Worker test verifies the two override keys survive protocol parsing.

- [ ] **Step 2: Verify RED**

```bash
python -m unittest discover -s backends/hunyuan/tests -v
cd apps/desktop && npm test -- --run
```

- [ ] **Step 3: Implement controls and request plumbing**

Add to TypeScript overrides:

```ts
triangle_budget_mode?: 'auto' | 'manual';
target_triangles?: number | null;
```

Show budget controls only for Game-ready/Aggressive. Manual input uses `min=500`, `max=500000`, `step=500`, default `5000`.

- [ ] **Step 4: Update Activity**

Display, when present: triangles before→after, reduction %, watertight before→after, manifold before→after, repair backend, normalized error, holes/non-manifold counts, algorithm, warnings. Keep welded/spikes as secondary Light metrics.

- [ ] **Step 5: Verify GREEN**

```bash
python -m unittest discover -s backends/hunyuan/tests -v
cd apps/desktop && npm test -- --run && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add backends/hunyuan/worker.py apps/desktop/src
git commit -m "feat: expose adaptive game-ready mesh budget"
```

---

### Task 6: Automated and RX 6950 XT acceptance

**Files:** no production edits during acceptance; any discovered defect starts a new failing test in the owning task before a fix.

- [ ] **Step 1: Full automated suite**

```bash
python -m unittest discover -s backends/hunyuan/tests -v
python -m unittest discover -s backends/mesh_processing/tests -v
cd apps/desktop && npm test -- --run && npm run build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
```

- [ ] **Step 2: Require CI 4/4 GREEN**

Require `frontend`, `python-worker`, `rust-core`, `desktop-windows` on one HEAD.

- [ ] **Step 3: Install/verify the updated Windows runtime**

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup\windows-native-rocm.ps1
```

Later source-only syncs may use `-VerifyOnly`.

- [ ] **Step 4: Steak Game-ready Auto**

Process raw ~534k `model-shape.glb`. Record triangles, normalized error, watertight/manifold before→after, backend, duration, and visible artifact improvement. Acceptance: valid GLB, visible artifact improvement, silhouette preserved, and low-thousands triangles when tolerance permits; a near-no-op 500k result fails acceptance.

- [ ] **Step 5: Steak Manual 5000**

Process with Manual `5000`. Acceptance: approximately 5k triangles and visually reasonable output. If 5k destroys silhouette, Auto remains authoritative.

- [ ] **Step 6: Shape → Game-ready → Texture**

Verify Hunyuan Paint receives the cleaned/reduced output, not the raw 534k mesh, and produces a viewable result.

- [ ] **Step 7: Acceptance conclusion**

If all checks pass, no extra commit is created. If any check fails, return to the owning task, add a RED regression test, implement one fix, rerun that task and then repeat this acceptance task.
