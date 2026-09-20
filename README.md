# Img2Model AMD

A Windows desktop image-to-3D application focused on AMD Radeon GPUs.

The initial hardware target is the **Radeon RX 6950 XT (16 GB, gfx1030)**. The app uses a native Tauri/React desktop UI, Three.js for preview, and an out-of-process persistent Python worker for Hunyuan3D shape generation, game-ready mesh processing, and optional Hunyuan Paint texture generation.

> **Current status:** MVP / experimental. Native ROCm/TheRock Hunyuan shape generation, mesh cleanup, Hunyuan Paint texture generation, direct UV atlas replacement, UV transform controls, and texture style post-processing are hardware-validated on an RX 6950 XT. A Tauri/NSIS Windows installer is now built in CI; real-machine packaged-installer acceptance is the active gate. See [`docs/roadmap/current-priorities.md`](docs/roadmap/current-priorities.md).

## What works

- Windows desktop shell with Tauri 2
- React/TypeScript generation UI
- AMD GPU, WSL and Python diagnostics
- Automatic persistent-worker startup and Shape preload after the GUI opens
- Hunyuan shape and texture capability health checks
- Hunyuan3D-2 Mini image-to-shape worker using the `fp16` Mini weights by default
- Optional Hunyuan Paint mesh + image texture stage
- Conservative `Light` cleanup plus `Game-ready` / `Aggressive` mesh cleanup
- PyMeshLab repair, non-manifold cleanup, hole closing and adaptive QEM reduction
- Optional Manifold3D validation/finalization
- Auto/manual triangle targets plus texture-oriented 500 / 1k / 2.5k / 5k / 10k / 40k presets
- Cleanup and timing telemetry
- Texture failure preserves the successful untextured shape output
- CPU model offload plus MAX attention slicing as the validated 16 GB texture profile
- UV Checker, UV metadata and exportable 2048×2048 SVG UV template
- Direct PNG/JPG/WEBP UV atlas import and live material rebind
- Centered UV texture scale/rotation and textured GLB export
- Texture styles: Match source, Realistic, Stylized, Hand-painted, Cartoon and Pixel-art
- Style strength, preserve-source-colors and optional reference-palette guidance
- PNG/JPG/WEBP input selection
- Fast / Balanced / Quality shape presets
- Seed and optional background removal
- GLB and OBJ worker export
- Interactive Three.js GLB and OBJ preview
- Explicit backend policy: **no silent fallback**
- Tauri/NSIS Windows setup build with bundled version-matched runtime bootstrap sources
- CI on Linux plus Windows desktop compilation, PowerShell validation and NSIS packaging

## Architecture

```text
Tauri desktop app
  ├─ React / TypeScript UI
  ├─ Three.js model viewer + UV atlas workflow
  ├─ Rust diagnostics + persistent process bridge
  │    └─ native-rocm worker
  │         ├─ Hunyuan3D-2 Mini shape
  │         ├─ mesh cleanup
  │         │    ├─ Light: conservative Trimesh path
  │         │    └─ Game-ready/Aggressive: PyMeshLab + adaptive QEM
  │         │         └─ optional Manifold3D validation/finalization
  │         └─ Hunyuan Paint texture
  │              ├─ custom rasterizer via PyTorch ROCm/HIPify
  │              └─ 2D atlas style post-processing
  ├─ wsl-rocm       (planned)
  └─ Vulkan/TRELLIS (planned / experimental)
```

The ML runtime is kept outside the desktop process. A failed model import, texture-extension import, cleanup run, or inference run returns an error rather than terminating the UI. Shape, cleanup and texture are separate stages so a later failure cannot destroy a valid generated mesh.

## Windows installer

Img2Model AMD now has a Tauri v2 **NSIS** packaging path. GitHub Actions builds a `*-setup.exe` artifact using `.github/workflows/windows-installer.yml`.

The setup is intentionally split into the small desktop application and a persistent per-user Radeon/ML runtime:

```text
Application: normal Tauri current-user install directory
Runtime:     %LOCALAPPDATA%\Img2ModelAMD\runtime\native-rocm\
Logs:        %LOCALAPPDATA%\Img2ModelAMD\logs\
```

Model weights are **not embedded in the installer**. Hugging Face/model caches remain outside the application installation and are preserved across app upgrades and uninstall. A healthy existing Img2Model AMD runtime is reused during upgrades: the installer refreshes the version-matched worker/backend sources, rechecks Shape/Texture health, and avoids reinstalling ROCm/Hunyuan. An unhealthy runtime follows the repair/install path.

### Fresh-machine prerequisites for the first installer slice

