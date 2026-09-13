# Adaptive Game-ready Remesh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace heuristic `Game-ready` / `Aggressive` cleanup with PyMeshLab repair, adaptive QEM reduction, optional Manifold3D validation, and game-asset-focused reporting while preserving conservative `Light` behavior.

**Architecture:** Keep `Light` on the current dependency-light Trimesh path. Route `Game-ready` and `Aggressive` through a new `pymeshlab_backend` adapter that repairs/remeshes geometry, generates progressively smaller QEM candidates, and accepts the smallest candidate whose symmetric normalized Hausdorff error stays under the preset tolerance. Manifold3D is a post-repair validator/finalizer only when its imported mesh status is valid; failure there is a warning, not a silent fallback to v1.

**Tech Stack:** Python 3.11, NumPy, Trimesh, PyMeshLab `2025.7.post1`, Manifold3D `3.5.3`, existing JSONL persistent worker, React/TypeScript/Tauri.

**Spec:** `docs/superpowers/specs/2026-09-13-game-ready-remesh-startup-design.md`

## Global Constraints

- `Light` stays conservative and must not depend on PyMeshLab being present.
- `Game-ready` and `Aggressive` use the heavy repair/remesh backend; do not silently fall back to `mesh-cleanup-v1` and report success.
- The source mesh is never overwritten; failed processing must not replace a previous valid output.
- The internal algorithm version becomes `mesh-cleanup-v2`; v1 cleanup cache entries are invalid.
- Auto reduction is geometric-error-driven and scale-independent using error normalized by the repaired reference bounding-box diagonal.
- A simple prop like the steak regression asset is expected to reduce from ~534k triangles to low thousands; preservation/error tolerance takes priority over an exact 5k target.
- Manual `Target triangles` overrides Auto and participates in cache identity.
- Topology-changing cleanup stays before Hunyuan Paint.
- PyMeshLab / third-party licensing is documented before public binary distribution; local development/hardware validation is not blocked.

---

## File Structure

- `backends/hunyuan/requirements-base.txt` — pin mesh-repair runtime dependencies.
- `scripts/setup/windows-native-rocm.ps1` — install/verify PyMeshLab and Manifold3D in the native runtime.
- `backends/mesh_processing/pymeshlab_backend.py` — conversion, repair, QEM candidate generation, Hausdorff scoring, optional Manifold3D finalization.
- `backends/mesh_processing/models.py` — v2 repair/reduction settings and report fields.
- `backends/mesh_processing/presets.py` — v2 preset policies and algorithm version.
- `backends/mesh_processing/cleanup.py` — route Light to v1-style conservative path and Game-ready/Aggressive to the heavy backend.
- `backends/mesh_processing/cache.py` — include v2 effective settings / manual target in cleanup identity.
- `backends/mesh_processing/tests/test_pymeshlab_backend.py` — backend conversion, repair, topology, and reduction tests.
- `backends/mesh_processing/tests/test_cleanup.py` — preset-level regression behavior.
- `backends/hunyuan/tests/test_windows_scripts.py` — runtime install/VerifyOnly coverage.
- `backends/hunyuan/worker.py` — pass triangle-budget overrides through existing `mesh_cleanup` command.
- `apps/desktop/src/domain/types.ts` — v2 report and override types.
- `apps/desktop/src/components/GenerationPanel.tsx` — Auto/manual triangle budget controls.
- `apps/desktop/src/lib/useGenerationJob.ts` — request/report plumbing.
- `apps/desktop/src/App.tsx` — Activity topology/reduction display.
- Existing frontend tests beside those files — v2 UI/report contract.

---

### Task 1: Pin and verify heavy mesh dependencies

**Files:**
- Modify: `backends/hunyuan/requirements-base.txt`
- Modify: `scripts/setup/windows-native-rocm.ps1`
- Modify: `backends/hunyuan/tests/test_windows_scripts.py`

**Interfaces:**
- Consumes: existing native Python 3.11 runtime.
- Produces: importable `pymeshlab==2025.7.post1` and `manifold3d==3.5.3`; VerifyOnly reports both modules as available.

