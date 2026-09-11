# Img2Model AMD

Windows-first image-to-3D desktop tooling focused on AMD Radeon GPUs.

## Current status

The native Windows ROCm/TheRock shape pipeline is hardware-validated on a Radeon RX 6950 XT (gfx1030, 16 GB):

- PyTorch `2.13.0+rocm10.0.0`
- Torchvision `0.28.0+rocm10.0.0`
- HIP visible through PyTorch
- real GPU matrix multiplication passed
- Hunyuan3D-2 Mini fp16 shape generation completed and exported a valid GLB

The optional Hunyuan Paint texture stage is experimental. The Windows AMD setup now:

- reuses the existing ROCm runtime instead of reinstalling it,
- forces Ninja + C++20 for PyTorch 2.13 native extensions,
- patches Hunyuan's shared rasterizer header so MSVC host `.cpp` translation units do not parse HIP-only headers,
- clears stale HIPify outputs before rebuilding,
- writes a full timestamped setup/build log under `%LOCALAPPDATA%\Img2ModelAMD\runtime\native-rocm\logs`,
- prints only the last 80 log lines on failure plus the full log path.

## Portable Windows test flow

1. Extract the portable ZIP.
2. If the AMD runtime is not installed yet, run `setup-amd-runtime.cmd`.
3. Run `smoke-test-amd.cmd` and verify the GPU tensor probe.
4. Run `setup-texture-runtime.cmd` to build the experimental Hunyuan Paint native extensions.
5. If texture setup fails, upload the generated `texture-setup-YYYYMMDD-HHMMSS.log` from `%LOCALAPPDATA%\Img2ModelAMD\runtime\native-rocm\logs`.
6. Launch with `run-img2model-amd.cmd` or `Img2ModelAMD.exe`.

The texture setup preserves the already working shape runtime even if native extension compilation fails.

## Architecture

```text
Windows Desktop App (Tauri)
├─ UI Layer (React / TypeScript)
│  ├─ input image workflow
│  ├─ generation controls
│  ├─ setup / diagnostics
│  ├─ export controls
│  └─ 3D preview
├─ App Core
│  ├─ backend manager
│  ├─ job state machine
│  ├─ GPU capability detection
│  ├─ model manager
│  ├─ export manager
│  └─ logging / diagnostics
├─ Worker Adapters
│  ├─ native ROCm / TheRock
│  ├─ WSL2 (planned)
│  └─ Vulkan (planned)
└─ Inference Backends
   ├─ Hunyuan shape
   ├─ Hunyuan Paint texture (experimental)
   └─ TRELLIS / additional backends (planned)
```

Backend selection never silently falls back: an explicit unhealthy backend selection is reported as an error. Automatic recommendation prefers native ROCm, then WSL2, then Vulkan when those adapters become executable.

## Development

From the repository root:

```bash
npm install
npm test -- --run
npm run build
```

Rust core tests:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
```

Python worker tests:

```bash
python -m unittest discover -s backends/hunyuan/tests -v
```

## Native Windows AMD runtime

The setup script installs the runtime to:

```text
%LOCALAPPDATA%\Img2ModelAMD\runtime\native-rocm
```

It configures persistent user environment variables:

```text
IMG2MODEL_PYTHON
IMG2MODEL_WORKER
```

Stable gfx1030 setup uses the matching AMD ROCm wheel set, including Torchvision required by Hunyuan imports.

## Worker CLI

Health:

```powershell
& $env:IMG2MODEL_PYTHON $env:IMG2MODEL_WORKER health --json
```

GPU probe:

```powershell
& $env:IMG2MODEL_PYTHON $env:IMG2MODEL_WORKER probe --json
```

Shape generation:

```powershell
& $env:IMG2MODEL_PYTHON $env:IMG2MODEL_WORKER generate `
  --input "C:\path\input.png" `
  --output "C:\path\model.glb" `
  --model "tencent/Hunyuan3D-2mini" `
  --subfolder "hunyuan3d-dit-v2-mini" `
  --variant "fp16" `
  --steps 20 `
  --seed 1234 `
  --remove-background
```

Texture runtime health:

```powershell
& $env:IMG2MODEL_PYTHON $env:IMG2MODEL_WORKER texture-health --json
```

Texture an existing mesh:

```powershell
& $env:IMG2MODEL_PYTHON $env:IMG2MODEL_WORKER texture `
  --mesh "C:\path\shape.glb" `
  --image "C:\path\input.png" `
  --output "C:\path\textured.glb" `
  --model "tencent/Hunyuan3D-2" `
  --subfolder "hunyuan3d-paint-v2-0-turbo" `
  --cpu-offload `
  --remove-background
```

## Limitations / roadmap

- Native Windows ROCm shape generation is validated on RX 6950 XT.
- Hunyuan Paint native extensions are still undergoing hardware validation on Windows/gfx1030.
- Texture generation uses CPU model offload by default on 16 GB VRAM.
- WSL2 and Vulkan adapters are planned, not yet executable in the MVP.
- TRELLIS remains an experimental/future backend rather than an MVP dependency.
- Live inference cancellation/progress streaming beyond worker events is not complete.
- Hunyuan model weights are downloaded separately and are not bundled with this repository.

See `docs/superpowers/specs/2026-09-11-img2model-amd-design.md` and the implementation plans under `docs/superpowers/plans/` for the current design and milestone scope.
