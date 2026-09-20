# UV and texture stylization roadmap

**Status:** active — Phase 1 and Phase 2 are accepted on the real Windows/Radeon desktop path. Phase 3 has started with basic UV texture scale/rotation controls before generative style presets.

## Goal

Build a UV-first texturing workflow that gives the user predictable control over texture layout and later allows style-directed texturing without depending only on the uploaded source image.

The UV layer comes first. Style presets and reference-image conditioning are built on top of a stable atlas/export/import path rather than being mixed directly into the Hunyuan Paint call before the generated texture can be inspected or replaced safely.

## Phase 1 — UV inspection and atlas export — accepted

Implemented and hardware-accepted:

- procedural **UV Checker** mode in the Three.js viewer,
- UV mesh/triangle/material/texture counts for the loaded model,
- **2048x2048 SVG UV template** export,
- light triangle guides plus stronger UV boundary/island outlines,
- embedded `img2model-uv-template-v1` metadata,
- native Tauri file saving with `.svg` and payload validation,
- browser-development download fallback,
- normal Solid/Wireframe/Solid + Wire modes remain available.

SVG remains the canonical editable template because it keeps dense UV outlines crisp at any zoom and is easy to rasterize externally.

## Phase 2 — direct UV texture input — accepted

Implemented and hardware-accepted:

- import a user-supplied square PNG/JPG/WEBP atlas without regenerating geometry,
- validate obvious atlas size/aspect mismatches,
- rebind the atlas to compatible materials immediately in the built-in viewer,
- preserve mesh geometry and UV coordinates,
- export the result as a valid textured GLB through the native Tauri save path,
- reopen/export acceptance confirmed on the Windows desktop path.

This is the deterministic advanced-user route: export template, edit it externally if needed, re-import, preview, and export GLB without another Shape or Hunyuan Paint run.

## Phase 3 — UV transform and style controls — active

### Slice A — basic UV transform

Keep this deliberately small rather than turning Img2Model into a UV editor:

- **Scale:** 50–200%, centered, live preview,
- **Rotation:** -180° to +180°, centered, live preview,
- **Reset:** 100% / 0°,
- no X/Y translation, island editing, masks, distortion tools or per-island transforms,
- a new imported atlas resets the transform to defaults,
- GLB export preserves the visible scale/rotation mapping.

The transform is encoded as export-friendly texture offset/scale/rotation rather than relying on Three.js' non-portable texture `center` property. This keeps the centered preview compatible with the standard glTF texture-transform representation and does not modify mesh UV coordinates.

### Slice B — style presets

Initial presets:

- **Match source** — current behavior; preserve the uploaded image's visual character as much as possible.
- **Realistic** — natural material response/detail.
- **Stylized** — simplified game-art appearance.
- **Hand-painted** — painterly color/value treatment with reduced photographic detail.
- **Cartoon** — broader color regions and stronger graphic separation.
- **Pixel-art** — exposed here as a style choice, with its technical sampling/output behavior implemented in Phase 4.

Controls after the UV-transform slice:

- texture style preset,
- style strength,
- optional style reference image,
- preserve source colors toggle,
- atlas/output resolution.

Do not assume Hunyuan Paint natively supports arbitrary style conditioning. The first robust implementation may generate the normal UV-space texture with Hunyuan Paint and then run a separate 2D atlas stylization pass before applying it back to the mesh. If a future backend supports native source + style conditioning reliably, it can be exposed behind the same UI contract.

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

Once the atlas and style paths are stable, add lightweight local editing rather than a full Blender-like editor:

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
  -> optional basic UV transform
  -> optional style/reference atlas pass
  -> optional UV-aware local edits
  -> final GLB export
```

Topology-changing operations should stay before the final UV-dependent texture stages unless the pipeline explicitly rebakes/remaps textures.

## Acceptance milestones

### UV foundation — complete
- UV layout can be inspected in-app.
- A usable atlas template can be exported.
- The same mesh accepts a user-painted atlas and exports correctly.

### UV transform
- Scale and rotation update immediately without changing geometry or UV attributes.
- Reset restores 100% / 0°.
- Exported GLB reproduces the same mapping when reopened.

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
