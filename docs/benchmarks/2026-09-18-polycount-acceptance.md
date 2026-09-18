# RX 6950 XT polycount acceptance — 2026-09-18

Parent issue: #4
Acceptance tracker: #11

## Purpose

Validate that the game-oriented texture targets are honored by the full Windows native ROCm pipeline and identify the lowest target that preserves acceptable silhouette and texture quality for representative asset classes.

The implementation is already expected to preserve explicit targets through UI -> React job -> Tauri/Rust -> persistent Python worker -> Hunyuan Paint. This run is hardware/quality acceptance, not a request to add another reduction path.

## Hardware / build

- GPU: AMD Radeon RX 6950 XT 16 GB
- Backend: Native ROCm / TheRock
- Shape: Hunyuan3D 2 Mini
- Texture: Hunyuan Paint
- Branch: `feat/game-ready-mesh-cleanup`
- Build/HEAD: rolling branch build; exact cleanup build captured in issue #6

## Test rules

For each asset, use the same source image, generated shape, cleanup preset, seed, texture profile and background-removal setting for every target. Change only **Texture target**.

When possible, reuse the same generated/cleaned mesh and run standalone Texture jobs so Shape/cleanup variation does not contaminate the comparison.

Targets:

- Mobile — 500
- Low — 1,000
- Medium — 2,500
- High — 5,000
- Hero — 10,000
- Quality — 40,000

Record the values shown in Activity after each successful run.

## Asset A — irregular / stylized wood stack

Source: current `drewno.png` regression image.
Cleanup: Light unless otherwise noted.

| Target | Final triangles | Texture time | Total texture job | GLB size | Silhouette | Texture detail | Artifacts / seams | Result |
| ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| 500 |  |  |  |  |  |  |  |  |
| 1,000 |  |  |  |  |  |  |  |  |
| 2,500 |  |  |  |  |  |  |  |  |
| 5,000 |  |  |  |  |  |  |  |  |
| 10,000 | 10,000 | 1:32 | full pipeline 5:51 | 2.42 MiB | visually preserved in built-in viewer | source-like wood texture retained | no blocking artifact observed in supplied run | PASS |
| 40,000 |  |  |  |  |  |  |  |  |

Observed full-pipeline context for the 10k run: Shape 2:26, Light cleanup 1:53, Texture 1:32. The cleaned working mesh was 1,861,966 triangles before the texture target reduction. Activity reported `Watertight: No -> Yes`, `Manifold: No -> Yes`, pre-repair 434 boundary edges, 143 holes closed, and no remesh.

## Asset B — organic / steak regression asset

Use the existing steak example kept for mesh-cleanup regression.

| Target | Final triangles | Texture time | Total texture job | GLB size | Silhouette | Texture detail | Artifacts / seams | Result |
| ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| 500 |  |  |  |  |  |  |  |  |
| 1,000 |  |  |  |  |  |  |  |  |
| 2,500 |  |  |  |  |  |  |  |  |
| 5,000 |  |  |  |  |  |  |  |  |
| 10,000 |  |  |  |  |  |  |  |  |
| 40,000 |  |  |  |  |  |  |  |  |

## Asset C — hard-surface

Choose one clearly mechanical / boxy source with straight edges so silhouette collapse is easy to spot.

| Target | Final triangles | Texture time | Total texture job | GLB size | Silhouette | Texture detail | Artifacts / seams | Result |
| ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| 500 |  |  |  |  |  |  |  |  |
| 1,000 |  |  |  |  |  |  |  |  |
| 2,500 |  |  |  |  |  |  |  |  |
| 5,000 |  |  |  |  |  |  |  |  |
| 10,000 |  |  |  |  |  |  |  |  |
| 40,000 |  |  |  |  |  |  |  |  |

## Acceptance checks

For every row:

- requested target is preserved exactly in the job request;
- final triangle count is at or below the requested ceiling, allowing the reducer to return fewer faces when necessary;
- the exported GLB opens in the built-in viewer;
- material/texture remain attached after reduction;
- no target is silently replaced by the texture profile maximum;
- Safe retry preserves the explicitly selected target.

## Decision after measurements

Do not pick one universal target in advance. Use the measurements to decide whether presets should stay global or later become asset-class recommendations.

If direct 500–2,500 triangle Hunyuan Paint results lose too much texture or UV quality, the next architecture candidate is the already-recorded quality-first path:

`dense textured working mesh -> low-poly target -> UV/bake -> game-ready GLB`

That path should only be implemented if this acceptance matrix demonstrates a real quality gap.
