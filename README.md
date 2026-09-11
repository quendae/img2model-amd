# Img2Model AMD

A Windows desktop image-to-3D application focused on AMD Radeon GPUs.

The initial hardware target is the **Radeon RX 6950 XT (16 GB, gfx1030)**. The app uses a native Tauri/React desktop UI, Three.js for preview, and an out-of-process Python worker for Hunyuan3D shape generation.

> **Current status:** MVP / experimental. Native ROCm/TheRock generation is the first executable backend. WSL2 ROCm and Vulkan/TRELLIS are represented in the architecture but intentionally disabled until their execution paths are implemented and tested.

## What works in the MVP

- Windows desktop shell with Tauri 2
- React/TypeScript generation UI
- AMD GPU, WSL and Python diagnostics
- Hunyuan runtime health check
- Hunyuan3D-2 Mini image-to-shape worker using the `fp16` Mini weights by default
- PNG/JPG/WEBP input selection
- Fast / Balanced / Quality step presets
- Seed and optional background removal
- GLB and OBJ worker export
- Interactive Three.js GLB and OBJ preview
- Explicit backend policy: **no silent fallback**
- Unit tests for backend selection, job state transitions, preview formats, worker protocol and Rust bridge helpers
- CI on Linux plus Windows desktop compilation

## Architecture

```text
Tauri desktop app
  ├─ React / TypeScript UI
  ├─ Three.js model viewer
  ├─ Rust diagnostics + process bridge
  │    └─ native-rocm worker
  │         └─ Python + ROCm PyTorch + Hunyuan3D
  ├─ wsl-rocm       (planned)
  └─ Vulkan/TRELLIS (planned / experimental)
```

The ML runtime is kept outside the desktop process. A failed model import or inference run should therefore return an error rather than terminate the UI.

## RX 6950 XT / gfx1030 setup on Windows

TheRock now publishes Windows ROCm/PyTorch packages for `gfx1030`. This project installs them into an isolated per-user runtime rather than modifying global Python.

### Prerequisites

- Windows 11
- current AMD display driver
- Python **3.11 x64** with the Windows `py` launcher
- Node.js 22+ for development builds
- Rust stable toolchain for development builds
- Microsoft WebView2 Runtime (normally already present on Windows 11)

### Automated runtime setup

From PowerShell in the repository root:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup\windows-native-rocm.ps1
```

The script defaults to AMD's **stable** TheRock wheel index and installs:

- `rocm[libraries,devel,device-gfx1030]`
- `torch[device-gfx1030]`
- Hunyuan3D-2 and worker dependencies

If the stable stream has a packaging regression or lacks a dependency needed by Hunyuan, try the nightly stream:

```powershell
.\scripts\setup\windows-native-rocm.ps1 -Channel nightly
```

Nightly packages can occasionally have ABI regressions, so stable is preferred when it works.

By default the runtime is created at:

```text
%LOCALAPPDATA%\Img2ModelAMD\runtime\native-rocm\
```

The setup script copies `worker.py` into that persistent runtime and saves these per-user environment variables:

```text
IMG2MODEL_PYTHON=%LOCALAPPDATA%\Img2ModelAMD\runtime\native-rocm\Scripts\python.exe
IMG2MODEL_WORKER=%LOCALAPPDATA%\Img2ModelAMD\runtime\native-rocm\worker.py
```

They are also set for the PowerShell process running setup. This lets a packaged desktop app find the AMD runtime without depending on the repository location.

You can override the runtime destination explicitly:

```powershell
.\scripts\setup\windows-native-rocm.ps1 -RuntimeDir "D:\Img2ModelRuntime"
```

## Run the desktop app

```powershell
npm install
npm run tauri -- dev
```

Then:

1. Open **Runtime** and run the Hunyuan health check.
2. Select an image.
3. Keep **Native ROCm / TheRock** selected.
4. Choose a quality profile, seed and background-removal setting.
5. Click **Generate shape** and select a `.glb` or `.obj` output path.
6. The generated model is loaded into the center 3D viewer.

The first generation can download several GB of Hunyuan model weights from Hugging Face.

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

The worker emits newline-delimited JSON progress events and finishes with either a `completed` or `error` event.

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

- `native-rocm` — implemented in the current vertical slice
- `wsl-rocm` — planned
- `vulkan` — planned / experimental

Selecting an unavailable backend does **not** cause an automatic switch to another backend. This prevents confusing situations where a generation unexpectedly runs on CPU, WSL or a different runtime.

## Current limitations

- Shape generation only; Hunyuan texture generation is not wired yet.
- Generation progress is produced by the Python worker but the first Tauri bridge waits for the worker to finish instead of streaming events live.
- Cancellation is modeled in the domain state machine but process cancellation is not yet connected to the UI.
- The runtime installer is currently a PowerShell setup script; it is not yet integrated into the desktop UI or MSI/NSIS installer.
- WSL2 and Vulkan execution are not yet implemented.
- The Hunyuan model/runtime is third-party software with its own license terms. Model weights are not bundled with this repository.

## Why Hunyuan3D-2 Mini first?

Tencent documents the Mini shape pipeline as a 0.6B image-to-shape model and reports about 6 GB of VRAM for shape generation. The full texture path requires substantially more memory, so the MVP intentionally produces geometry first and treats texture generation as a separate future stage.

## References

- TheRock: https://github.com/ROCm/TheRock
- TheRock releases/install guide: https://github.com/ROCm/TheRock/blob/main/RELEASES.md
- TheRock GPU status: https://github.com/ROCm/TheRock/blob/main/SUPPORTED_GPUS.md
- Hunyuan3D-2: https://github.com/Tencent-Hunyuan/Hunyuan3D-2
- Hunyuan3D-2 Mini weights: https://huggingface.co/tencent/Hunyuan3D-2mini

## Roadmap

1. Native ROCm Hunyuan shape generation — **in progress / MVP**
2. Runtime/model installer inside the UI
3. Live progress + cancellation
4. Mesh cleanup / decimation controls
5. Optional texture pipeline with VRAM-aware staging
6. WSL2 ROCm worker
7. Experimental Vulkan / TRELLIS backend
8. Packaged Windows installer and releases

See `docs/superpowers/specs/2026-09-11-img2model-amd-design.md` for the architecture and `docs/superpowers/plans/2026-09-11-mvp-bootstrap.md` for the implementation plan.
