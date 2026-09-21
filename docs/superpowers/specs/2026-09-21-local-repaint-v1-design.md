# Local Repaint v1 design

**Date:** 2026-09-21
**Status:** approved in conversation; ready for written-spec review
**Repository:** `quendae/img2model-amd`
**Branch:** `feat/game-ready-mesh-cleanup`

## Intent

Add lightweight UV-aware local texture editing to Img2Model AMD so a user can paint a mask directly on the 3D model, describe a local change with a prompt and/or reference image, run a local 2D repaint, preview the result immediately on the model, and export the edited textured GLB.

The feature is intended to turn local texture correction into an in-app workflow without turning Img2Model AMD into a full UV or mesh editor.

## Success criteria

Local Repaint v1 is accepted when, on the real Windows/RX 6950 XT path:

- the user can enter Local Repaint mode and paint a mask directly on the visible 3D surface,
- Paint, Erase, Clear and brush-size controls behave predictably,
- the 3D selection maps to the correct UV-space area,
- prompt-only, reference-only, and prompt+reference repaint jobs work,
- only base color/albedo is modified,
- pixels outside the mask plus its explicit feather band remain identical to the source atlas,
- geometry and UV coordinates remain unchanged,
- a second repaint can use the previous repaint result as its input,
- the edited model exports as a valid GLB and preserves the repaint when reopened,
- the flow works from an installed Img2Model AMD build, not only a repository checkout.

## Scope

### Included in v1

- 3D brush-based masking in the existing model viewer,
- adjustable brush size,
- Paint and Erase modes,
- Clear mask,
- translucent mask overlay on the model,
- prompt input,
- optional reference image,
- prompt and reference usable independently or together,
- atlas-space mask rasterization,
- local patch extraction with context padding,
- local 2D inpaint/edit backend,
- feathered compositing back into the atlas,
- live viewer refresh,
- export through the existing textured GLB path,
- persistent local model caching,
- diagnostics and recoverable error handling.

### Explicitly out of scope for v1

- geometry editing,
- UV editing or island transforms,
- normal/roughness/metallic generation,
- layer stacks,
- multiple persistent masks,
- a full 2D atlas editor,
- multi-view reprojection/rebake,
- advanced seam healing beyond bounded feather/compositing,
- a Blender-like manual mesh or texture editor.

## Chosen architecture

Use **atlas-space local repaint driven by a mask painted in 3D**.

The pipeline is:

```text
3D brush hit
  -> raycast triangle hit
  -> barycentric/UV coordinate
  -> UV-space mask rasterization
  -> padded atlas patch extraction
  -> local 2D repaint/edit model
  -> validate edited patch
  -> feathered atlas composite
  -> swap current atlas
  -> viewer refresh
  -> existing GLB export
```

This is preferred over multi-view reprojection because it reuses the existing UV/atlas/export infrastructure, avoids rebaking geometry, keeps changes localized, and is easier to test deterministically.

## Frontend responsibilities

### ModelViewer local repaint mode

The existing `ModelViewer` gains a dedicated Local Repaint state. While active:

- pointer input raycasts against the loaded mesh,
- the hit triangle and barycentric location are converted to UV space,
- brush stamps are accumulated into an atlas-space mask,
- Paint adds coverage,
- Erase subtracts coverage,
- Clear resets the current mask,
- a translucent overlay communicates the selected surface area,
- orbit/navigation and painting must not fight for the same pointer gesture.

The viewer must not mutate mesh geometry or UV attributes while painting.

### UV mask projection

A focused module should own conversion from 3D brush hits to atlas-space mask data. It should expose a testable interface that does not depend on React rendering.

The module is responsible for:

- UV coordinate derivation from a mesh hit,
- brush footprint rasterization into the atlas mask,
- mask bounds calculation,
- coverage statistics,
- stable behavior at UV island boundaries.

The initial implementation may use atlas-pixel-space brush stamps around UV hits, but the output contract is always a deterministic raster mask aligned with the active atlas.

### Patch preparation

From the full atlas and mask, the app derives:

- mask bounding box,
- context padding around the mask,
- source patch,
- mask patch,
- original patch dimensions,
- atlas-space patch rectangle.

The patch sent to inference must include enough surrounding context for the model to understand the local material. A tight mask-only crop is not acceptable.

## Repaint request contract

The request type should be backend-agnostic and carry the behavior the UI needs rather than naming a specific model.

Required fields:

- source patch path or payload,
- mask patch path or payload,
- prompt, optional but required when no reference image is supplied,
- optional reference image,
- target patch dimensions,
- atlas dimensions,
- patch rectangle metadata,
- feather setting,
- request/job identifier.

The request must allow these valid modes:

- prompt only,
- reference only,
- prompt + reference.

A request with neither prompt nor reference image is invalid.

## Worker/backend architecture

Define a repaint adapter contract conceptually equivalent to:

```text
repaint(source_patch, mask, prompt?, reference?, settings) -> edited_patch
```

The application-facing contract must not expose a specific model architecture. This allows the first backend to be replaced later without changing the UI or export flow.

