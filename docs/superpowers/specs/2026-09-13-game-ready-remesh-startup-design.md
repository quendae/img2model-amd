# Adaptive game-ready remesh and startup preload design

**Date:** 2026-09-13  
**Status:** Approved in chat; written spec for review  
**Repository:** `quendae/img2model-amd`

## 1. Goal

Replace the current heuristic-heavy `Game-ready` / `Aggressive` cleanup behavior with a proven repair + remesh + reduction pipeline that produces genuinely usable game assets from dense Hunyuan meshes, while keeping `Light` conservative.

At the same time, improve startup UX so the application never appears frozen while the persistent worker and Hunyuan Shape pipeline are loading.

## 2. Why the cleanup architecture changes

The current `mesh-cleanup-v1` implementation is intentionally conservative and works on synthetic single-vertex spikes, but it is not effective on real Hunyuan output. On the real steak regression mesh:

- input: ~534k triangles,
- `Game-ready` removed only one triangle,
- only two vertices were welded,
- `spikes_adjusted = 0`,
- the visible artifacts remained,
- the mesh remained non-watertight.

The issue is architectural rather than threshold-only: real generated artifacts are often connected sheets, folds, self-intersections, narrow flaps and noisy surface patches rather than one isolated elongated vertex. Continuing to tune a hand-written spike heuristic would be brittle.

## 3. Dependency strategy

### 3.1 PyMeshLab

Use PyMeshLab as the main repair / remesh / decimation backend for `Game-ready` and `Aggressive`.

Relevant capabilities include:

- merge close / duplicate vertices,
- remove duplicate / degenerate faces,
- repair isolated folded faces,
- remove small connected components,
- close holes,
- isotropic remeshing,
- quadric-edge-collapse decimation.

PyMeshLab is allowed as a dependency for this project. Distribution/licensing implications must be documented before a packaged public release.

### 3.2 Manifold3D

Use `manifold3d` as an optional validation/finalization stage where it can safely produce a valid manifold solid.

It is not the first-stage repair tool because malformed meshes may not satisfy its input assumptions. PyMeshLab repair runs first.

### 3.3 PyMeshFix

Do not make PyMeshFix a default dependency in this milestone. It is useful for watertight reconstruction, but its licensing adds another constraint and the PyMeshLab + Manifold3D path should be proven first.

## 4. Cleanup preset semantics

### 4.1 Off

No cleanup beyond unavoidable format normalization.

### 4.2 Light

Keep the current conservative intent.

Operations:

- remove degenerate faces,
- conservative near-vertex welding,
- remove only tiny disconnected islands,
- winding / normals repair.

No general remesh and no heavy triangle reduction.

Default for Shape mode remains `Light`.

### 4.3 Game-ready

`Game-ready` changes meaning: it is not merely repaired high-poly geometry; it should produce a practical game asset.

Pipeline:

```text
input mesh
  -> sanity cleanup
  -> PyMeshLab repair
  -> remove tiny debris / folded faces / non-manifold defects where safe
  -> close repairable holes
  -> isotropic remesh where required
  -> adaptive QEM decimation
  -> winding / normals repair
  -> manifold / watertight validation
  -> optional Manifold3D finalization when safe
  -> output
```

For a simple prop such as the steak regression asset, the expected result should be in the low-thousands range rather than tens or hundreds of thousands of triangles.

Target expectation for the steak: approximately **3k-6k triangles**, with a hard expectation that an ordinary single prop should not remain anywhere near 100k+ unless the geometry genuinely requires it.

### 4.4 Aggressive

Uses the same pipeline as Game-ready but allows:

- stronger hole repair,
- stronger isotropic remesh,
- higher geometric-error tolerance,
- lower triangle budget,
- more aggressive debris removal.

For a simple prop, a typical result may be around **1.5k-4k triangles**.

The UI must continue to warn that Aggressive can change silhouette and fine detail.

## 5. Adaptive triangle budget

Do not use one fixed target for every model.

The automatic reducer should be error-driven:

1. build a repaired/remeshed reference mesh,
2. try progressively smaller QEM targets,
3. compare the reduced result against the repaired reference,
4. stop reducing when geometric deviation crosses the preset tolerance,
5. enforce sensible lower / upper bounds.

This allows simple props to collapse to only a few thousand triangles while more complex shapes preserve additional geometry.

The implementation should prefer normalized geometric error relative to the mesh bounding-box diagonal so behavior is scale-independent.

If reliable geometric-error measurement is unavailable on a platform, use a deterministic fallback budget heuristic based on mesh complexity and preset caps rather than input triangle count alone.

## 6. Manual override

Advanced settings gain:

```text
Triangle budget
[ Auto ]
Target triangles: <integer>
```

`Auto` is the default.

When the user supplies a manual target, QEM should aim for that target after repair/remesh, subject to topology validity safeguards.

Changing the target participates in cleanup cache identity.

## 7. Topology / repair reporting

The current `spikes_adjusted` metric becomes secondary. It may remain for Light but should not be the primary measure for Game-ready.

Add report fields where available:

```text
watertight_before
watertight_after
manifold_before
manifold_after
boundary_edges_before
boundary_edges_after
holes_closed
non_manifold_edges_fixed
components_removed
triangles_before
triangles_after
vertices_before
vertices_after
reduction_ratio
remeshed
repair_backend
algorithm_version
cleanup_ms
warnings[]
```

Do not fabricate exact counts if a backend cannot report them reliably.

Activity should prominently show:

- `534k -> 5k tris` style reduction,
- watertight before/after,
- selected backend / preset,
- holes/non-manifold repair when known,
- warnings when topology is still invalid.

