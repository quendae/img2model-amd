# Img2Model AMD

A Windows desktop image-to-3D application focused on AMD Radeon GPUs.

The initial hardware target is the **Radeon RX 6950 XT (16 GB, gfx1030)**. The app uses a native Tauri/React desktop UI, Three.js for preview, and an out-of-process persistent Python worker for Hunyuan3D shape generation, game-ready mesh processing, and optional Hunyuan Paint texture generation.

> **Current status:** MVP / experimental. Native ROCm/TheRock Hunyuan shape generation and Hunyuan Paint texture generation are hardware-validated on an RX 6950 XT. `mesh-cleanup-v2` with PyMeshLab repair/remesh plus adaptive QEM game-ready reduction is implemented and CI-validated; real RX 6950 XT quality/performance acceptance is the next checkpoint. See [`docs/status/2026-09-13.md`](docs/status/2026-09-13.md) for the current development status.

## What works

- Windows desktop shell with Tauri 2
- React/TypeScript generation UI
- AMD GPU, WSL and Python diagnostics
- Automatic persistent-worker startup and Shape preload after the GUI opens
- Hunyuan shape and texture capability health checks
- Hunyuan3D-2 Mini image-to-shape worker using the `fp16` Mini weights by default
- Optional Hunyuan Paint mesh + image texture stage
- Conservative `Light` cleanup plus `Game-ready` / `Aggressive` `mesh-cleanup-v2`
- PyMeshLab repair, non-manifold cleanup, hole closing and optional isotropic remesh
- Adaptive QEM reduction driven by normalized symmetric Hausdorff error
- Optional Manifold3D validation/finalization
- Auto triangle budget plus Manual target control for game-ready cleanup
- Cleanup telemetry for reduction, topology, backend and normalized geometry error
- Texture failure preserves the successful untextured shape output
- CPU model offload plus MAX attention slicing as the validated 16 GB texture profile
- PNG/JPG/WEBP input selection
- Fast / Balanced / Quality step presets
- Seed and optional background removal
- GLB and OBJ worker export
- Interactive Three.js GLB and OBJ preview
- Explicit backend policy: **no silent fallback**
- Unit tests for backend selection, job state transitions, preview formats, worker protocol, mesh cleanup and Rust bridge helpers
- CI on Linux plus Windows desktop compilation and PowerShell validation

## Architecture

```text
Tauri desktop app
  ├─ React / TypeScript UI
  ├─ Three.js model viewer
  ├─ Rust diagnostics + persistent process bridge
  │    └─ native-rocm worker
  │         ├─ Hunyuan3D-2 Mini shape
  │         ├─ mesh cleanup
  │         │    ├─ Light: conservative Trimesh path
  │         │    └─ Game-ready/Aggressive: PyMeshLab + adaptive QEM
  │         │         └─ optional Manifold3D validation/finalization
  │         └─ Hunyuan Paint texture (optional)
  │              └─ custom rasterizer via PyTorch ROCm/HIPify
  ├─ wsl-rocm       (planned)
  └─ Vulkan/TRELLIS (planned / experimental)
```

The ML runtime is kept outside the desktop process. A failed model import, texture-extension import, cleanup run, or inference run returns an error rather than terminating the UI. Shape, cleanup and texture are intentionally separate stages so a later failure cannot destroy a valid generated mesh.

## RX 6950 XT / gfx1030 setup on Windows

TheRock publishes Windows ROCm/PyTorch packages for `gfx1030`. This project installs them into an isolated per-user runtime rather than modifying global Python.

### Prerequisites

- Windows 11
- current AMD display driver
- Python **3.11 x64** with the Windows `py` launcher
- Node.js 22+ for development builds
- Rust stable toolchain for development builds
- Microsoft WebView2 Runtime (normally already present on Windows 11)
- For native texture-extension compilation: a usable Windows C++ build toolchain if PyTorch requests it

### Automated runtime setup

