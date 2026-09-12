# Game-ready mesh processing roadmap

**Status:** deferred — implement only after the current generation/texture optimization tools are finished, benchmarked, and stable.

## Why this exists

Generated meshes can contain small protruding polygons, thin spikes, tiny disconnected islands, shading artifacts, and unnecessarily dense geometry. These defects are especially visible on game props such as the current steak test asset.

This roadmap records the intended cleanup/export direction without expanding the current persistent-worker / prepared-mesh-cache milestone.

## Priority gate

Do **not** start this milestone until the current tooling is finished and validated, in particular:

1. persistent Shape/Paint worker stability,
2. prepared-mesh cache for repeated texture jobs,
3. cold/warm timing instrumentation,
4. OOM recovery and cache invalidation,
5. current Hunyuan Paint performance tuning and benchmark baseline.

The first implementation after that gate should remain automatic and preset-driven. A full manual mesh editor is explicitly out of scope.

## Phase A — automatic cleanup presets

Expose one primary control:

- **Off** — preserve generated mesh apart from required pipeline processing.
- **Light** — conservative artifact cleanup with minimal silhouette change.
- **Game-ready** — recommended default for game props; cleanup + controlled smoothing + normals repair.
- **Aggressive** — stronger cleanup for visibly noisy generations; may alter silhouette/detail.

Advanced options may expose the individual operations used by the preset.

### Initial operations

- remove degenerate / zero-area faces,
- weld vertices below a small distance threshold,
- remove very small disconnected components / islands,
- recompute or repair normals,
- detect and reduce isolated spikes / needle-like protrusions,
- optional Taubin-style smoothing to reduce noise while limiting shrinkage.

Prefer Taubin or another shrinkage-resistant method over naive repeated Laplacian smoothing for the default game-ready preset.

## Phase B — game asset preparation

After cleanup is proven useful and stable:

- align asset to ground,
- optional flatten-bottom pass for props that should sit on a surface,
- configurable pivot/origin placement,
- automatic LOD generation,
- simple collision output: convex hull and/or aggressively reduced collision mesh.

Suggested LOD starting point for a 20k working asset:

- LOD0: 20k
- LOD1: 10k
- LOD2: 5k
- LOD3: 2k

These values are presets, not hard requirements; later testing should determine better ratios per asset class.

## Pipeline position

Preferred order:

```text
Shape generation
  -> geometric cleanup
  -> target-triangle reduction / working-mesh preparation
  -> texture generation
  -> final game export / optional LODs / collision
```

Cleanup that changes topology should normally happen **before** texture generation so that UV/material output is produced for the final cleaned working geometry rather than being invalidated afterwards.

Post-texture operations must be restricted to transformations that preserve UV/material correctness, or must explicitly rebake/remap textures.

## Spike cleanup direction

The first spike-cleanup implementation should be automatic and conservative. Candidate signals include:

- vertices whose local displacement is an outlier relative to neighboring edge lengths,
- extremely thin triangles with abnormal aspect ratio,
- tiny connected protrusions with low area/volume contribution,
- local normal discontinuity inconsistent with neighboring faces.

Do not delete geometry solely because it is thin: horns, handles, stems, fins, and other legitimate features must survive. Presets should therefore differ primarily by thresholds rather than by entirely different algorithms.

## UX direction

Keep the basic workflow simple:

```text
Mesh cleanup
[ Off ] [ Light ] [ Game-ready ] [ Aggressive ]
```

Under **Advanced**:

- Remove small islands
- Weld nearby vertices
- Spike cleanup
- Smooth surface
- Smoothing iterations / strength
- Recompute normals
- Minimum component size

The 3D viewer should eventually support a before/after toggle and show triangle counts so the user can see what the cleanup pass changed.

## Validation

Use the same source asset before/after and record:

- triangles before and after,
- number/size of removed components,
- cleanup runtime,
- silhouette change,
- whether known protruding artifacts disappear,
- texture quality after cleanup,
- export validity in GLB,
- visual comparison in the built-in viewer.

The current steak asset should be kept as one regression example because it contains visible protruding-polygon artifacts.

## Later, separate manual tools

Do not fold these into the first mesh-cleanup milestone. Possible later work:

- click-select mesh regions,
- local smooth/relax brush,
- delete/fill selected region,
- simple local remesh,
- UV debug and surface-patch projection from the existing UV roadmap.

A Blender-like full mesh/UV editor remains explicitly out of scope unless the lightweight tools prove insufficient.