## 8. Failure and fallback behavior

The source mesh is never overwritten.

If PyMeshLab repair fails:

- preserve the original,
- return a clear hard error for Game-ready/Aggressive,
- do not silently fall back to the old heuristic and claim Game-ready success.

If Manifold3D finalization fails but the PyMeshLab result is otherwise valid enough:

- keep the PyMeshLab result,
- emit a warning,
- report `manifold_after` / `watertight_after` honestly.

Light remains independent of the heavy backend and should still work even if PyMeshLab is unavailable.

## 9. Cache identity

Increment the internal cleanup algorithm version when the new backend is enabled, e.g. `mesh-cleanup-v2`.

Cache identity must include:

- input file identity,
- preset,
- effective repair/remesh settings,
- Auto/manual triangle budget,
- error tolerance,
- backend version / algorithm version.

A cache entry generated by `mesh-cleanup-v1` must never be reused by v2.

## 10. Texture workflow

Topology-changing repair/remesh remains before Hunyuan Paint.

For `Shape -> Model + Texture`:

```text
Shape raw output
  -> selected cleanup
  -> cleaned / game-ready output
  -> texture mesh preparation
  -> Hunyuan Paint
```

If Game-ready reduces a 500k mesh to a few thousand triangles, Paint should texture the reduced mesh rather than reintroducing a high-poly intermediate.

Retry Texture continues to reuse the successfully cleaned mesh.

## 11. Startup lifecycle redesign

The current preload works but the application window can appear frozen while the persistent worker and Hunyuan model initialize.

Use a Tauri splashscreen pattern:

```text
process start
  -> show lightweight splash immediately
  -> keep main window hidden
  -> start persistent worker
  -> runtime health check
  -> preload Hunyuan3D Shape pipeline
  -> mark runtime ready
  -> close splash
  -> show main window
```

The splash should remain responsive and show a small status sequence such as:

```text
Img2Model AMD
Starting ROCm worker...
Loading Hunyuan3D 2 Mini...
Preparing GPU...
Ready
```

Do not wait for Hunyuan Paint at startup; Paint stays lazy.

If Shape preload fails:

- do not leave the user staring at the splash forever,
- show the main window in an error state after a bounded timeout/failure,
- expose Retry / Restart worker.

Mesh mode should remain usable if Hunyuan startup fails.

## 12. Startup implementation boundary

The Rust/Tauri startup layer owns splash/main-window visibility and worker initialization orchestration.

The frontend should receive runtime state after the main window is shown rather than duplicating startup work on mount.

The existing frontend lifecycle hook may remain for re-preload after Texture eviction and worker restart, but the first application preload should originate from the Tauri startup lifecycle.

This avoids the current visual sequence where the GUI renders first and then appears unresponsive during initialization.

## 13. Testing strategy

Implementation remains test-first.

### 13.1 Cleanup unit/integration tests

Add deterministic tests for:

- malformed/open mesh becomes watertight where repair is expected,
- duplicate / folded / degenerate geometry repair,
- disconnected debris removal,
- Game-ready performs substantial reduction on a dense simple prop fixture,
- Aggressive reduces further than Game-ready,
- thin legitimate features survive within error tolerance,
- manual triangle target is honored approximately,
- Auto budget is deterministic,
- v1 cache cannot be reused by v2,
- failure does not overwrite source or previous valid output.

### 13.2 Real regression acceptance

Use the current steak model as the main real-world acceptance asset.

Acceptance target:

- visible artifact improvement,
- triangle count reduced from ~534k to low thousands for Game-ready,
- no obvious destruction of steak silhouette,
- valid GLB export,
- accurate topology/watertight report,
- successful texture generation against the reduced mesh.

Exact final triangle count is not a hard 5k requirement; preservation/error tolerance takes priority, but a simple prop remaining extremely high-poly is considered failure.

### 13.3 Startup tests

Cover:

- splash is configured as visible and main window initially hidden,
- successful worker preload closes splash and shows main,
- preload failure still shows main with runtime error,
- restart and Shape re-preload still work after main window is visible,
- Paint is not loaded during startup.

Manual Windows acceptance should confirm that the splash appears immediately instead of the application looking frozen for ~20 seconds.

## 14. UI changes

Keep the current compact QHD layout.

Mesh/cleanup Advanced gains Auto/manual triangle budget controls.

Activity shifts emphasis from `Spikes adjusted` to reduction and topology status.

No full modeling/editor controls are added in this milestone.

## 15. Dependency installation

The Windows native runtime setup must install and verify the selected PyMeshLab and Manifold3D versions.

`-VerifyOnly` should report whether these dependencies are present and usable, just like the existing runtime checks.

The packaged runtime must pin versions that are proven with the application's supported Python version.

## 16. Licensing note

PyMeshLab and any transitive native components must receive a distribution/license review before shipping a public binary. Manifold3D is comparatively permissive, but its license information should still be included in third-party notices.

This licensing review does not block local development and hardware validation.

## 17. Success criteria

This revision is successful when:

1. `Light` remains conservative.
2. `Game-ready` visibly improves real Hunyuan artifacts instead of reporting nearly no-op cleanup.
3. The steak regression mesh falls from ~534k triangles to a low-thousands game-ready mesh without unacceptable silhouette loss.
4. Game-ready reports topology state honestly and repairs holes/non-manifold defects where practical.
5. Texture generation works on the cleaned low-poly mesh.
6. Startup immediately shows a responsive splash and the main UI appears only after Shape preload completes or fails cleanly.
7. Existing Shape, Texture, persistent-worker and cache workflows remain functional.