- [ ] **Step 1: Write the failing dependency/runtime tests**

Add assertions equivalent to:

```python
requirements = Path("backends/hunyuan/requirements-base.txt").read_text()
self.assertIn("pymeshlab==2025.7.post1", requirements)
self.assertIn("manifold3d==3.5.3", requirements)

script = Path("scripts/setup/windows-native-rocm.ps1").read_text()
self.assertIn('import pymeshlab', script)
self.assertIn('import manifold3d', script)
self.assertIn('PyMeshLab', script)
self.assertIn('Manifold3D', script)
```

- [ ] **Step 2: Run RED**

Run:

```bash
python -m unittest backends.hunyuan.tests.test_windows_scripts -v
```

Expected: FAIL because the requirements and verification probes are absent.

- [ ] **Step 3: Add the pinned dependencies and verification probe**

Append exactly:

```text
pymeshlab==2025.7.post1
manifold3d==3.5.3
```

In `windows-native-rocm.ps1`, keep normal installation under step `[4/7]`; for both normal and `-VerifyOnly`, after worker files are synced run a one-shot Python import probe through `$PythonExe` that emits module versions/names and throws with a clear message if either import fails. Do not reinstall packages during VerifyOnly.

- [ ] **Step 4: Run GREEN**

Run:

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

### Task 2: Build the PyMeshLab repair adapter and topology metrics

**Files:**
- Create: `backends/mesh_processing/pymeshlab_backend.py`
- Create: `backends/mesh_processing/tests/test_pymeshlab_backend.py`
- Modify: `backends/mesh_processing/models.py`

**Interfaces:**
- Consumes: `trimesh.Trimesh`.
- Produces:

```python
@dataclass(frozen=True)
class RepairPolicy:
    close_holes_max_edges: int
    remove_component_faces_below: int
    isotropic_iterations: int
    isotropic_target_pct: float
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

def repair_with_pymeshlab(mesh: trimesh.Trimesh, policy: RepairPolicy) -> tuple[trimesh.Trimesh, RepairStats]
```

- [ ] **Step 1: Write RED geometry tests**

Create tests that build deterministic meshes in memory and verify:

```python
def test_repair_closes_small_hole_and_removes_tiny_component():
    # Start from a box, delete two adjacent faces to create a small boundary,
    # concatenate a tiny tetrahedron component, then repair.
    repaired, stats = repair_with_pymeshlab(source, policy)
    assert len(repaired.faces) > 0
    assert stats.components_removed >= 1
    assert stats.repair_backend.startswith("pymeshlab")


def test_conversion_round_trip_preserves_nonempty_mesh():
    repaired, _ = repair_with_pymeshlab(trimesh.creation.icosphere(subdivisions=1), policy)
    assert repaired.vertices.shape[1] == 3
    assert repaired.faces.shape[1] == 3
```

- [ ] **Step 2: Run RED**

```bash
python -m unittest backends.mesh_processing.tests.test_pymeshlab_backend -v
```

Expected: import/attribute failure because the adapter does not exist.

- [ ] **Step 3: Implement conversion and deterministic repair sequence**

Implement helpers using `pymeshlab.Mesh(vertex_matrix=..., face_matrix=...)` and `MeshSet.add_mesh(...)`. Use `MeshSet.apply_filter(...)` by string rather than relying on convenience methods that have changed between PyMeshLab releases.

For Game-ready-capable repair, run this sequence where applicable:

