# Game-ready mesh cleanup design

**Date:** 2026-09-12  
**Status:** Approved design, awaiting implementation plan  
**Repository:** `quendae/img2model-amd`

## 1. Goal

Add an automatic, reusable mesh-cleanup subsystem that improves generated and imported meshes for practical game-asset use without turning Img2Model AMD into a full mesh editor.

The same cleanup engine must support both:

1. generated Shape workflows, and
2. arbitrary imported `GLB` / `OBJ` meshes through a dedicated Mesh mode.

The system must preserve the original mesh, produce a separate cleaned copy, and keep the current stable Hunyuan Paint / persistent-worker / cache pipeline intact.

## 2. Scope

### Included in the first milestone

- New top-level workflow mode: `Shape | Texture | Mesh`.
- Reusable mesh-processing module outside the Hunyuan-specific worker logic.
- Cleanup presets: `Off`, `Light`, `Game-ready`, `Aggressive`.
- Default preset:
  - Shape: `Light`.
  - Mesh: `Game-ready`.
- Automatic cleanup in Shape workflows before texture generation.
- Standalone cleanup for imported `GLB` / `OBJ` meshes.
- Separate output file for cleaned geometry; the source is never overwritten.
- Before / After comparison in the 3D viewer for Mesh mode.
- Cleanup telemetry and reports.
- Cache identity that includes cleanup configuration and algorithm version.
- Regression coverage using the current steak asset with protruding artifacts.

### Explicitly out of scope for this milestone

- Full manual mesh editing.
- Delete/fill brushes or vertex/face editing.
- UV editor.
- Local remeshing brush.
- LOD generation.
- Collision generation.
- Ground alignment / flatten-bottom / pivot controls.
- PyMeshLab as a required dependency.

Those remain follow-up work after automatic cleanup is proven stable.

## 3. Existing pipeline and reason for the design

The current Hunyuan Paint preparation path already performs:

```text
FloaterRemover
  -> DegenerateFaceRemover
  -> FaceReducer
```

but this logic currently exists as texture preparation rather than as a reusable game-ready geometry stage.

The new design separates geometric cleanup from texture-specific preparation so the same cleanup can be used for:

```text
Generated Shape
Imported Mesh
Texture input
Future game-export tooling
```

Topology-changing cleanup must happen before Paint whenever possible so generated UV/material data is produced against the geometry that will actually be exported.

## 4. Architecture

### 4.1 New mesh-processing module

Create a dedicated module under a path such as:

```text
backends/mesh_processing/
```

This module owns cleanup logic and must not depend on Hunyuan model-loading internals.

Its conceptual interface is:

```text
process_mesh(
  input_mesh,
  preset,
  advanced_settings,
  algorithm_version
) -> cleaned_mesh + CleanupReport
```

The Hunyuan worker remains an orchestrator. It may invoke the cleanup module through a new persistent-worker command, but the cleanup implementation itself should not be embedded directly in `worker.py`.

### 4.2 Persistent worker protocol

Add a worker command such as:

```text
mesh_cleanup
```

The command accepts:

- input mesh path,
- output mesh path,
- cleanup preset,
- optional advanced settings,
- algorithm version.

It emits progress events and a terminal result containing the cleanup report.

This keeps mesh processing available through the same persistent session model as Shape and Texture without turning cleanup into another heavyweight GPU pipeline.

### 4.3 Dependency strategy

First implementation should prefer:

- `trimesh`,
- existing Hunyuan mesh utilities where they are generic enough,
- small custom geometry helpers.

Do not require PyMeshLab in the first milestone. It may be evaluated later only if the simpler stack cannot reliably solve the required cleanup cases.

## 5. Workflow modes

The Generation panel becomes:

```text
Shape | Texture | Mesh
```

### 5.1 Shape mode

Shape gets one additional control:

```text
Mesh cleanup
[ Off ] [ Light ] [ Game-ready ] [ Aggressive ]
```

Default: `Light`.

#### Model only

```text
source image
  -> Shape generation
  -> raw shape export
  -> selected cleanup preset
  -> cleaned output
```

The raw shape remains preserved.

Recommended filenames:

```text
model-shape.glb
model-clean.glb
```

#### Model + texture

Cleanup runs automatically without pausing for confirmation:

```text
source image
  -> Shape generation
  -> raw shape export
  -> cleanup
  -> cleaned mesh export
  -> texture working-mesh preparation / triangle reduction
  -> Hunyuan Paint
  -> textured output
```

Recommended filenames:

```text
model-shape.glb
model-clean.glb
model-textured.glb
```

A single Generate action should complete the whole workflow.

### 5.2 Texture mode

Texture mode remains focused on applying texture to an existing mesh.

