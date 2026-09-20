# Img2Model AMD Windows Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a normal Windows NSIS setup for Img2Model AMD that carries a version-matched runtime bootstrap payload and preserves runtime/model caches across upgrades.

**Architecture:** Tauri produces a current-user NSIS installer. A pre-bundle Node script stages the exact setup scripts and Python backend sources under `src-tauri/resources/installer-payload`; an NSIS post-install hook invokes a bundled PowerShell orchestrator that reuses the existing native ROCm and texture installers without requiring a Git checkout. Runtime state stays under `%LOCALAPPDATA%\Img2ModelAMD`, outside the app install directory.

**Tech Stack:** Tauri 2, NSIS, PowerShell 5.1+, Node.js 22, GitHub Actions Windows runner.

**Spec:** `docs/roadmap/windows-installer.md`

## Global Constraints

- Product name is `Img2Model AMD`.
- First hardware target remains Windows 11 + Radeon RX 6950 XT / gfx1030.
- Installer does not bundle model weights.
- Installer does not delete `%LOCALAPPDATA%\Img2ModelAMD\runtime` or model caches during upgrade/uninstall.
- No silent backend/prerequisite fallback.
- Existing repository developer setup commands remain supported.

## Review Focus

- Paths containing spaces must remain quoted from NSIS through PowerShell.
- Installer payload must include every module imported by the persistent worker.
- Existing healthy runtime must be reused rather than destructively recreated.
- Failure in runtime bootstrap must surface a non-zero installer result and a log path.
- CI packaging must not accidentally embed local runtime/model caches.

---

### Task 1: Stage a deterministic installer payload

**Files:**
- Create: `scripts/setup/prepare-installer-resources.mjs`
- Modify: `.gitignore`
- Modify: `apps/desktop/package.json`
- Test: `backends/hunyuan/tests/test_windows_scripts.py`

**Interfaces:**
- Consumes source setup/backend files from the checkout.
- Produces `apps/desktop/src-tauri/resources/installer-payload/` with `scripts/setup`, `backends/hunyuan`, and `backends/mesh_processing` in repository-compatible layout.

- [ ] Add a failing contract test that asserts the desktop package exposes `prepare-installer` and the staging script copies only source/runtime bootstrap inputs, not `.runtime`, model caches, outputs, or logs.
- [ ] Run Python tests and confirm RED because the script/package command does not exist.
- [ ] Implement the staging script using Node `fs.rm`, `mkdir`, and `cp`; add the generated payload directory to `.gitignore`; wire `prepare-installer` into the desktop package.
- [ ] Run Python tests and a direct Node staging invocation; verify the expected payload tree exists.
- [ ] Commit.

### Task 2: Make setup scripts runnable from installed payload

**Files:**
- Create: `scripts/setup/install-img2model-runtime.ps1`
- Modify: `scripts/setup/windows-native-rocm.ps1`
- Modify: `scripts/setup/windows-hunyuan-texture.ps1`
- Test: `backends/hunyuan/tests/test_windows_scripts.py`

**Interfaces:**
- Produces `install-img2model-runtime.ps1 -PayloadRoot <path> [-VerifyOnly]`.
- Existing source-tree setup remains valid when `-PayloadRoot` is omitted.

- [ ] Add RED tests for `-PayloadRoot`, explicit Python/C++ prerequisite messages, persistent installer log, and ordered invocation of native setup then texture setup.
- [ ] Run tests and observe failure.
- [ ] Add optional `PayloadRoot`/`SourceRoot` resolution to existing scripts and implement the orchestration script.
- [ ] The orchestrator checks `py -3.11`, records `%LOCALAPPDATA%\Img2ModelAMD\logs\installer-runtime.log`, invokes both setup stages, and verifies `health --json` plus `texture-health --json`.
- [ ] Run tests and PowerShell parse validation.
- [ ] Commit.

### Task 3: Configure Tauri NSIS hooks

**Files:**
- Create: `apps/desktop/src-tauri/windows/installer-hooks.nsh`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Test: `backends/hunyuan/tests/test_windows_scripts.py`

**Interfaces:**
- Consumes bundled `resources/installer-payload`.
- NSIS post-install invokes the runtime orchestrator with the installed payload path and aborts setup when bootstrap fails.

- [ ] Add RED config/hook contract tests for NSIS target, current-user mode, installer hooks, payload resource inclusion, quoting, and `ExecWait` exit-code checking.
- [ ] Run tests and observe failure.
- [ ] Configure `bundle.targets = ["nsis"]`, `bundle.resources`, and `bundle.windows.nsis`; add hook macro.
- [ ] Ensure uninstall has no hook that removes the persistent runtime/cache.
- [ ] Run tests and frontend/Tauri config build checks.
- [ ] Commit.

### Task 4: Build installer in CI

**Files:**
- Create: `.github/workflows/windows-installer.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Test: workflow/config contract checks in `backends/hunyuan/tests/test_windows_scripts.py`

**Interfaces:**
- Produces a Windows Actions artifact containing the Tauri NSIS `*-setup.exe`.

- [ ] Add RED tests asserting the workflow stages resources, runs `tauri build --bundles nsis`, and uploads the setup executable.
- [ ] Implement a manual + tag packaging workflow on `windows-latest` using Node 22 and Rust stable.
- [ ] Extend regular Windows CI to parse all installer PowerShell and stage resources before build checks.
- [ ] Document installed paths, prerequisites, upgrade preservation, and how to build the setup locally.
- [ ] Run the full project CI and confirm frontend, Python, Rust, and desktop-Windows all pass.
- [ ] Commit and record installer hardware acceptance as pending until a generated setup is tested on the RX 6950 XT machine.
