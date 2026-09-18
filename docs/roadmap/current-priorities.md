# Current development priorities

Updated: 2026-09-18

This file records the current execution order. Detailed implementation notes remain in the linked issues and roadmap documents.

## 1. Finish dense-mesh Light cleanup performance work (#6)

Immediate next action: rerun the same dense wood-stack sample with the telemetry bridge fix and collect `Cleanup stage timings`.

Then optimize only the measured hotspot while preserving the currently validated geometry behavior:

- watertight repair remains successful,
- manifold repair remains successful,
- no unnecessary remesh in Light,
- no visible silhouette regression.

## 2. Close remaining texture-target / game-ready acceptance (#4)

Validate the complete Shape -> Cleanup -> Texture route after the cleanup latency work is stable.

Representative checks:

- game-oriented target triangle presets,
- actual final triangle counts,
- visual texture quality at lower targets,
- GLB validity and viewer output,
- no silent target fallback.

This is mainly acceptance/benchmark closure; the core controls already exist in the application.

## 3. UV foundation (#7)

Start the next feature milestone with the lowest-risk UV work:

- UV inspection/debug view,
- atlas/template export,
- UV/material metadata,
- stable UV-aware export path.

Detailed roadmap: `docs/roadmap/texture-uv-stylization.md`.

## 4. Direct UV texture import (#7)

Allow a user-painted/reference atlas that matches the exported UV layout to be applied directly to the mesh and exported as GLB.

This creates a deterministic advanced workflow before adding generative styling.

## 5. Texture style controls (#7)

Build style controls on top of the stable UV path:

- Match source,
- Realistic,
- Stylized,
- Hand-painted,
- Cartoon,
- Pixel-art,
- optional style-reference image,
- style strength,
- preserve-source-colors option.

The implementation may initially use a separate 2D UV-atlas stylization pass rather than requiring native style conditioning from Hunyuan Paint.

## 6. Pixel-art-specific texture handling (#7)

Add the technical pieces needed for genuinely crisp pixel-art output:

- low atlas resolutions,
- nearest-neighbor sampling,
- optional palette reduction,
- controlled mip/smoothing behavior,
- predictable texel density.

## 7. UV-aware local texture editing

After UV import/export is proven:

- local texture inpaint,
- mask-based repaint,
- surface-patch projection,
- reference-guided local edits,
- seam-aware cleanup.

Keep this lightweight; a Blender-like full UV editor remains out of scope.

## 8. Later game-asset preparation extras

Resume the deferred Phase B work from `game-ready-mesh-processing.md`:

- ground alignment,
- flatten-bottom option,
- pivot/origin controls,
- automatic LOD generation,
- simple collision mesh/hull output.

These are useful, but currently come after the UV/texturing milestone because the present goal is to make generated assets controllable visually as well as geometrically.

## Current gate

Do not start UV implementation until #6 has a measured real-hardware result and the cleanup hotspot is either fixed or intentionally accepted with documented numbers. The UV work should begin from a stable geometry pipeline, not while topology behavior is still moving.