- Windows 11
- current AMD display driver
- Python **3.11 x64** with the Windows `py.exe` launcher
- Microsoft Visual Studio 2022 Build Tools with the **Desktop development with C++** workload
- Microsoft WebView2 Runtime (normally present on Windows 11)

The first packaged slice reports missing prerequisites explicitly rather than silently invoking a package manager. Automatic acquisition of Python/C++ prerequisites is a possible follow-up after the packaged path is accepted on real hardware.

The runtime bootstrap log is kept at:

```text
%LOCALAPPDATA%\Img2ModelAMD\logs\installer-runtime.log
```

Installer design and acceptance criteria: [`docs/roadmap/windows-installer.md`](docs/roadmap/windows-installer.md).

### Build the NSIS setup locally

From a Windows development checkout:

```powershell
npm install
npm --workspace @img2model/desktop run prepare-installer
cd apps\desktop
npx tauri build --bundles nsis
```

The generated setup is placed under:

```text
apps\desktop\src-tauri\target\release\bundle\nsis\
```

## RX 6950 XT / gfx1030 development runtime setup

TheRock publishes Windows ROCm/PyTorch packages for `gfx1030`. Repository development uses an isolated per-user runtime rather than modifying global Python.

From PowerShell in the repository root:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup\windows-native-rocm.ps1
```

The script defaults to AMD's **stable** TheRock wheel index and installs a matching gfx1030 ROCm/PyTorch stack, including the Hunyuan-required ROCm build of `torchvision`, plus the pinned game-ready mesh dependencies.

If the stable stream has a packaging regression or lacks a dependency needed by Hunyuan, try:

```powershell
.\scripts\setup\windows-native-rocm.ps1 -Channel nightly
```

By default the runtime is created at `%LOCALAPPDATA%\Img2ModelAMD\runtime\native-rocm\` and persists these user variables:

```text
IMG2MODEL_PYTHON=%LOCALAPPDATA%\Img2ModelAMD\runtime\native-rocm\Scripts\python.exe
IMG2MODEL_WORKER=%LOCALAPPDATA%\Img2ModelAMD\runtime\native-rocm\worker.py
```

You can override the runtime destination explicitly:

```powershell
.\scripts\setup\windows-native-rocm.ps1 -RuntimeDir "D:\Img2ModelRuntime"
```

To sync the current worker/backend into an existing runtime without reinstalling ROCm/PyTorch/Hunyuan:

```powershell
.\scripts\setup\windows-native-rocm.ps1 -VerifyOnly
```

### Hunyuan texture extensions

The texture setup reuses the existing native ROCm runtime and builds the upstream rasterizer/differentiable-renderer extensions through PyTorch's HIPify route:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup\windows-hunyuan-texture.ps1
```

It verifies ROCm PyTorch, initializes TheRock's development tree, targets `gfx1030`, builds the native extensions and finishes with an import-based `texture-health` check.

Texture capability check:

```powershell
& $env:IMG2MODEL_PYTHON $env:IMG2MODEL_WORKER texture-health --json
```

### RX 6950 XT hardware validation

The native Windows path has been validated on a Radeon RX 6950 XT with:

- PyTorch `2.13.0+rocm10.0.0`
- HIP runtime reported by PyTorch and the GPU visible through `torch.cuda`
- approximately 16 GB VRAM detected
- a real GPU tensor/matrix operation
- Hunyuan3D-2 Mini `fp16` shape generation and GLB export
- persistent Shape preload/cache
- Hunyuan Paint native extensions compiled/imported through TheRock/ROCm
- Hunyuan Paint textured GLB using CPU model offload plus MAX attention slicing
- game-ready cleanup and a real 10k texture target run
- direct UV atlas import/rebind, UV scale/rotation and GLB export/reopen
- real texture-style post-processing after Hunyuan Paint

The **packaged NSIS installer itself** still requires its separate real-machine acceptance gate before issue #14 can be closed.

### RX 6950 XT smoke test

After repository setup, open a fresh PowerShell and run:

```powershell
.\scripts\smoke\windows-native-rocm.ps1
```

To exercise full image-to-shape generation:

```powershell
.\scripts\smoke\windows-native-rocm.ps1 `
  -InputImage "C:\path\to\input.png" `
  -Output "C:\path\to\smoke.glb"
```

## Game-ready mesh cleanup

`Light` is intentionally conservative and aims to preserve generated geometry. `Game-ready` and `Aggressive` add topology repair and adaptive QEM reduction using PyMeshLab, with optional Manifold3D validation/finalization.

The representative dense wood-stack asset was accepted on RX 6950 XT: about 1.86M source triangles were repaired to watertight topology and the end-to-end 10k texture-target path produced a valid textured GLB. The remaining 500 / 1k / 2.5k / 5k / 40k matrix remains optional benchmark coverage rather than a blocker.