From PowerShell in the repository root:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup\windows-native-rocm.ps1
```

The script defaults to AMD's **stable** TheRock wheel index and installs a matching gfx1030 ROCm/PyTorch stack, including the Hunyuan-required ROCm build of `torchvision`, plus the pinned game-ready mesh dependencies.

If the stable stream has a packaging regression or lacks a dependency needed by Hunyuan, try the nightly stream:

```powershell
.\scripts\setup\windows-native-rocm.ps1 -Channel nightly
```

Nightly packages can occasionally have ABI regressions, so stable is preferred when it works.

By default the runtime is created at:

```text
%LOCALAPPDATA%\Img2ModelAMD\runtime\native-rocm\
```

The setup script copies the worker and mesh-processing package into that persistent runtime and saves these per-user environment variables:

```text
IMG2MODEL_PYTHON=%LOCALAPPDATA%\Img2ModelAMD\runtime\native-rocm\Scripts\python.exe
IMG2MODEL_WORKER=%LOCALAPPDATA%\Img2ModelAMD\runtime\native-rocm\worker.py
```

They are also set for the PowerShell process running setup. This lets a packaged desktop app find the AMD runtime without depending on the repository location.

You can override the runtime destination explicitly:

```powershell
.\scripts\setup\windows-native-rocm.ps1 -RuntimeDir "D:\Img2ModelRuntime"
```

To sync the current worker/backend into an existing runtime without reinstalling ROCm/PyTorch/Hunyuan:

```powershell
.\scripts\setup\windows-native-rocm.ps1 -VerifyOnly
```

`-VerifyOnly` also verifies the installed PyMeshLab/Manifold3D dependencies and the Hunyuan/GPU health path.

### RX 6950 XT hardware validation

The native Windows path has been validated on a Radeon RX 6950 XT with:

- PyTorch `2.13.0+rocm10.0.0`
- HIP runtime reported by PyTorch
- the GPU visible through the PyTorch `torch.cuda` compatibility namespace
- approximately 16 GB VRAM detected
- a real 1024×1024 matrix multiplication executed on the Radeon GPU
- Hunyuan3D-2 Mini `fp16` shape generation completed successfully and exported a GLB
- persistent Shape pipeline preload/cache followed by successful Shape inference
- Hunyuan Paint native extensions compiled and imported successfully through TheRock/ROCm
- the official Hunyuan texture working-mesh cleanup/reduction path validated for Paint
- Hunyuan Paint completed a real textured GLB using CPU model offload plus MAX Diffusers attention slicing

Both the shape and texture paths are therefore considered verified on the target card. The texture working-mesh ceiling used by Hunyuan Paint is not a recommended in-game triangle count. `mesh-cleanup-v2` now provides a separate game-ready path intended to reduce simple props into the low-thousands of triangles when the geometric-error tolerance allows it; real RX 6950 XT acceptance of that new path is still pending.

### RX 6950 XT smoke test

After setup, open a fresh PowerShell and run:

```powershell
.\scripts\smoke\windows-native-rocm.ps1
```

This performs a worker health check and a real ROCm tensor operation on the GPU, then prints the detected device, HIP version and VRAM.

To exercise the full image-to-shape path as well:

```powershell
.\scripts\smoke\windows-native-rocm.ps1 `
  -InputImage "C:\path\to\input.png" `
  -Output "C:\path\to\smoke.glb"
```

The end-to-end mode uses Hunyuan3D-2 Mini `fp16`, verifies the process exit code and confirms that a non-empty output file was produced.

## Hunyuan texture setup on Windows AMD

Hunyuan's paint stage uses a native `custom_rasterizer` extension. Upstream defines it as a PyTorch `CUDAExtension`, but ROCm PyTorch can route CUDA extensions through its HIP extension / HIPify path. Img2Model AMD uses that route instead of maintaining a hand-forked rasterizer.

The texture setup **reuses the existing native ROCm runtime**. It does not reinstall PyTorch or ROCm:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup\windows-hunyuan-texture.ps1
```

The script:

1. verifies that the existing PyTorch build reports HIP;
2. resolves TheRock's core and development trees through the installed ROCm SDK tooling;
3. sets `PYTORCH_ROCM_ARCH=gfx1030` plus the required device-library/include paths;
4. downloads pinned Hunyuan3D-2 source into the runtime's texture build directory;
5. builds upstream `custom_rasterizer` through PyTorch's ROCm/HIPify extension path;
6. builds the upstream differentiable-renderer extension;
7. runs a real import-based `texture-health` check.

Texture capability check:

```powershell
& $env:IMG2MODEL_PYTHON $env:IMG2MODEL_WORKER texture-health --json
```

A healthy result requires the Hunyuan texgen package plus successfully importable native rasterizer extensions.

### Manual texture test

With an existing untextured mesh and the original source image:

```powershell
& $env:IMG2MODEL_PYTHON $env:IMG2MODEL_WORKER texture `
  --mesh "$env:USERPROFILE\Desktop\img2model-smoke.glb" `
  --image "C:\tmp\drewno.png" `
  --output "$env:USERPROFILE\Desktop\img2model-smoke-textured.glb" `
  --model "tencent/Hunyuan3D-2" `
  --subfolder "hunyuan3d-paint-v2-0-turbo" `
  --remove-background
```

On the validated RX 6950 XT profile, CPU model offload and `attention-slicing=max` are enabled by default. Advanced users can opt out explicitly with `--no-cpu-offload` and/or `--attention-slicing off` on higher-memory hardware. The default texture preprocessing follows Hunyuan's official Paint preparation path. The original untextured mesh remains untouched if the texture stage fails.

## Game-ready mesh cleanup

`Light` is intentionally conservative and aims to preserve the generated geometry.

