# Img2Model AMD

A Windows desktop image-to-3D application focused on AMD Radeon GPUs.

The initial hardware target is the **Radeon RX 6950 XT (16 GB, gfx1030)**. The app uses a native Tauri/React desktop UI, Three.js for preview, and an out-of-process Python worker for Hunyuan3D shape and optional texture generation.

> **Current status:** MVP / experimental. Native ROCm/TheRock Hunyuan shape generation and Hunyuan Paint texture generation are hardware-validated on an RX 6950 XT. WSL2 ROCm and Vulkan/TRELLIS remain experimental future backends.

## What works

- Windows desktop shell with Tauri 2
- React/TypeScript generation UI
- AMD GPU, WSL and Python diagnostics
- Hunyuan shape and texture capability health checks
- Hunyuan3D-2 Mini image-to-shape worker using the `fp16` Mini weights by default
- Optional Hunyuan Paint mesh + image texture stage
- Official Hunyuan texture mesh cleanup/reduction before Paint
- Texture failure preserves the successful untextured shape output
- CPU model offload plus MAX attention slicing as the validated 16 GB texture profile
- PNG/JPG/WEBP input selection
- Fast / Balanced / Quality step presets
- Seed and optional background removal
- GLB and OBJ worker export
- Interactive Three.js GLB and OBJ preview
- Explicit backend policy: **no silent fallback**
- Unit tests for backend selection, job state transitions, preview formats, worker protocol and Rust bridge helpers
- CI on Linux plus Windows desktop compilation and PowerShell syntax validation

## Architecture

```text
Tauri desktop app
  ├─ React / TypeScript UI
  ├─ Three.js model viewer
  ├─ Rust diagnostics + process bridge
  │    └─ native-rocm worker
  │         ├─ Hunyuan3D-2 Mini shape
  │         └─ Hunyuan Paint texture (optional)
  │              └─ custom rasterizer via PyTorch ROCm/HIPify
  ├─ wsl-rocm       (planned)
  └─ Vulkan/TRELLIS (planned / experimental)
```

The ML runtime is kept outside the desktop process. A failed model import, texture-extension import, or inference run returns an error rather than terminating the UI. Shape and texture are intentionally separate jobs so a texture failure cannot destroy a valid generated mesh.

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

The script defaults to AMD's **stable** TheRock wheel index and installs a matching gfx1030 ROCm/PyTorch stack, including the Hunyuan-required ROCm build of `torchvision`.

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

### RX 6950 XT hardware validation

The native Windows path has been validated on a Radeon RX 6950 XT with:

- PyTorch `2.13.0+rocm10.0.0`
- HIP runtime reported by PyTorch
- the GPU visible through the PyTorch `torch.cuda` compatibility namespace
- approximately 16 GB VRAM detected
- a real 1024×1024 matrix multiplication executed on the Radeon GPU
- Hunyuan3D-2 Mini `fp16` shape generation completed successfully and exported a GLB
- Hunyuan Paint native extensions compiled and imported successfully through TheRock/ROCm
- the official Hunyuan cleanup/reduction flow reduced a multi-million-triangle shape to a 40k working mesh
- Hunyuan Paint completed a real textured GLB using CPU model offload plus MAX Diffusers attention slicing

Both the shape and texture paths are therefore considered verified on the target card. The 40k value is a **texture working-mesh ceiling**, not a recommended in-game triangle count; lower game-ready targets are planned as explicit UI presets and a custom polycount control.

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

On the validated RX 6950 XT profile, CPU model offload and `attention-slicing=max` are enabled by default. Advanced users can opt out explicitly with `--no-cpu-offload` and/or `--attention-slicing off` on higher-memory hardware. The default texture preprocessing follows Hunyuan's official cleanup path and caps the working mesh at 40,000 triangles via `--max-faces 40000`.

The first texture run downloads additional Hunyuan Paint / delight model weights. The original untextured mesh remains untouched if the texture stage fails.

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
5. If `texture-health` is healthy, optionally enable **Generate texture**.
6. Generate the model and choose the final output path.
7. With texture enabled, the app first saves a sibling `*-shape.glb`/`*.obj`, then writes the final textured output separately.
8. The latest successful model is loaded into the center 3D viewer.

The first shape or texture generation can download several GB of model weights from Hugging Face.

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

The worker emits newline-delimited JSON progress events and finishes with either a `completed` or `error` event. Texture progress/completion events include the face count before/after preprocessing and the active low-VRAM settings.

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

- `native-rocm` — implemented and shape/texture-validated on RX 6950 XT
- `wsl-rocm` — planned
- `vulkan` — planned / experimental

Selecting an unavailable backend does **not** cause an automatic switch to another backend. This prevents confusing situations where a generation unexpectedly runs on CPU, WSL or a different runtime.

## Current limitations

- The 40k Hunyuan texture working-mesh limit is far above many real-time game budgets; game-ready presets and a custom 300-40k triangle control are planned next.
- Generation progress is produced by the Python worker but the current Tauri bridge waits for each worker stage to finish instead of streaming events live.
- Cancellation is modeled in the domain state machine but process cancellation is not yet connected to the UI.
- The runtime installer is currently a PowerShell setup script; it is not yet integrated into the desktop UI or MSI/NSIS installer.
- WSL2 and Vulkan/TRELLIS execution are not yet implemented.
- The Hunyuan model/runtime is third-party software with its own license terms. Model weights are not bundled with this repository.

## Why Hunyuan3D-2 Mini first?

Tencent documents the Mini shape pipeline as a 0.6B image-to-shape model. The texture path is substantially more memory-intensive and has native rasterization dependencies, so Img2Model AMD stages geometry and texture separately. On the 16 GB RX 6950 XT, the validated texture profile combines CPU model offload with maximum attention slicing.

## References

- TheRock: https://github.com/ROCm/TheRock
- TheRock releases/install guide: https://github.com/ROCm/TheRock/blob/main/RELEASES.md
- TheRock GPU status: https://github.com/ROCm/TheRock/blob/main/SUPPORTED_GPUS.md
- Hunyuan3D-2: https://github.com/Tencent-Hunyuan/Hunyuan3D-2
- Hunyuan3D-2 Mini weights: https://huggingface.co/tencent/Hunyuan3D-2mini

## Roadmap

1. Native ROCm Hunyuan shape generation — **validated on RX 6950 XT**
2. Native ROCm/HIP Hunyuan Paint rasterizer + textured GLB — **validated on RX 6950 XT**
3. Game-ready triangle presets and custom polycount control
4. Optional quality-first low-poly baking pipeline if direct low-poly Paint needs more fidelity
5. Runtime/model installer inside the UI
6. Live progress + cancellation
7. WSL2 ROCm worker
8. Experimental TRELLIS / Vulkan or ROCm backend
9. Packaged Windows installer and releases

See `docs/superpowers/specs/2026-09-11-img2model-amd-design.md`, `docs/superpowers/plans/2026-09-11-mvp-bootstrap.md`, `docs/superpowers/plans/2026-09-11-hunyuan-texture-amd.md`, `docs/superpowers/plans/2026-09-11-texture-mvp-hardening.md`, and `docs/superpowers/plans/2026-09-11-game-ready-polycount.md`.