It should consume whichever mesh the user explicitly chooses. When entered through recovery from a Shape + Texture job, it should prefer the already-cleaned mesh rather than the raw shape.

### 5.3 Mesh mode

Mesh mode supports arbitrary existing `GLB` / `OBJ` files.

Flow:

```text
Load mesh
  -> choose cleanup preset
  -> Process mesh
  -> save cleaned copy
  -> show Before / After comparison
```

Default preset: `Game-ready`.

The input file is never modified in place.

## 6. Cleanup presets

All presets use the same underlying processing pipeline and differ primarily by thresholds and enabled operations. This avoids maintaining four independent algorithms.

### 6.1 Off

- Preserve geometry.
- Do not perform optional cleanup.
- Only perform unavoidable format/export normalization when required.

### 6.2 Light

Goal: very low risk of visible silhouette change.

Operations:

- remove degenerate / zero-area faces,
- conservative weld of nearly identical vertices,
- remove only very small disconnected islands,
- repair / recompute normals where needed.

By default:

- no general smoothing,
- no aggressive spike correction.

This is the default preset for Shape mode.

### 6.3 Game-ready

Goal: sensible automatic default for props intended for game use.

Includes Light plus:

- moderate spike / needle-artifact cleanup,
- stronger disconnected-component cleanup,
- conservative Taubin-style smoothing,
- normals repair after topology changes.

This is the default preset for Mesh mode.

### 6.4 Aggressive

Goal: recover visibly noisy meshes when preservation is less important.

Uses stronger thresholds for:

- component removal,
- spike cleanup,
- smoothing.

The UI must clearly warn that Aggressive may alter silhouette and fine detail.

## 7. Spike detection strategy

Spike cleanup must not rely on a single heuristic. Legitimate thin geometry such as handles, horns, stems, antennae, fins, tails or blades must not be removed merely because it is thin.

A candidate spike should require a combination of signals such as:

- abnormal triangle aspect ratio,
- local edge-length outlier,
- very small local surface / volume contribution,
- local normal discontinuity,
- displacement inconsistent with neighboring geometry.

Presets alter thresholds rather than switching to unrelated algorithms.

The first implementation should remain conservative. False-negative artifacts are preferable to destroying legitimate geometry in Light or Game-ready.

## 8. Smoothing strategy

Prefer Taubin-style or another shrinkage-resistant smoothing method for the Game-ready preset.

Avoid repeated naive Laplacian smoothing as the default because it can visibly shrink generated props and distort silhouettes.

Light performs no general smoothing by default.

Aggressive may use more iterations / stronger values but must report that it can materially alter shape.

## 9. Cleanup report and telemetry

Every cleanup run produces a structured report.

Minimum fields:

```text
preset
algorithm_version
triangles_before
triangles_after
vertices_before
vertices_after
components_before
components_after
components_removed
vertices_welded
spikes_adjusted
cleanup_ms
warnings[]
```

If an operation cannot report an exact count reliably, the field may be omitted rather than fabricated.

Activity should show a compact subset, including:

- Mesh cleanup duration,
- triangles before / after,
- components removed,
- spikes adjusted when available,
- preset,
- warnings.

Advanced/debug telemetry may expose the full report.

## 10. Before / After viewer

Mesh mode must include Before / After comparison in the first milestone.

The viewer should retain both source and cleaned paths and allow simple switching between them.

Preferred initial interaction:

```text
[ Before ] [ After ]
```

A slider/wipe comparison may be considered later, but is not required for the first implementation.

The comparison should also show triangle counts so the user can understand the geometry change.

## 11. File preservation and outputs

Cleanup never overwrites the source mesh.

For generated Shape workflows:

```text
*-shape.glb   raw generator output
*-clean.glb   cleaned geometry
*-textured.glb final painted model when texture is requested
```

For standalone Mesh mode, the default output should similarly use a `-clean` suffix unless the user explicitly selects another output path.

Partial or failed cleanup must not replace a previously valid output.

## 12. Cache behavior

Prepared-mesh cache identity must include the effective cleanup result inputs.

At minimum the key must account for:

- resolved input path,
- file size,
- file modification time / identity,
- texture triangle target,
- cleanup preset,
- advanced cleanup settings,
- cleanup algorithm version.

Changing `Light -> Game-ready`, changing a cleanup threshold, or incrementing the cleanup algorithm version must invalidate the prepared mesh cache.

Image cache and Hunyuan Paint pipeline cache remain independent and should stay valid when only cleanup settings change.

A worker-level Clear cache command clears cleanup-derived mesh cache along with the existing prepared caches.

## 13. Error handling

### 13.1 Input / runtime errors

Examples:

- missing mesh,
- unsupported or corrupt input,
- unsupported output extension,
- required mesh dependency unavailable.

