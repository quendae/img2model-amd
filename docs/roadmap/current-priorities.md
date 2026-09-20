# Current development priorities

Updated: 2026-09-20

This file records the current execution order. Detailed implementation notes remain in the linked issues and roadmap documents.

## Completed gates

### Dense Light cleanup performance (#6)

RX 6950 XT acceptance on the representative ~1.86M-triangle wood-stack asset:

- cleanup: 45s -> 16s,
- winding repair: 23s -> 3s,
- watertight: No -> Yes,
- manifold: Yes -> Yes,
- boundary edges: 434 -> 0,
- 143 small holes closed,
- no remesh.

### UV foundation and direct atlas workflow (#7)

Hardware-accepted on the Windows/RX 6950 XT desktop path:

- UV Checker and UV metadata,
- exportable 2048x2048 SVG UV template,
- direct PNG/JPG/WEBP atlas import,
- live material rebind without geometry regeneration,
- centered UV texture scale and rotation,
- valid textured GLB export/reopen.

### Texture style controls (#7)

Hardware-accepted with real Hunyuan Paint output:

- Match source,
- Realistic,
- Stylized,
- Hand-painted,
- Cartoon,
- Pixel-art,
- style strength,
- preserve-source-colors,
- optional style-reference palette guidance,
- pixel-art nearest-neighbor/mipmap handling.

Detailed texture roadmap: `docs/roadmap/texture-uv-stylization.md`.

## 1. Windows installer and persistent Radeon runtime (#14) — active

Build a normal **Img2Model AMD** Windows setup executable around the validated native Radeon runtime.

Current installer slice:

- Tauri v2 NSIS setup, current-user install,
- version-matched worker/backend/setup payload embedded with the app,
- persistent runtime under `%LOCALAPPDATA%\Img2ModelAMD\runtime\native-rocm`,
- persistent installer/runtime logs under `%LOCALAPPDATA%\Img2ModelAMD\logs`,
- model/Hugging Face caches kept outside the installer and preserved across updates,
- healthy existing runtime reuse instead of blindly reinstalling ROCm/Hunyuan,
- explicit repair path for unhealthy runtimes,
- Shape + Texture health verification after setup,
- installer artifact built by GitHub Actions.

First-slice prerequisites for a fresh machine remain explicit: Python 3.11 x64 with the Windows launcher and Visual Studio 2022 C++ Build Tools. Automatic acquisition of those prerequisites can be considered after the packaged path is hardware-accepted; there is no silent package-manager fallback.

Detailed spec: `docs/roadmap/windows-installer.md`.
Implementation plan: `docs/superpowers/plans/2026-09-20-windows-installer.md`.

### Installer acceptance gate

On the RX 6950 XT Windows machine:

1. run the generated NSIS setup artifact without using a repository checkout,
2. confirm app + runtime setup completes,
3. launch the installed Img2Model AMD and confirm Shape/Texture diagnostics are green,
4. generate or retexture a model, including a non-`Match source` style,
5. install a newer setup over the existing app and confirm runtime/model caches are preserved and the healthy-runtime fast path is used.

Do not close #14 before this real-machine gate passes.

## 2. Pixel-art-specific texture refinement (#7)

After installer acceptance, continue the optional technical improvements for intentionally low-resolution game textures:

- explicit low atlas resolutions,
- predictable texel density,
- additional palette controls,
- controlled mip/smoothing behavior.

The existing Pixel-art preset already performs palette/resolution stylization and uses nearest-neighbor sampling; this milestone is refinement rather than first functionality.

## 3. UV-aware local texture editing

- local texture inpaint,
- mask-based repaint,
- surface-patch projection,
- reference-guided local edits,
- seam-aware cleanup.

Keep this lightweight; a Blender-like full UV editor remains out of scope.

## 4. Later game-asset preparation extras

Resume the deferred Phase B work from `game-ready-mesh-processing.md`:

- ground alignment,
- flatten-bottom option,
- pivot/origin controls,
- automatic LOD generation,
- simple collision mesh/hull output.

## Parallel benchmark lane — #4 / #11

The game-oriented texture-target controls and target propagation are implemented. A real end-to-end 10k run is accepted on RX 6950 XT: the ~1.86M source reaches exactly 10,000 triangles, textures successfully, exports a 2.42 MiB GLB and loads in the built-in viewer.

The remaining 500 / 1k / 2.5k / 5k / 40k matrix stays open in #11 as quality/benchmark coverage. It is useful evidence, but it no longer blocks the installer milestone.
