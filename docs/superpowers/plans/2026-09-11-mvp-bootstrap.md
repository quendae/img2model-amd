# Img2Model AMD MVP Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the first executable vertical slice of Img2Model AMD: desktop UI, 3D preview, backend/job contracts, AMD/WSL diagnostics, and a Hunyuan worker that can perform shape generation when the external Hunyuan3D runtime is installed.

**Architecture:** A Tauri 2 desktop shell hosts a React/TypeScript UI. Pure TypeScript modules own job/backend policy and are unit-tested independently. Tauri Rust commands perform host diagnostics and spawn a Python worker. The Python worker uses a line-oriented JSON protocol and dynamically imports Hunyuan3D so the desktop application can start even before large ML dependencies are installed.

**Tech Stack:** Tauri 2, Rust, React, TypeScript, Vite, Three.js, Vitest, Python 3.11+, unittest/pytest-compatible tests, Hunyuan3D-2 external runtime.

**Spec:** `docs/superpowers/specs/2026-09-11-img2model-amd-design.md`

## Global Constraints

- Primary hardware target: AMD Radeon RX 6950 XT, 16 GB VRAM, Windows host.
- WSL2 is allowed.
- Worker failure must not crash the desktop app.
- Backends must remain isolated behind a common contract.
- Shape generation must be usable without requiring texture generation.
- GLB is the default output format; OBJ is also supported by the worker.
- No silent backend fallback.
- TRELLIS remains outside this MVP critical path.

---

## File Map

- `package.json` — workspace scripts and dependency entry point.
- `apps/desktop/package.json` — desktop web dependencies and scripts.
- `apps/desktop/src/domain/types.ts` — shared frontend domain types.
- `apps/desktop/src/domain/backendPolicy.ts` — backend recommendation/selection policy.
- `apps/desktop/src/domain/jobState.ts` — legal job state transitions.
- `apps/desktop/src/domain/*.test.ts` — unit tests for policy and state machine.
- `apps/desktop/src/lib/tauri.ts` — typed wrappers around Tauri commands with browser-dev fallback.
- `apps/desktop/src/components/` — focused UI components.
- `apps/desktop/src/App.tsx` — application composition only.
- `apps/desktop/src/styles.css` — application styling.
- `apps/desktop/src-tauri/src/diagnostics.rs` — Windows/WSL/Python/GPU probing.
- `apps/desktop/src-tauri/src/worker.rs` — Python worker process invocation.
- `apps/desktop/src-tauri/src/lib.rs` — Tauri command registration.
- `backends/hunyuan/worker.py` — JSON CLI, health check, shape generation.
- `backends/hunyuan/tests/test_worker.py` — worker protocol tests without importing Hunyuan.
- `backends/hunyuan/requirements-base.txt` — lightweight worker requirements only.
- `models/manifests/hunyuan3d-2mini.json` — first model manifest.
- `.github/workflows/ci.yml` — TypeScript, Rust and Python verification.
- `README.md` — setup, development and current limitations.

---

### Task 1: Domain contracts and tests

**Files:**
- Create: `apps/desktop/src/domain/types.ts`
- Create: `apps/desktop/src/domain/backendPolicy.test.ts`
- Create: `apps/desktop/src/domain/backendPolicy.ts`
- Create: `apps/desktop/src/domain/jobState.test.ts`
- Create: `apps/desktop/src/domain/jobState.ts`

**Interfaces:**
- Produces `BackendId = 'native-rocm' | 'wsl-rocm' | 'vulkan'`.
- Produces `BackendStatus`, `GenerationJob`, `JobState`.
- Produces `chooseBackend(statuses, preferred?) -> BackendDecision`.
- Produces `canTransition(from, to) -> boolean`.

- [ ] Write `backendPolicy.test.ts` first. Test that a healthy explicit preference wins; an unhealthy explicit preference returns an actionable error and does not silently fall back; automatic mode prefers native ROCm then WSL then Vulkan.
- [ ] Run `npm test -- --run` and verify RED because `backendPolicy.ts` does not exist.
- [ ] Implement the minimal backend policy.
- [ ] Run tests and verify GREEN.
- [ ] Write `jobState.test.ts` first. Test legal path `queued -> preparing_input -> starting_backend -> running_shape -> postprocessing -> loading_preview -> completed`, cancellation from active states, and rejection of `completed -> running_shape`.
- [ ] Run tests and verify RED.
- [ ] Implement `canTransition` using an explicit transition map.
- [ ] Run tests and verify GREEN.

### Task 2: Hunyuan worker protocol

**Files:**
- Create: `backends/hunyuan/tests/test_worker.py`
- Create: `backends/hunyuan/worker.py`
- Create: `backends/hunyuan/requirements-base.txt`
- Create: `models/manifests/hunyuan3d-2mini.json`