The first real backend should be selected for practical compatibility with the existing Windows Radeon/TheRock runtime and 16 GB VRAM. The first candidate is an SDXL-class inpaint backend with reference guidance such as IP-Adapter. If that backend is not sufficiently stable or efficient on the tested AMD path, a lighter inpaint/edit model may replace it behind the same adapter contract.

## Model acquisition and cache

The local repaint model is not bundled inside the application installer.

On first Local Repaint use:

- the backend checks for a compatible cached model,
- if missing, the application performs an explicit download/setup step,
- the model is stored in the same persistent model/cache strategy used by Img2Model AMD,
- normal application upgrades do not redownload a healthy cached repaint model.

Model acquisition failures must not modify the current atlas.

## Safe atlas update

Inference must never modify the active atlas in place.

Use a transactional flow:

```text
current atlas
  -> temporary source patch
  -> inference result
  -> result validation
  -> composite into a copy of current atlas
  -> swap copy in as current atlas only after success
```

If inference, validation, compositing, or worker communication fails, the previously active atlas remains untouched.

## Compositing rules

The edited patch is applied only through the generated mask plus the explicit feather band.

Requirements:

- outside the mask/feather region, atlas pixels remain pixel-identical to the input atlas,
- the returned patch must match the expected output dimensions after normalization,
- feathering is deterministic,
- the original atlas is preserved until the composite copy has been validated,
- the new atlas becomes the source for any subsequent Local Repaint operation.

## UI flow

Typical user flow:

1. Open a textured model.
2. Enter **Local Repaint**.
3. Choose Paint or Erase and adjust brush size.
4. Paint the target surface area on the 3D model.
5. Enter a prompt and/or choose a reference image.
6. Optionally adjust feather.
7. Press **Apply repaint**.
8. Show staged progress such as:
   - Preparing UV patch,
   - Preparing/downloading local repaint model,
   - Applying local repaint,
   - Compositing atlas.
9. Refresh the material in the viewer after successful compositing.
10. Allow another repaint or normal GLB export.

The first version does not require layer history or a multi-step undo stack.

## Error handling

Return a clear, recoverable error and preserve the existing atlas for:

- no UV coordinates,
- no compatible base-color texture,
- empty mask,
- unusably small mask,
- missing/deleted reference image,
- model download/setup failure,
- out-of-memory error,
- inference failure,
- worker crash,
- invalid returned image,
- returned patch dimension mismatch,
- compositing failure.

On OOM, the worker should release repaint-model/GPU state where practical and expose Retry without requiring a full application restart.

## Diagnostics

Record to the existing diagnostics/logging path:

- repaint backend/model identifier,
- cold vs warm model load,
- model-load time,
- source and inference patch dimensions,
- mask coverage percentage,
- inference time,
- compositing time,
- cache hit/miss,
- OOM/recovery status,
- failure stage.

These fields are diagnostic data, not normal UI clutter.

## Delivery slices

### Slice 1 — 3D brush to UV mask

- Local Repaint mode,
- raycast/UV hit conversion,
- Paint/Erase/Clear,
- brush-size control,
- mask overlay,
- deterministic atlas-space mask output.

No AI backend is involved in this slice.

### Slice 2 — patch extraction and deterministic compositing

- mask bbox,
- context padding,
- source/mask patch extraction,
- deterministic fake/test repaint result,
- feathered composite,
- live atlas replacement.

This slice proves the complete 3D-to-UV-to-atlas round trip before introducing a model dependency.

### Slice 3 — repaint worker contract and persistent model lifecycle

- request/reply protocol,
- backend adapter,
- first-use model acquisition,
- persistent cache,
- cancellation/error recovery,
- diagnostic stages.

### Slice 4 — real prompt/reference repaint

- integrate the selected AMD-compatible local 2D backend,
- prompt-only,
- reference-only,
- prompt+reference,
- cold/warm behavior,
- Radeon hardware test.

### Slice 5 — GLB and installed-app acceptance

- repeated repaint on the latest atlas,
- export edited textured GLB,
- reopen validation,
- installed-build validation on RX 6950 XT.

## Testing strategy

Implementation follows RED -> GREEN.

Automated tests should cover at minimum:

- barycentric/UV hit conversion,
- mask add/erase/clear semantics,
- mask bbox/padding calculations,
- empty-mask rejection,
- request validation for prompt/reference combinations,
- patch dimension validation,
- feathered composite determinism,
- exact preservation of pixels outside mask + feather,
- failed job leaves original atlas unchanged,
- second repaint uses first repaint atlas as source,
- model cache reuse,
- worker error/OOM mapping,
- GLB export continues to use the current edited atlas.

Real hardware acceptance remains required for the AI backend and installed application path.

## Relationship to later work

Future enhancements may add:

- synchronized 2D atlas preview,
- seam-aware cleanup,
- better surface-patch projection,
- richer undo/history,
- PBR map repaint,
- multi-view projection where atlas-space editing is insufficient.

Those extensions should reuse the same mask and repaint request contracts rather than replace the v1 representation.
