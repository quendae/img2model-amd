# Hunyuan Texture on AMD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional Hunyuan texture stage that can turn an already-generated mesh plus its source image into a textured GLB on Windows AMD, preferring a ROCm/HIP build of Hunyuan's rasterizer and retaining CPU fallback as the next contingency.

**Architecture:** Keep shape and texture as separate worker commands so a successful mesh survives texture failures. Extend the Hunyuan worker protocol with texture capability probing and a `texture` command, then add a Windows setup script that installs Hunyuan's texture-only native extensions into the existing persistent ROCm runtime. The desktop UI only exposes texture generation when capability diagnostics report the texture runtime healthy.

**Tech Stack:** Python 3.11, PyTorch ROCm/TheRock, Hunyuan3D-2, torch.utils.cpp_extension HIPify, PowerShell, Tauri/Rust, React/TypeScript, Three.js.

**Spec:** `docs/superpowers/specs/2026-09-11-img2model-amd-design.md`

## Global Constraints

- Primary target: AMD Radeon RX 6950 XT, 16 GB VRAM, Windows host.
- Native ROCm/TheRock remains the preferred backend.
- Texture generation is optional and separate from shape generation.
- A texture failure must never destroy or replace the successful untextured mesh.
- The app must never silently switch backends.
- Model/backend-specific logic must stay outside the UI layer.

---

### Task 1: Texture worker protocol

**Files:**
- Modify: `backends/hunyuan/worker.py`
- Modify: `backends/hunyuan/tests/test_worker.py`

**Interfaces:**
- Consumes: existing JSON event protocol and Hunyuan worker CLI.
- Produces: `texture-health --json` and `texture --mesh <path> --image <path> --output <path> [--model tencent/Hunyuan3D-2] [--cpu-offload]`.

- [ ] **Step 1: Write failing tests** for parser defaults, missing mesh/image validation, and machine-readable texture capability output.
- [ ] **Step 2: Run worker unit tests and confirm RED.**
- [ ] **Step 3: Implement lazy texture capability detection** for `hy3dgen.texgen`, `custom_rasterizer`, and `mesh_processor` without importing them during normal shape health.
- [ ] **Step 4: Implement `texture` command** that loads the existing mesh with trimesh, loads/recenters the source image, constructs `Hunyuan3DPaintPipeline.from_pretrained('tencent/Hunyuan3D-2')`, optionally calls `enable_model_cpu_offload()`, exports the textured GLB to a new output path, and emits `running_texture`, `postprocessing`, `completed`, or structured `error` events.
- [ ] **Step 5: Run worker tests and confirm GREEN.**

### Task 2: Windows ROCm texture-extension setup

**Files:**
- Create: `scripts/setup/windows-hunyuan-texture.ps1`
- Modify: `backends/hunyuan/tests/test_windows_scripts.py`
- Modify: `README.md`

**Interfaces:**
- Consumes: existing `%LOCALAPPDATA%\Img2ModelAMD\runtime\native-rocm` runtime and installed ROCm PyTorch.
- Produces: importable `custom_rasterizer` and `mesh_processor` modules plus a texture-health verification result.

- [ ] **Step 1: Write failing regression tests** requiring the new setup script to reuse `IMG2MODEL_PYTHON`/persistent runtime, avoid `python -c $multiline`, build texture extensions with the existing ROCm PyTorch, and run `worker.py texture-health --json` at the end.
- [ ] **Step 2: Run worker tests and confirm RED.**
- [ ] **Step 3: Implement the setup script** to download a pinned Hunyuan source archive, extract only the texture build tree into the runtime, install `custom_rasterizer` and `differentiable_renderer` with `--no-build-isolation`, and log detected `torch.version.hip`, `ROCM_HOME`, compiler availability, and extension import status.
- [ ] **Step 4: Prefer PyTorch's native ROCm HIPify path** rather than hand-editing upstream CUDA kernels. On a ROCm build, `CUDAExtension` is expected to switch to HIP extension compilation; if the Windows toolchain rejects upstream CUDA-only source, preserve the exact compiler error and stop rather than altering the working shape runtime.
- [ ] **Step 5: Document manual RX 6950 XT texture setup and smoke commands.**
- [ ] **Step 6: Run unit/CI syntax checks and confirm GREEN.**

### Task 3: Desktop texture-stage plumbing

**Files:**
- Modify: `apps/desktop/src/domain/types.ts`
- Modify: `apps/desktop/src/components/GenerationPanel.tsx`
- Modify: `apps/desktop/src/components/GenerationPanel.test.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src-tauri/src/worker.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: successful shape GLB path and source image path.
- Produces: optional second-stage textured GLB without overwriting the untextured mesh.

- [ ] **Step 1: Write failing frontend/Rust tests** for an explicit texture option and argument construction.
- [ ] **Step 2: Add a Tauri texture command** that invokes the worker's `texture` subcommand with argument arrays only.
- [ ] **Step 3: Add UI toggle/status** for optional texture generation and show texture capability separately from shape backend health.
- [ ] **Step 4: Preserve shape output on texture failure** and surface the texture error as a secondary stage failure.
- [ ] **Step 5: Run frontend, Rust, Python, and Windows CI checks.**

### Task 4: RX 6950 XT validation checkpoint

**Files:**
- Modify: `README.md` after hardware result.
- Optional: add PR comment with observed hardware validation.

**Interfaces:**
- Consumes: user machine with verified RX 6950 XT ROCm runtime and a known-good untextured GLB.
- Produces: first textured GLB or a precise Windows/HIP compiler/runtime blocker.

- [ ] **Step 1: Run `windows-hunyuan-texture.ps1` on the verified runtime.**
- [ ] **Step 2: Run `worker.py texture-health --json`.**
- [ ] **Step 3: Texture the existing `img2model-smoke.glb` with the original `drewno.png` using `--cpu-offload`.**
- [ ] **Step 4: If HIP extension build fails, capture the exact compiler/import error and branch to a CPU-rasterizer implementation rather than modifying shape generation.**
- [ ] **Step 5: Record timing, peak practical VRAM observation if available, output size, and whether the GLB contains a visible baked texture.**