`Game-ready` and `Aggressive` use `mesh-cleanup-v2`, which can repair topology and substantially rebuild/reduce the mesh:

- PyMeshLab duplicate/null geometry cleanup;
- non-manifold edge/vertex repair;
- small-component removal;
- hole closing;
- optional isotropic remesh;
- adaptive QEM decimation;
- normalized symmetric Hausdorff error to decide how far Auto mode may reduce;
- optional Manifold3D validation/finalization.

Auto mode is error-driven rather than a universal polycount preset. Manual mode exposes a 500–500000 triangle target in 500-triangle steps and defaults to 5000. For a simple prop such as the current steak test asset, the intended Game-ready range is the low-thousands when fidelity permits.

Current automated coverage is GREEN, but this pipeline still requires real RX 6950 XT quality/performance acceptance before being called hardware-validated.

## Run the desktop app

```powershell
npm install
npm run tauri -- dev
```

Current startup behavior:

1. The Tauri GUI opens.
2. The persistent native worker starts automatically.
3. Runtime health is checked automatically.
4. Hunyuan3D-2 Mini Shape preloads automatically and the header reports startup/loading/ready state.
5. Select an image or switch to Mesh mode for standalone cleanup.
6. Choose output, quality, cleanup preset and optional texture settings.
7. Generate/process the asset.
8. The latest successful model is loaded into the center 3D viewer.

The first shape or texture generation can download several GB of model weights from Hugging Face.

A dedicated splash that appears immediately and keeps the main window hidden until worker/Shape preload completes is designed and planned next; see `docs/superpowers/plans/2026-09-13-startup-splash-preload.md`.

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
  --max-faces 40000 `
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

Production frontend build:

```bash
npm run build
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

Selecting an unavailable backend does **not** cause an automatic switch to another backend. This prevents confusing situations where a generation unexpectedly runs on CPU, WSL or a different runtime.

## Current limitations

- `mesh-cleanup-v2` is implemented and CI-validated, but real RX 6950 XT Game-ready Auto/Manual quality and performance acceptance is still pending.
- The main GUI currently appears before Shape preload completes; a dedicated startup splash / hidden-main preload flow is designed but not yet implemented.
- Hunyuan Paint remains substantially more memory-intensive than Shape and is intentionally lazy-loaded.
- Generation progress is produced by the Python worker, but not every internal third-party operation has granular live progress.
- Cancellation is modeled in the domain state machine but process cancellation is not yet connected to the UI.
- The runtime installer is currently a PowerShell setup script; it is not yet integrated into the desktop UI or MSI/NSIS installer.
- WSL2 and Vulkan/TRELLIS execution are not yet implemented.
- The Hunyuan model/runtime, PyMeshLab and Manifold3D are third-party software with their own license terms. Model weights are not bundled with this repository.

## Why Hunyuan3D-2 Mini first?

Tencent documents the Mini shape pipeline as a 0.6B image-to-shape model. The texture path is substantially more memory-intensive and has native rasterization dependencies, so Img2Model AMD stages geometry and texture separately. On the 16 GB RX 6950 XT, the validated texture profile combines CPU model offload with maximum attention slicing.

## References

- TheRock: https://github.com/ROCm/TheRock
- TheRock releases/install guide: https://github.com/ROCm/TheRock/blob/main/RELEASES.md
- TheRock GPU status: https://github.com/ROCm/TheRock/blob/main/SUPPORTED_GPUS.md
- Hunyuan3D-2: https://github.com/Tencent-Hunyuan/Hunyuan3D-2
- Hunyuan3D-2 Mini weights: https://huggingface.co/tencent/Hunyuan3D-2mini
- PyMeshLab: https://pymeshlab.readthedocs.io/
- Manifold3D: https://github.com/elalish/manifold

## Roadmap

1. Native ROCm Hunyuan shape generation — **validated on RX 6950 XT**
2. Native ROCm/HIP Hunyuan Paint rasterizer + textured GLB — **validated on RX 6950 XT**
3. `mesh-cleanup-v2` Game-ready repair/remesh + adaptive QEM — **implemented and CI-validated; RX 6950 XT acceptance pending**
4. Startup splash + hidden-main worker/Shape preload
5. Optional quality-first low-poly baking pipeline if direct low-poly Paint needs more fidelity
6. Runtime/model installer inside the UI
7. Live progress + cancellation
8. WSL2 ROCm worker
9. Experimental TRELLIS / Vulkan or ROCm backend
10. Packaged Windows installer and releases

Current checkpoint: [`docs/status/2026-09-13.md`](docs/status/2026-09-13.md).

See also `docs/superpowers/specs/2026-09-13-game-ready-remesh-startup-design.md`, `docs/superpowers/plans/2026-09-13-game-ready-remesh.md`, and `docs/superpowers/plans/2026-09-13-startup-splash-preload.md`.