## Run the desktop app from source

```powershell
npm install
npm run tauri -- dev
```

Current startup behavior:

1. the Tauri GUI opens;
2. the persistent native worker starts automatically;
3. runtime health is checked;
4. Hunyuan3D-2 Mini Shape preloads;
5. select an image or existing mesh;
6. choose Shape / Texture / Mesh settings;
7. generate/process the asset;
8. the latest successful model loads in the 3D viewer.

The first model use can download several GB of weights from Hugging Face.

## Worker CLI

After running setup, start a fresh PowerShell and use the persisted runtime variables:

```powershell
& $env:IMG2MODEL_PYTHON $env:IMG2MODEL_WORKER health --json
```

Shape generation:

```powershell
& $env:IMG2MODEL_PYTHON $env:IMG2MODEL_WORKER generate `
  --input .\input.png `
  --output .\outputs\model.glb `
  --model tencent/Hunyuan3D-2mini `
  --subfolder hunyuan3d-dit-v2-mini `
  --variant fp16 `
  --steps 30 `
  --seed 1234 `
  --remove-background
```

Texture generation:

```powershell
& $env:IMG2MODEL_PYTHON $env:IMG2MODEL_WORKER texture `
  --mesh .\outputs\model.glb `
  --image .\input.png `
  --output .\outputs\model-textured.glb `
  --max-faces 10000 `
  --style-preset stylized `
  --style-strength 0.75 `
  --remove-background
```

The persistent worker emits newline-delimited JSON protocol events. Hunyuan's own terminal progress bar is disabled inside the persistent Shape path because its `tqdm` output is not compatible with the Tauri worker stdout protocol on Windows.

## Development

Frontend in browser-only mode:

```bash
npm install
npm run dev
```

Browser-only mode uses synthetic diagnostics and does not execute inference.

Tests:

```bash
npm test -- --run
python -m unittest discover -s backends/hunyuan/tests -v
python -m unittest discover -s backends/mesh_processing/tests -v
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
```

Windows Tauri compile check:

```powershell
cargo check --manifest-path apps\desktop\src-tauri\Cargo.toml
```

## Backend policy

Backends are deliberately explicit:

- `native-rocm` — implemented and shape/texture-validated on RX 6950 XT
- `wsl-rocm` — planned
- `vulkan` — planned / experimental

Selecting an unavailable backend does **not** cause an automatic switch to another backend.

## Current limitations

- The NSIS package is CI-built but still awaiting real installed-app/runtime acceptance on the RX 6950 XT machine.
- Fresh-machine installer bootstrap currently requires Python 3.11 x64 and Visual Studio 2022 C++ Build Tools to already be installed.
- Hunyuan Paint is substantially more memory-intensive than Shape and is intentionally lazy-loaded.
- Generation progress is worker-driven, but not every internal third-party operation exposes granular live progress.
- Cancellation is modeled but process cancellation is not yet connected to the UI.
- WSL2 and Vulkan/TRELLIS execution are not yet implemented.
- Hunyuan, TheRock/ROCm, PyMeshLab and Manifold3D are third-party software with their own license terms. Model weights are not bundled.

## References

- TheRock: https://github.com/ROCm/TheRock
- TheRock releases/install guide: https://github.com/ROCm/TheRock/blob/main/RELEASES.md
- TheRock GPU status: https://github.com/ROCm/TheRock/blob/main/SUPPORTED_GPUS.md
- Hunyuan3D-2: https://github.com/Tencent-Hunyuan/Hunyuan3D-2
- Hunyuan3D-2 Mini weights: https://huggingface.co/tencent/Hunyuan3D-2mini
- PyMeshLab: https://pymeshlab.readthedocs.io/
- Manifold3D: https://github.com/elalish/manifold

## Roadmap

1. Native ROCm Hunyuan Shape — **validated on RX 6950 XT**
2. Native ROCm/HIP Hunyuan Paint — **validated on RX 6950 XT**
3. Game-ready cleanup + texture target controls — **hardware-accepted core path**
4. UV foundation + direct atlas replacement + UV transform — **hardware-accepted**
5. Texture style controls — **hardware-accepted**
6. Windows NSIS installer + persistent runtime bootstrap — **CI package built; hardware acceptance active**
7. Pixel-art/texel-density refinements
8. UV-aware local texture editing
9. Later game-asset extras: ground/pivot/LOD/collision
10. WSL2 ROCm and experimental Vulkan/TRELLIS backends

Current execution order: [`docs/roadmap/current-priorities.md`](docs/roadmap/current-priorities.md).