```python
ms.apply_filter("meshing_remove_duplicate_faces")
ms.apply_filter("meshing_remove_duplicate_vertices")
ms.apply_filter("meshing_remove_null_faces")
ms.apply_filter("meshing_repair_non_manifold_edges", method="Remove Faces")
ms.apply_filter("meshing_repair_non_manifold_vertices", vertdispratio=0.0)
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

Before hardcoding a filter parameter name, verify it with `pymeshlab.print_filter_parameter_list(<filter>)` in a local development probe; keep the adapter calling filters by string so 2025.7 method-name churn does not affect us.

Convert the final MeshSet mesh back with `vertex_matrix()` / `face_matrix()` and `trimesh.Trimesh(..., process=False)`.

- [ ] **Step 4: Add optional Manifold3D validation/finalization**

Use:

```python
from manifold3d import Manifold, Mesh
m = Mesh(
    vert_properties=np.asarray(mesh.vertices, dtype=np.float32),
    tri_verts=np.asarray(mesh.faces, dtype=np.uint32),
)
manifold = Manifold(m)
status = manifold.status()
```

Only replace geometry with `manifold.to_mesh()` when `status` indicates success and the returned mesh is non-empty. On invalid construction, keep the PyMeshLab result and append a warning; never convert a failed Manifold object into an empty output.

- [ ] **Step 5: Run GREEN**

```bash
python -m unittest backends.mesh_processing.tests.test_pymeshlab_backend -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backends/mesh_processing/pymeshlab_backend.py backends/mesh_processing/tests/test_pymeshlab_backend.py backends/mesh_processing/models.py
git commit -m "feat: add pymeshlab game-ready repair backend"
```

---

### Task 3: Add adaptive QEM reduction with normalized symmetric Hausdorff error

**Files:**
- Modify: `backends/mesh_processing/pymeshlab_backend.py`
- Modify: `backends/mesh_processing/models.py`
- Modify: `backends/mesh_processing/tests/test_pymeshlab_backend.py`

**Interfaces:**
- Produces:

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

def adaptive_qem_reduce(reference: trimesh.Trimesh, policy: ReductionPolicy) -> tuple[trimesh.Trimesh, ReductionStats]
```

- [ ] **Step 1: Write RED tests for adaptive behavior**

Use a dense sphere/rounded-box fixture created deterministically and assert:

```python
reduced, stats = adaptive_qem_reduce(dense_simple_prop, game_ready_policy)
self.assertLess(len(reduced.faces), len(dense_simple_prop.faces) * 0.10)
self.assertGreaterEqual(len(reduced.faces), game_ready_policy.min_faces)
self.assertLessEqual(stats.normalized_error, game_ready_policy.error_tolerance)

manual, manual_stats = adaptive_qem_reduce(dense_simple_prop, replace(game_ready_policy, manual_target_faces=5000))
self.assertLessEqual(abs(len(manual.faces) - 5000), 500)
```

Also add a thin-feature fixture and assert its bounding extent does not collapse beyond the tolerance.

- [ ] **Step 2: Run RED**

```bash
python -m unittest backends.mesh_processing.tests.test_pymeshlab_backend -v
```

Expected: FAIL because adaptive reduction is absent.

- [ ] **Step 3: Implement QEM candidate generation**

Create a fresh MeshSet from the repaired reference for each attempt and run:

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

Generate Auto candidates by starting at `min(len(reference.faces), policy.start_faces)` and multiplying by `0.70` until `policy.min_faces` is reached. Evaluate from largest to smallest and retain the smallest candidate that remains within tolerance. If the first candidate already exceeds tolerance, keep the repaired reference rather than violating the error bound.

- [ ] **Step 4: Implement symmetric normalized Hausdorff scoring**

Create one MeshSet containing reference and candidate. Run `get_hausdorff_distance` in both directions and take the maximum reported distance. Normalize by:

```python
bbox_diag = max(float(np.linalg.norm(reference.extents)), 1e-9)
normalized_error = symmetric_max_distance / bbox_diag
```

Use deterministic sampling parameters and a fixed sample count derived from face count with a capped range, so Auto produces stable results between runs.

Preset starting values for the first implementation:

```python
GAME_READY_REDUCTION = ReductionPolicy(
    min_faces=3000,
    start_faces=48000,
    error_tolerance=0.006,
)
AGGRESSIVE_REDUCTION = ReductionPolicy(
    min_faces=1500,
    start_faces=24000,
    error_tolerance=0.012,
)
```

These are tolerance policies, not hard final targets; the real steak acceptance test decides whether tuning is needed.

- [ ] **Step 5: Run GREEN**

