# Game-Ready Polycount Controls Plan

**Goal:** Let users produce substantially lighter textured assets for games without confusing Hunyuan Paint's 40k working limit with a sensible in-game triangle budget.

## Product model

For the first game-ready implementation, reduce **before** Hunyuan Paint and texture the actual target mesh. This avoids a fragile post-texture decimation step that could invalidate UVs or materials. A later quality-first mode may paint a denser working mesh and bake onto a separate low-poly mesh, but that is intentionally outside the first implementation.

The existing worker `--max-faces` setting already controls the triangle count handed to Hunyuan Paint, so the next milestone primarily exposes that capability cleanly in the desktop UI and adds presets.

## UI

Add a `Target triangles` control when texture generation is enabled.

Presets:

- **Mobile:** 500 triangles
- **Low:** 1,000 triangles
- **Medium:** 2,500 triangles
- **High:** 5,000 triangles
- **Hero:** 10,000 triangles
- **Quality / working max:** 40,000 triangles
- **Custom:** stepped/logarithmic slider from 300 to 40,000 plus numeric input

The UI should explain that lower values improve runtime performance and asset size but can visibly simplify silhouettes. `40k` is the Hunyuan working ceiling, not a recommended game default.

## Worker/API

- Keep `--max-faces` for backwards compatibility.
- Surface the selected target triangle count through the Tauri request model.
- Report `faces_before` and `faces_after` in the result summary.
- Reject values below a small safety floor (proposed 100) or above 40,000 in the GUI; the CLI may remain more permissive for advanced testing.
- Do not silently change the user's requested target.

## Desktop work

- Add polycount preset + slider/numeric input to `GenerationPanel`.
- Pass the selected value through `TextureRequest` to Rust and then `--max-faces` to the worker.
- Persist the current selection in the app session.
- Display final triangle count next to the generated textured asset.

## Validation matrix

Test the same source asset at 500, 1k, 2.5k, 5k, 10k, and 40k triangles. Record:

- silhouette quality,
- texture quality/seams,
- GLB size,
- texture runtime,
- peak VRAM if available.

Repeat on at least one simple hard-surface prop, one irregular prop, and one organic object before deciding the final default preset.

## Future follow-up: quality-first baking

If direct low-poly Paint loses too much detail at game budgets, add a separate advanced pipeline:

1. texture a denser working mesh,
2. generate/unwrap a low-poly target,
3. bake base color (and later normal/AO if supported) from working mesh to target,
4. export the low-poly GLB with baked maps.

This requires UV-safe remeshing/baking and must be treated as a separate feature rather than hidden inside simple decimation.

## Acceptance criteria

- User can choose 300-40,000 target triangles from the GUI.
- Presets are one click and clearly named.
- Selected target reaches the worker without silent fallback.
- Textured output reports the actual final triangle count.
- Existing 40k validated RX 6950 XT path remains available as the Quality preset.
