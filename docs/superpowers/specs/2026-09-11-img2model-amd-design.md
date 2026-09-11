# Img2Model AMD — Design Spec

**Date:** 2026-09-11  
**Project:** `quendae/img2model-amd`  
**Goal:** Build a Windows desktop application that generates 3D models from input images, optimized for AMD GPUs such as the Radeon RX 6950 XT (16 GB VRAM), while remaining usable when individual model backends have incomplete AMD support.

## 1. Purpose

The application should let a Windows user load a 2D image, generate a 3D model from it, preview the result in-app, export common 3D formats, use an AMD GPU whenever possible, and fall back to alternative runtimes when one backend is not compatible.

The core problem is not merely running one model. The product must provide a stable desktop workflow around fragmented AMD inference paths.

## 2. Success Criteria

### Functional
1. Launch on Windows.
2. Select an input image.
3. Generate a 3D mesh using AMD acceleration.
4. Preview the 3D model.
5. Export at least GLB and OBJ.

### Technical
- Detect the AMD GPU and report backend capability.
- Run at least one production-ready image-to-3D backend on RX 6950 XT.
- Isolate model backends so additional engines can be added later.
- Report failures clearly and non-destructively.

### Product
The app should feel like a desktop tool rather than a bare inference demo.

## 3. Constraints

Primary target:
- AMD Radeon RX 6950 XT
- 16 GB VRAM
- Windows host
- WSL2 allowed

Runtime realities:
- AMD support across PyTorch, ROCm, Windows and WSL2 is fragmented.
- Some upstream projects assume CUDA or NVIDIA-only custom operators.
- Some models fit within 16 GB only for geometry generation, not full texture generation.
- Compatibility may differ between native Windows ROCm/TheRock, WSL2 ROCm, Vulkan-native inference, and CPU utilities.

The user should not have to manually rebuild Python environments for normal app use.

## 4. Product Direction

Build a hybrid Windows desktop application with:
- native Windows GUI,
- backend manager,
- native ROCm/TheRock backend,
- WSL2 backend,
- experimental Vulkan backend,
- CPU fallback for support steps.

Recommended stack:
- Tauri + React + TypeScript for desktop shell and UI,
- Three.js for 3D preview,
- Python workers for Hunyuan-family inference,
- pluggable backend interface for future engines.

## 5. Architecture

```text
Windows Desktop App (Tauri)
│
├─ UI Layer (React/TypeScript)
│  ├─ Input image workflow
│  ├─ Generation controls
│  ├─ Setup / diagnostics
│  ├─ Export controls
│  └─ 3D preview panel
│
├─ App Core
│  ├─ Backend manager
│  ├─ Job queue / state machine
│  ├─ GPU capability detection
│  ├─ Model manager
│  ├─ Export manager
│  └─ Logging / diagnostics
│
├─ Worker Adapters
│  ├─ TheRock / ROCm adapter
│  ├─ WSL2 adapter
│  └─ Vulkan adapter
│
└─ Inference Backends
   ├─ Hunyuan backend
   ├─ Future TRELLIS backend
   └─ Future additional backends
```

The application must separate UI, job orchestration, backend execution and model-specific logic.

## 6. Backend Strategy

### Native ROCm / TheRock
Preferred AMD path on Windows when healthy. Runs Python inference locally, detects GPU architecture such as `gfx1030`, and keeps model-specific launchers isolated.

### WSL2
Compatibility path for Linux-first ML projects. Manages worker execution inside WSL, bridges files, streams progress and returns artifacts to the Windows app.

### Vulkan
Experimental path for native non-PyTorch inference such as future TRELLIS-derived workers.

### CPU
Used for preprocessing, background removal, mesh cleanup, decimation, conversion and export transforms. CPU image-to-3D is not a primary target.

Backend selection order:
1. user-selected backend if healthy,
2. recommended backend for model,
3. native ROCm,
4. WSL2,
5. Vulkan,
6. actionable failure.

The app must never silently switch backends.

## 7. Initial Model Strategy

Hunyuan-family models are the first production backend.

User-facing profiles:
- **Fast** — draft generation, low-memory shape mode.
- **Balanced** — normal-quality shape generation and optional texture.
- **Quality** — highest feasible geometry detail; texture may run as a separate stage.

Texture generation is optional and must be split from shape generation so a successful mesh is not lost because texture VRAM requirements are too high.

TRELLIS support is architectural but not an MVP dependency. It remains Experimental until proven stable on RDNA2.

## 8. UX

### Setup / Diagnostics
Shows GPU detection, available backends, installed models, missing dependencies, repair actions and backend smoke tests.

### Generation
Shows image input, model/profile selector, backend selector, options, progress/log area, 3D preview and export actions.

### Export
Supports format, mesh simplification, texture options, scale and output location.

Core workflow:
1. open app,
2. check setup health,
3. import image,
4. preprocess input,
5. select quality profile,
6. recommend backend,
7. generate,
8. stream progress,
9. load result into preview,
10. export.

UX requirements include clear progress stages, cancellation, readable logs, high-VRAM warnings, backend recommendations, and concise errors with expandable technical details.

## 9. Functional Requirements

Input:
- drag and drop,
- file picker,
- PNG, JPG, JPEG, WEBP.

Generation:
- model selection,
- quality profile,
- backend selection,
- texture on/off,
- polygon target preset,
- seed,
- detail/steps preset.

Preview:
- rotate, pan and zoom,
- wireframe toggle,
- textured/untextured toggle,
- background/environment lighting presets.

Export MVP:
- GLB,
- OBJ.

Later:
- PLY,
- STL.