```bash
python -m unittest backends.mesh_processing.tests.test_pymeshlab_backend -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backends/mesh_processing/pymeshlab_backend.py backends/mesh_processing/models.py backends/mesh_processing/tests/test_pymeshlab_backend.py
git commit -m "feat: add adaptive game-ready qem reduction"
```

---

### Task 4: Route presets through `mesh-cleanup-v2` and extend reports/cache identity

**Files:**
- Modify: `backends/mesh_processing/presets.py`
- Modify: `backends/mesh_processing/cleanup.py`
- Modify: `backends/mesh_processing/models.py`
- Modify: `backends/mesh_processing/cache.py`
- Modify: `backends/mesh_processing/tests/test_cleanup.py`
- Modify/add cache tests under `backends/mesh_processing/tests/`

**Interfaces:**
- `Light` continues to call the current conservative operations.
- `Game-ready` / `Aggressive` call `repair_with_pymeshlab()` then `adaptive_qem_reduce()`.
- `CleanupAdvancedOverrides` gains `triangle_budget_mode: "auto" | "manual"` and `target_triangles: int | None` at the protocol boundary; Python settings use snake_case equivalents.

- [ ] **Step 1: Write RED preset/report/cache tests**

Add assertions:

```python
self.assertEqual(resolve_cleanup_config("light", {}).algorithm_version, "mesh-cleanup-v2")

cleaned, report = cleanup_mesh(dense_simple_prop, resolve_cleanup_config("game-ready", {}))
self.assertTrue(report.remeshed)
self.assertEqual(report.repair_backend, "pymeshlab")
self.assertLess(report.triangles_after, report.triangles_before)
self.assertIsNotNone(report.watertight_before)
self.assertIsNotNone(report.watertight_after)

key_auto = cleanup_cache_key(path, resolve_cleanup_config("game-ready", {}))
key_manual = cleanup_cache_key(path, resolve_cleanup_config("game-ready", {"target_triangles": 5000, "triangle_budget_mode": "manual"}))
self.assertNotEqual(key_auto, key_manual)
```

- [ ] **Step 2: Run RED**

```bash
python -m unittest discover -s backends/mesh_processing/tests -v
```

Expected: FAIL on v2 report/settings fields.

- [ ] **Step 3: Implement v2 routing and report fields**

Extend `CleanupReport` with optional fields from the spec:

```python
watertight_before: bool | None = None
watertight_after: bool | None = None
manifold_before: bool | None = None
manifold_after: bool | None = None
boundary_edges_before: int | None = None
boundary_edges_after: int | None = None
holes_closed: int | None = None
non_manifold_edges_fixed: int | None = None
reduction_ratio: float | None = None
remeshed: bool = False
repair_backend: str | None = None
normalized_error: float | None = None
target_triangles: int | None = None
```

Set `ALGORITHM_VERSION = "mesh-cleanup-v2"`. Preserve existing v1 Light operations but emit the v2 version so cache identity is globally invalidated. For Game-ready/Aggressive, populate v2 topology/reduction fields and do not report `spikes_adjusted` as the principal success signal.

- [ ] **Step 4: Run GREEN**

```bash
python -m unittest discover -s backends/mesh_processing/tests -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backends/mesh_processing
git commit -m "feat: route game-ready cleanup through remesh v2"
```

---

### Task 5: Expose Auto/manual triangle budget and v2 Activity reporting

**Files:**
- Modify: `backends/hunyuan/worker.py`
- Modify: `apps/desktop/src/domain/types.ts`
- Modify: `apps/desktop/src/components/GenerationPanel.tsx`
- Modify: `apps/desktop/src/lib/useGenerationJob.ts`
- Modify: `apps/desktop/src/lib/tauri.ts` if request typing is duplicated there
- Modify: `apps/desktop/src/App.tsx`
- Modify: relevant frontend tests (`App.test.tsx`, GenerationPanel tests if present, `useGenerationJob.test.ts`)

**Interfaces:**
- UI sends:

```ts
interface CleanupAdvancedOverrides {
  // existing fields...
  triangle_budget_mode?: 'auto' | 'manual';
  target_triangles?: number | null;
}
```

- [ ] **Step 1: Write RED frontend and worker protocol tests**

Cover:

```ts
expect(screen.getByRole('radio', { name: /Auto/i })).toBeChecked();
// switching to Manual reveals Target triangles and sends 5000
expect(request.cleanup?.overrides?.target_triangles).toBe(5000);
```

And worker namespace parsing should preserve both new override keys.

- [ ] **Step 2: Run RED**

```bash
python -m unittest discover -s backends/hunyuan/tests -v
cd apps/desktop && npm test -- --run
```

Expected: new tests fail only on missing budget/report plumbing.

- [ ] **Step 3: Implement compact Advanced controls**

In Mesh mode Advanced, add a segmented `Auto | Manual` budget control. When Manual is selected, show:

```tsx
<input type="number" min={500} max={500000} step={500} value={target} />
```

Default Manual value when first selected: `5000`. Do not add the target input to Light unless the user selects Game-ready/Aggressive; Light has no heavy decimation budget.

- [ ] **Step 4: Update Activity emphasis**

Render v2 fields in this order when present:

```text
Cleanup preset
Triangles 534,364 -> 5,xxx
Reduction xx.x%
Watertight No -> Yes/No
Manifold No -> Yes/No
Repair backend PyMeshLab (+ Manifold3D when used)
Normalized error x.xxxx
Holes closed / non-manifold fixes when known
Algorithm mesh-cleanup-v2
Warnings
```

Keep old `vertices_welded` / `spikes_adjusted` only as secondary values when provided by Light.

- [ ] **Step 5: Run GREEN**

```bash
python -m unittest discover -s backends/hunyuan/tests -v
cd apps/desktop && npm test -- --run && npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backends/hunyuan/worker.py apps/desktop/src
git commit -m "feat: expose adaptive game-ready mesh budget"
```

---

### Task 6: Full regression, Windows runtime, steak hardware acceptance, then texture acceptance

**Files:**
- Modify only if verification reveals a defect; every defect starts a new RED test before production edits.
- Update docs/README only with verified dependency/setup behavior if needed.

**Interfaces:**
- Acceptance asset: existing generated steak raw shape around `534,364` triangles.

- [ ] **Step 1: Run the complete automated suite**

```bash
python -m unittest discover -s backends/hunyuan/tests -v
python -m unittest discover -s backends/mesh_processing/tests -v
cd apps/desktop && npm test -- --run && npm run build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
```

Expected: all PASS.

- [ ] **Step 2: Run CI and require all four jobs GREEN**

Require `frontend`, `python-worker`, `rust-core`, and `desktop-windows` success on the same HEAD.

- [ ] **Step 3: Update the Windows runtime**

On the RX 6950 XT machine:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup\windows-native-rocm.ps1
```

For later source-only updates:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup\windows-native-rocm.ps1 -VerifyOnly
```

Expected: PyMeshLab and Manifold3D import verification succeeds.

- [ ] **Step 4: Run steak Game-ready Auto acceptance**

Load the raw `model-shape.glb`, select `Game-ready`, `Triangle budget: Auto`, process, and record:

```text
triangles before/after
normalized error
watertight before/after
manifold before/after
repair backend
cleanup duration
visible artifact change
```

Acceptance: visible flap/spike artifacts improve materially; output is valid GLB; triangle count lands in low thousands if tolerance permits; silhouette remains recognizably correct. A near-no-op 500k result is failure.

- [ ] **Step 5: Run Game-ready Manual 5000 acceptance**

Set Manual target `5000`. Acceptance: result is approximately 5k triangles (allow backend tolerance), valid, and visually reasonable. If 5k visibly destroys the asset, Auto must remain the default and report why it stopped higher.

- [ ] **Step 6: Run Shape -> Game-ready -> Texture**

Generate or reuse the cleaned steak and run Hunyuan Paint against the reduced output. Acceptance: Paint consumes the cleaned low-poly mesh, not the raw 534k shape; successful output remains viewable and cleanup telemetry is retained.

- [ ] **Step 7: Commit only verified follow-up fixes/docs**

```bash
git add <verified-files-only>
git commit -m "test: validate adaptive game-ready mesh pipeline"
```