These produce a hard error before modifying any output.

### 13.2 Cleanup warnings

Warnings do not fail the job.

Examples:

- unusually large number of components removed,
- unusually high triangle reduction caused by cleanup,
- suspected large silhouette change,
- non-manifold geometry remains after cleanup.

Warnings are returned in `CleanupReport` and surfaced in Activity.

### 13.3 Hard cleanup failure

On failure:

- the original mesh remains untouched,
- no partial output replaces a valid file,
- the user receives a clear error,
- the UI may suggest retrying with a less aggressive preset.

### 13.4 Texture failure after successful cleanup

For Shape + Model + texture:

- keep `*-shape.glb`,
- keep `*-clean.glb`,
- do not discard a successful cleanup because Paint failed.

`Retry texture only` must reuse `*-clean.glb`, not regenerate Shape and not fall back to the raw mesh.

## 14. Progress and Activity states

The workflow should expose cleanup as its own stage rather than hiding it inside texture prep.

Example Shape + Texture activity sequence:

```text
Generating shape
Saving raw shape
Cleaning mesh
Preparing texture mesh
Generating texture
Exporting model
Complete
```

Timing summary should keep cleanup separate from Hunyuan Paint image prep / mesh prep / inference.

Suggested field:

```text
mesh_cleanup_ms
```

Do not fold cleanup time back into the existing generic texture preprocess metric.

## 15. Advanced settings

The first UI should remain preset-first.

An Advanced section may expose:

- Remove small islands,
- Weld nearby vertices,
- Spike cleanup,
- Smooth surface,
- smoothing strength / iterations,
- Recompute normals,
- minimum component size.

Defaults come from the selected preset.

Changing an advanced value creates an effective custom configuration even if the UI still shows the source preset label.

The full effective settings must be included in cache identity and cleanup report.

## 16. Testing strategy

Implementation must use test-first development.

### 16.1 Unit tests

Cover:

- preset resolution,
- cleanup settings normalization,
- cache key identity,
- no source overwrite,
- cleanup report serialization,
- worker command parsing,
- error classification,
- retry path selection of cleaned mesh.

### 16.2 Geometry tests

Use deterministic synthetic meshes for operations such as:

- degenerate face removal,
- tiny disconnected island removal,
- vertex welding,
- normals repair,
- conservative spike handling.

Tests should verify both what is removed and what must survive.

Include at least one deliberately thin legitimate feature so spike logic cannot simply delete all narrow protrusions.

### 16.3 Frontend tests

Cover:

- `Shape | Texture | Mesh` mode selection,
- Shape default `Light`,
- Mesh default `Game-ready`,
- preset controls,
- Activity cleanup timing/report,
- Before / After switching,
- recovery behavior after texture failure.

### 16.4 Integration tests

Required scenarios:

1. Shape + Light cleanup, Model only.
2. Shape + Light cleanup, Model + texture.
3. Imported GLB + Game-ready in Mesh mode.
4. Imported OBJ + Game-ready in Mesh mode.
5. Retry texture only after Paint failure uses the cleaned mesh.
6. `Off / Light / Game-ready / Aggressive` all export valid output.
7. Changing cleanup preset invalidates prepared mesh cache but preserves image/model cache where valid.

## 17. Hardware / visual validation

The current steak asset is the first real regression model because it has visible protruding-polygon artifacts.

For each preset record:

- cleanup runtime,
- triangles before / after,
- removed components,
- spikes adjusted,
- export validity,
- visible silhouette change,
- whether the known artifacts improve,
- texture quality after cleanup.

The first version is considered successful only if Light remains visually conservative and Game-ready improves known artifacts without visibly damaging ordinary detail.

Aggressive is allowed to alter more geometry, but its behavior must be explicit and predictable.

## 18. Future phases

After automatic cleanup is stable, extend Mesh mode rather than Texture mode with game-asset preparation features such as:

- align to ground,
- optional flatten bottom,
- configurable pivot/origin,
- LOD generation,
- simple collision output.

Later manual tools may include:

- region selection,
- local smooth / relax,
- delete / fill selected region,
- simple local remesh,
- UV debug and source-image patch projection.

A Blender-like full modeling environment remains out of scope.

## 19. Implementation principles

- Preserve raw generated/imported geometry.
- Topology-changing cleanup happens before Paint.
- Keep cleanup independent from Hunyuan model internals.
- Prefer conservative defaults.
- Keep presets as parameter sets over one common pipeline.
- Avoid new heavy dependencies until real regression assets prove they are required.
- Preserve the existing persistent worker, Paint cache, image cache and prepared-mesh performance behavior.
- Report measurable changes rather than hiding automatic processing from the user.
