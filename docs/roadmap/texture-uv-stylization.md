# UV and texture stylization roadmap

**Status:** active — Phase 1 UV foundation is implemented through the first inspection/export slice and is awaiting real-desktop acceptance.

## Goal

Build a UV-first texturing workflow that gives the user predictable control over texture layout and later allows style-directed texturing without depending only on the uploaded source image.

The UV layer comes first. Style presets and reference-image conditioning should be built on top of a stable atlas/export/import path rather than being mixed directly into the current Hunyuan Paint call before we can inspect or replace the generated texture safely.

## Phase 1 — UV inspection and atlas export

Add explicit UV inspection tools to the existing model workflow:

- show UV availability and atlas metadata for the current GLB/OBJ,
- add a UV debug view in the viewer,
- export a UV atlas/template image with island outlines,
- record atlas resolution, material/texture slots and texel density where possible,
- keep the UV/material mapping stable through cleanup, texture and final GLB export.

### First slice implemented

The current implementation provides:

- a procedural **UV Checker** mode in the Three.js viewer,
- UV mesh/triangle/material/texture counts for the loaded model,
- a **2048x2048 SVG UV template** export,
- light triangle guides plus stronger UV boundary/island outlines,
- embedded `img2model-uv-template-v1` metadata,
- native Tauri file saving with `.svg` and payload validation,
- a browser-development download fallback.

SVG is the first template format because it keeps dense UV outlines crisp at any zoom and is easy to inspect or rasterize externally. A raster PNG template/preview can be added later if it improves the direct-paint workflow; it is not required to validate the UV mapping itself.

### Phase 1 acceptance gate

Before direct texture replacement starts, verify on a real generated textured GLB that:

- UV Checker covers the model and exposes stretching/seams without destabilizing the viewer,
- exported SVG is non-empty and corresponds to the loaded model,
- the normal Solid/Wireframe/Solid + Wire modes still work,
- template export succeeds through the Windows Tauri save dialog.

## Phase 2 — direct UV texture input

Allow a user-supplied image that matches the exported UV atlas to be applied directly to the existing mesh.

Requirements:

- import an atlas-sized image without regenerating geometry,
- rebind/replace the relevant material texture,
- preserve UV coordinates,
- export a valid GLB,
- show the result immediately in the built-in viewer,
- report obvious resolution/aspect mismatches instead of silently stretching the image.

This gives advanced users a deterministic path that does not depend on generative texturing at all.

## Phase 3 — style presets and style reference

Add a texture-style mode to the Texture UI.

Initial presets:

- **Match source** — current behavior; preserve the uploaded image's visual character as much as possible.
- **Realistic** — natural material response/detail.
- **Stylized** — simplified game-art appearance.
- **Hand-painted** — painterly color/value treatment with reduced photographic detail.
- **Cartoon** — broader color regions and stronger graphic separation.
- **Pixel-art** — handled as a dedicated technical preset, not only a textual style hint.

Controls:

- texture style preset,
- optional style reference image,
- style strength,
- preserve source colors toggle,
- atlas/output resolution.

Do not assume Hunyuan Paint natively supports arbitrary style conditioning. The first robust implementation may generate the normal UV-space texture with Hunyuan Paint and then run a separate 2D atlas stylization pass before applying the result back to the mesh. If a future backend supports native source + style conditioning reliably, it can be exposed behind the same UI contract.

## Phase 4 — pixel-art-specific output

Pixel-art requires technical handling beyond an AI style prompt.

The preset should be able to control:

- low atlas resolutions such as 128/256/512 where appropriate,
- nearest-neighbor texture sampling,
- reduced or disabled smoothing/mipmap blur where appropriate,
- optional palette reduction,
- stable texel density,
- optional edge/cluster cleanup after generative stylization.

The objective is crisp game-ready pixel texture output, not a blurred high-resolution texture that merely resembles pixel art.

## Phase 5 — UV-aware texture editing

Once atlas export/import is stable, add lightweight local editing rather than a full Blender-like editor:

- local texture patch/inpaint,
- mask-based repaint,
- surface-patch projection,
- optional reference-guided repaint of selected regions,
- seam-aware postprocessing where needed.

This phase should reuse the same UV/material infrastructure rather than introducing a separate texture representation.

## Pipeline direction

Preferred order:

```text
Shape generation
  -> geometric cleanup
  -> target-triangle / working-mesh preparation
  -> UV validation / atlas preparation
  -> Hunyuan Paint or direct UV texture input
  -> optional style/reference atlas pass
  -> optional UV-aware local edits
  -> final GLB export
```

Topology-changing operations should stay before the final UV-dependent texture stages unless the pipeline explicitly rebakes/remaps textures.

## Acceptance milestones

### UV foundation
- UV layout can be inspected in-app.
- A usable atlas template can be exported.
- The same mesh accepts a user-painted atlas and exports correctly.

### Style controls
- Style preset changes texture appearance without changing mesh geometry.
- Style-reference input is optional and deterministic in the job request.
- `Match source` preserves current behavior.

### Pixel-art
- The viewer and exported GLB preserve crisp nearest-sampled texels.
- Pixel-art output does not receive unintended smoothing that destroys the intended look.

## Tracking

Primary issue: #7 — UV atlas workflow and texture style controls.

Execution order is recorded in `docs/roadmap/current-priorities.md`.

The completed dense-mesh cleanup performance gate is tracked in #6. Remaining polycount-quality coverage stays in #4/#11 as a parallel benchmark lane rather than a blocker for UV work.