**Interfaces:**
- CLI: `python worker.py health --json`
- CLI: `python worker.py generate --input <path> --output <path> --model <repo> --subfolder <name> --steps <n> --seed <n> [--remove-background]`
- Health JSON fields: `ok`, `python`, `torch_available`, `hunyuan_available`, `torch_version`, `hip_version`, `device_name`, `error`.
- Generation emits JSON progress lines to stdout and writes GLB/OBJ output.

- [ ] Write worker tests first using subprocess calls. Health must return valid JSON without Hunyuan installed. Generate with missing input must return non-zero and JSON error.
- [ ] Run `python -m unittest discover -s backends/hunyuan/tests -v` and verify RED.
- [ ] Implement argument parsing and health command with dynamic imports.
- [ ] Implement generation by dynamically importing `PIL.Image`, `hy3dgen.rembg.BackgroundRemover`, and `hy3dgen.shapegen.Hunyuan3DDiTFlowMatchingPipeline`; call `from_pretrained(model, subfolder=...)`, generate one mesh, and `mesh.export(output)`.
- [ ] Do not import Hunyuan modules at module import time.
- [ ] Run worker tests and verify GREEN.

### Task 3: Tauri diagnostics and worker bridge

**Files:**
- Create: `apps/desktop/src-tauri/Cargo.toml`
- Create: `apps/desktop/src-tauri/tauri.conf.json`
- Create: `apps/desktop/src-tauri/build.rs`
- Create: `apps/desktop/src-tauri/src/diagnostics.rs`
- Create: `apps/desktop/src-tauri/src/worker.rs`
- Create: `apps/desktop/src-tauri/src/lib.rs`
- Create: `apps/desktop/src-tauri/src/main.rs`

**Interfaces:**
- Tauri command `get_system_diagnostics() -> SystemDiagnostics`.
- Tauri command `hunyuan_health() -> WorkerHealth`.
- Tauri command `generate_shape(request: GenerateRequest) -> GenerateResult`.

- [ ] Write Rust unit tests in `diagnostics.rs` for parsing `rocminfo`/environment output and in `worker.rs` for worker path resolution before production code.
- [ ] Run `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` and verify RED.
- [ ] Implement diagnostics: OS, WSL availability via `wsl.exe --status`, Python resolution, environment override `IMG2MODEL_PYTHON`, and AMD GPU names on Windows via PowerShell/CIM.
- [ ] Implement worker process invocation with argument arrays only; never build shell command strings from user paths.
- [ ] Parse the final JSON line from worker stdout and surface stderr in structured errors.
- [ ] Run Rust tests and verify GREEN.

### Task 4: Desktop UI and 3D preview

**Files:**
- Create: `package.json`
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/index.html`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/vite.config.ts`
- Create: `apps/desktop/src/main.tsx`
- Create: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/lib/tauri.ts`
- Create: `apps/desktop/src/components/InputPanel.tsx`
- Create: `apps/desktop/src/components/DiagnosticsPanel.tsx`
- Create: `apps/desktop/src/components/GenerationPanel.tsx`
- Create: `apps/desktop/src/components/ModelViewer.tsx`
- Create: `apps/desktop/src/styles.css`

**Interfaces:**
- `ModelViewer` consumes a local GLB URL/path and shows a neutral scene.
- UI displays selected backend and never silently changes it.
- Browser dev mode provides synthetic diagnostics so `npm run dev` works without Tauri.

- [ ] Add a component test for backend selection messaging before implementing the generation panel.
- [ ] Verify test failure.
- [ ] Implement a three-column desktop layout: input/settings left, viewer center, diagnostics/job state right.
- [ ] Add Three.js `GLTFLoader` viewer with orbit controls, grid, lights and cleanup on unmount.
- [ ] Add image picker/drop preview and generation controls for profile, backend, texture toggle, seed and steps.
- [ ] Add diagnostics refresh and Hunyuan health action.
- [ ] Run TypeScript tests and build.

### Task 5: CI and documentation

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.gitignore`
- Create: `README.md`

- [ ] CI installs Node dependencies and runs `npm test -- --run` plus `npm run build`.
- [ ] CI installs Rust stable and runs `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`.
- [ ] CI runs Python worker unit tests on Python 3.11.
- [ ] README explains that Hunyuan weights/runtime are external, that RX 6950 XT support is experimental, and how to point `IMG2MODEL_PYTHON` at the AMD-enabled environment.
- [ ] README documents `health` and `generate` worker commands and development commands.

## Plan Self-Review

- Spec coverage in this plan: desktop shell, backend contract, job state machine, diagnostics, shape-first Hunyuan integration, 3D preview, GLB/OBJ worker output, logs/errors foundation and CI.
- Deferred deliberately: texture pipeline, automatic TheRock installation, automatic WSL distro provisioning, TRELLIS/Vulkan implementation, model download manager and batch generation.
- No silent fallback is enforced by domain policy tests.
- Hunyuan dependency loading is dynamic, so diagnostics remain usable on a clean machine.