Diagnostics:
- detected GPU,
- approximate VRAM,
- backend availability,
- setup status per backend,
- last run log,
- output folder.

## 10. Non-Functional Requirements

- Worker failures must not crash the app.
- Backends run out of process.
- Backend adapters are isolated.
- Model-specific code does not leak into UI.
- New backends use a consistent interface.
- UI stays responsive during generation.
- Logs and large previews load asynchronously.
- Per-run diagnostics include backend, model, timing, memory estimate, exit code and artifacts.

## 11. Data Model

### AppConfig
Install paths, preferred backend, downloaded models, WSL settings, output directory and preview defaults.

### BackendStatus
Backend id, installed flag, available flag, version, health result and last error.

### GenerationJob
Job id, input path, model/profile, backend, options, progress, outputs, logs, timestamps and status.

### ModelManifest
Model id, display name, supported backends, recommended VRAM, supported modes and required files.

## 12. Backend Interface

Each backend implements the conceptual operations:
- `detect()`
- `install()`
- `healthCheck()`
- `listModels()`
- `runJob(jobConfig)`
- `cancelJob(jobId)`
- `collectOutputs(jobId)`
- `getLogs(jobId)`

Generation states:
- `queued`
- `preparing_input`
- `starting_backend`
- `running_shape`
- `running_texture`
- `postprocessing`
- `loading_preview`
- `completed`
- `failed`
- `cancelled`

## 13. Setup Strategy

Setup flow:
1. detect Windows environment,
2. detect GPU and architecture,
3. check WSL2 presence,
4. check native backend capability,
5. install runtime pieces,
6. install selected model packages,
7. run smoke test,
8. mark backend healthy.

Native setup should validate Python, create an isolated environment, install compatible ROCm/TheRock packages, install model dependencies and run tensor/model smoke tests.

WSL2 setup should detect/install WSL support, create a Linux backend environment, validate file bridging and run backend smoke tests.

Models are installed separately from the app binary. The UI shows download size, per-model install/uninstall/repair state, and verifies assets where practical.

## 14. Error Handling

Failure classes include:
- GPU unsupported,
- backend dependency missing,
- insufficient VRAM,
- missing/corrupt model,
- worker crash,
- WSL bridge failure,
- export failure.

Each error presents a short summary, probable cause, suggested action and expandable technical details.

## 15. Security

- Do not execute arbitrary model code from untrusted paths without explicit action.
- Keep model assets separate from app binaries.
- Avoid shell injection in paths and backend commands.
- Sanitize user-provided paths.
- Avoid unnecessary disclosure of local paths in user-facing logs.

## 16. Repository Structure

```text
img2model-amd/
├─ apps/
│  └─ desktop/
│     ├─ src/
│     ├─ src-tauri/
│     └─ public/
├─ backends/
│  ├─ common/
│  ├─ hunyuan-native/
│  ├─ hunyuan-wsl/
│  └─ trellis-vulkan/
├─ tools/
│  ├─ diagnostics/
│  ├─ installers/
│  └─ converters/
├─ docs/
│  └─ superpowers/
│     ├─ specs/
│     └─ plans/
├─ scripts/
│  ├─ dev/
│  ├─ setup/
│  └─ smoke-tests/
├─ models/
│  └─ manifests/
└─ README.md
```

## 17. Milestones

### Milestone 1 — Project skeleton
- Tauri desktop shell
- React UI scaffold
- basic 3D viewer
- backend adapter interface
- job model/state machine
- diagnostics screen scaffold

### Milestone 2 — Native Hunyuan backend
- native backend launcher
- model install flow
- image preprocessing
- shape generation
- output preview
- GLB/OBJ export

### Milestone 3 — WSL2 backend
- detection/setup flow
- file bridge
- worker execution
- health checks

### Milestone 4 — UX hardening
- logs
- cancel/retry
- actionable errors
- model management
- richer diagnostics

### Milestone 5 — Texture and optimization
- optional texture stage
- memory warnings
- profile presets
- mesh postprocessing

### Milestone 6 — Experimental TRELLIS
- Vulkan adapter
- capability checks
- output normalization

## 18. Testing

Unit tests cover config/manifest parsing, backend selection, job state transitions and export validation.

Integration tests cover backend launch, worker file exchange, job lifecycle, model installation and export generation.

Smoke tests cover native backend health, WSL health and a minimal end-to-end sample generation.

Manual validation must include the RX 6950 XT target, missing WSL, broken dependency, insufficient VRAM and cancellation scenarios.

## 19. Key Risks

- Native AMD instability → modular backends and WSL fallback.
- CUDA assumptions → model-specific launchers and focused support matrix.
- VRAM pressure → split shape/texture stages and profiles.
- WSL complexity → automated setup and visible diagnostics.
- TRELLIS instability → keep it outside the MVP critical path.

## 20. MVP Non-Goals

The MVP does not attempt to support every image-to-3D model, guarantee photoreal texture on every 16 GB AMD card, implement cloud inference, accounts, batch farms, complex scenes or text-to-3D as a primary feature.

## 21. First Implementation Scope

The first build includes:
- Tauri desktop shell,
- image import,
- diagnostics/setup screen,
- backend abstraction,
- one Hunyuan-family worker path,
- shape-first generation plumbing,
- 3D preview,
- GLB/OBJ export plumbing,
- logs and error reporting.

## 22. Final Direction

Proceed with a Windows desktop app using Tauri + React + TypeScript, backend abstraction from day one, native ROCm/TheRock as the preferred AMD path, WSL2 as the compatibility path, Hunyuan as the first production model family, and TRELLIS designed in but not required for MVP.
