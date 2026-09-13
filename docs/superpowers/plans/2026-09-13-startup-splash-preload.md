# Startup Splash and Preload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a responsive splash immediately, start the persistent worker and preload Hunyuan3D Shape before revealing the main UI, while preserving clean recovery when startup fails.

**Architecture:** Convert Tauri startup into a two-window lifecycle: `splash` is visible immediately and `main` starts hidden. Rust owns the first worker health/preload sequence and window visibility; the React runtime hook becomes a consumer/recovery layer for restart and post-Texture re-preload instead of duplicating the first startup on mount.

**Tech Stack:** Tauri v2, Rust async runtime, React/TypeScript/Vite multi-page build, existing `WorkerSessionManager` and `preload_hunyuan_shape` path.

**Spec:** `docs/superpowers/specs/2026-09-13-game-ready-remesh-startup-design.md`

## Global Constraints

- Splash appears immediately; the main application window starts hidden.
- First startup preload originates in Rust/Tauri, not a React mount effect.
- Hunyuan Paint remains lazy and is not loaded during startup.
- Preload failure must never trap the user on the splash; show the main window in an error state.
- Mesh mode remains usable when Hunyuan startup fails.
- Existing restart and Shape re-preload after Texture eviction remain functional.
- Do not create two simultaneous persistent worker sessions.

---

## File Structure

- `apps/desktop/src-tauri/tauri.conf.json` — configure hidden main + splash window.
- `apps/desktop/src-tauri/src/startup.rs` — startup state/result and worker preload orchestration.
- `apps/desktop/src-tauri/src/lib.rs` — register startup state, setup hook, and initial-runtime-state command.
- `apps/desktop/splashscreen.html` — dedicated lightweight Vite entry.
- `apps/desktop/src/splash.tsx` — splash UI/status subscription.
- `apps/desktop/src/splash.css` — minimal splash styling.
- `apps/desktop/vite.config.ts` — build both `index.html` and `splashscreen.html`.
- `apps/desktop/src/lib/tauri.ts` — startup state/event bridge.
- `apps/desktop/src/lib/useRuntimeStartup.ts` — hydrate from Rust state and keep restart/re-preload behavior.
- `apps/desktop/src/lib/useRuntimeStartup.test.tsx` and `AppRuntimeStartup.test.tsx` — no duplicate mount preload and correct error recovery.
- Rust tests inside `startup.rs` / existing Tauri core tests — startup state transitions independent of GUI handles.

---

### Task 1: Add a dedicated splash window and Vite entry

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Create: `apps/desktop/splashscreen.html`
- Create: `apps/desktop/src/splash.tsx`
- Create: `apps/desktop/src/splash.css`
- Modify: `apps/desktop/vite.config.ts`
- Add/modify frontend tests for splash markup/build contract.

**Interfaces:**
- Tauri windows: labels `main` and `splash`.
- Splash subscribes to a Tauri event named `runtime-startup-status` carrying `{ phase, message }`.

- [ ] **Step 1: Write RED configuration/build tests**

Add a small test that reads Tauri config / exported splash component contract and verifies:

```text
main.visible == false
splash.visible == true
splash.url == "splashscreen.html"
```

And a frontend test renders:

```text
Img2Model AMD
Starting ROCm worker...
```

- [ ] **Step 2: Run RED**

```bash
cd apps/desktop && npm test -- --run && npm run build
```

Expected: new tests/build contract fail because the splash entry does not exist.

- [ ] **Step 3: Configure two Tauri windows**

Set the main window to:

```json
{
  "label": "main",
  "title": "Img2Model AMD",
  "visible": false,
  "width": 1440,
  "height": 900,
  "minWidth": 1100,
  "minHeight": 720,
  "resizable": true
}
```

Add splash:

```json
{
  "label": "splash",
  "title": "Img2Model AMD",
  "url": "splashscreen.html",
  "width": 460,
  "height": 260,
  "resizable": false,
  "decorations": false,
  "center": true,
  "alwaysOnTop": true,
  "visible": true
}
```

- [ ] **Step 4: Add Vite multi-page build**

Use Rollup input in `vite.config.ts`:

```ts
import { resolve } from 'node:path';

build: {
  rollupOptions: {
    input: {
      main: resolve(__dirname, 'index.html'),
      splashscreen: resolve(__dirname, 'splashscreen.html'),
    },
  },
},
```

`splashscreen.html` mounts `/src/splash.tsx` only; do not load the full app tree/3D viewer.

- [ ] **Step 5: Implement minimal responsive splash**

`splash.tsx` maintains local text with default `Starting ROCm worker...` and listens for `runtime-startup-status`. Render only logo/title, message, and indeterminate progress bar/spinner. No model/Three.js imports.

- [ ] **Step 6: Run GREEN**

```bash
cd apps/desktop && npm test -- --run && npm run build
```

Expected: PASS and `dist/splashscreen.html` exists.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/tauri.conf.json apps/desktop/splashscreen.html apps/desktop/src/splash.tsx apps/desktop/src/splash.css apps/desktop/vite.config.ts apps/desktop/src/*test*
git commit -m "feat: add startup splash window"
```

---

### Task 2: Move first health/preload lifecycle into Rust startup orchestration

**Files:**
- Create: `apps/desktop/src-tauri/src/startup.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Test: Rust tests in `startup.rs`

**Interfaces:**

```rust
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStartupSnapshot {
    pub phase: String,
    pub shape_cache_ready: bool,
    pub shape_preload_ms: Option<f64>,
    pub health: Option<worker::WorkerHealth>,
    pub texture_health: Option<worker::TextureHealth>,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct RuntimeStartupState(std::sync::Mutex<RuntimeStartupSnapshot>);
```

Command:

```rust
#[tauri::command]
fn get_runtime_startup_state(app: tauri::AppHandle) -> RuntimeStartupSnapshot
```

- [ ] **Step 1: Write RED state-machine tests**

Test a pure helper/orchestrator abstraction with injected closures so GUI handles are not required:

```rust
#[test]
fn successful_startup_reaches_ready_after_health_and_preload() {
    let snapshot = run_startup_with(
        || Ok(fake_health_ok()),
        || Ok(fake_texture_health_ok()),
        || Ok(fake_preload_result(21000.0)),
    );
    assert_eq!(snapshot.phase, "ready");
    assert!(snapshot.shape_cache_ready);
}

#[test]
fn preload_failure_returns_error_snapshot_instead_of_hanging() {
    let snapshot = run_startup_with(
        || Ok(fake_health_ok()),
        || Ok(fake_texture_health_ok()),
        || Err("preload failed".into()),
    );
    assert_eq!(snapshot.phase, "error");
    assert!(!snapshot.shape_cache_ready);
}
```

- [ ] **Step 2: Run RED**

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features startup
```

Expected: FAIL because `startup` module/state does not exist.

- [ ] **Step 3: Implement startup orchestration**

`run_startup_with` sequence:

```text
phase=checking -> worker health
texture health best-effort only
phase=preloading -> WorkerSessionManager.preload_shape()
phase=ready or phase=error
```

Texture health failure sets `texture_health=None` but does not fail Shape startup.

- [ ] **Step 4: Wire Tauri `.setup()` without blocking the UI thread**

In `run()`:

```rust
.setup(|app| {
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        // emit status to splash before each blocking stage
        // use spawn_blocking for health/preload work
        // store final RuntimeStartupSnapshot
        // always close splash and show main at terminal success/error
    });
    Ok(())
})
```

Use `handle.emit_to("splash", "runtime-startup-status", payload)` for status text. Terminal window transition must run for both `ready` and `error`:

```rust
if let Some(splash) = handle.get_webview_window("splash") { let _ = splash.close(); }
if let Some(main) = handle.get_webview_window("main") { let _ = main.show(); let _ = main.set_focus(); }
```

Do not call the frontend `preload_hunyuan_shape` command during this first sequence; call `WorkerSessionManager.preload_shape()` directly so a single session owns the cache.

- [ ] **Step 5: Add `get_runtime_startup_state` command**

Register it in `tauri::generate_handler!` so React can hydrate the final Rust snapshot after `main` becomes visible.

- [ ] **Step 6: Run GREEN**

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/startup.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat: preload hunyuan before showing main window"
```

---

### Task 3: Hydrate React runtime state instead of duplicating startup preload

**Files:**
- Modify: `apps/desktop/src/lib/tauri.ts`
- Modify: `apps/desktop/src/lib/useRuntimeStartup.ts`
- Modify: `apps/desktop/src/lib/useRuntimeStartup.test.tsx`
- Modify: `apps/desktop/src/AppRuntimeStartup.test.tsx`
- Modify: `apps/desktop/src/App.tsx` only if runtime initialization call sites require adjustment.

**Interfaces:**

```ts
export interface RuntimeStartupSnapshot {
  phase: 'checking' | 'preloading' | 'ready' | 'error';
  shapeCacheReady: boolean;
  shapePreloadMs?: number | null;
  health: WorkerHealth | null;
  textureHealth: TextureHealth | null;
  error: string | null;
}

export function getRuntimeStartupState(): Promise<RuntimeStartupSnapshot>
```

- [ ] **Step 1: Write RED hook tests**

Mock `getRuntimeStartupState()` to return `ready` and assert:

```ts
expect(preloadHunyuanShape).not.toHaveBeenCalled();
expect(result.current.phase).toBe('ready');
expect(result.current.shapeCacheReady).toBe(true);
```

Add an error snapshot test and assert the hook exposes the Rust startup error while `ensureShapePreloaded()` remains available for a later Retry/Restart.

- [ ] **Step 2: Run RED**

```bash
cd apps/desktop && npm test -- --run src/lib/useRuntimeStartup.test.tsx src/AppRuntimeStartup.test.tsx
```

Expected: FAIL because the hook still calls `initialize()` on mount.

- [ ] **Step 3: Replace mount initialize with hydration**

On first mount call only `getRuntimeStartupState()`, then copy returned fields into React state. Remove:

```ts
useEffect(() => {
  void initialize();
}, [initialize]);
```

from the first-startup path.

Keep `initialize()` as an explicit retry/restart function; it may still perform health + preload after the main window is already visible.

- [ ] **Step 4: Preserve post-Texture eviction behavior**

`markShapeEvicted()` continues to set `shapeCacheReady=false`. Returning to Shape may call `ensureShapePreloaded()` exactly as today. This is separate from the initial Rust preload.

- [ ] **Step 5: Run GREEN**

```bash
cd apps/desktop && npm test -- --run && npm run build
```

Expected: PASS; startup tests assert one initial preload total (Rust), not Rust + React.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/tauri.ts apps/desktop/src/lib/useRuntimeStartup.ts apps/desktop/src/lib/useRuntimeStartup.test.tsx apps/desktop/src/AppRuntimeStartup.test.tsx apps/desktop/src/App.tsx
git commit -m "fix: hydrate frontend from rust startup state"
```

---

### Task 4: Full CI and Windows startup acceptance

**Files:**
- Modify only after a new failing test if verification reveals a defect.

**Interfaces:**
- Expected startup timing on current RX 6950 XT: splash immediate, Shape preload roughly the existing ~20-23s, then main window appears ready.

- [ ] **Step 1: Run complete automated verification**

```bash
python -m unittest discover -s backends/hunyuan/tests -v
python -m unittest discover -s backends/mesh_processing/tests -v
cd apps/desktop && npm test -- --run && npm run build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
```

Expected: all PASS.

- [ ] **Step 2: Require all CI jobs GREEN on one HEAD**

Require `frontend`, `python-worker`, `rust-core`, and `desktop-windows` success.

- [ ] **Step 3: Sync runtime and launch on Windows**

```powershell
git pull
powershell -ExecutionPolicy Bypass -File .\scripts\setup\windows-native-rocm.ps1 -VerifyOnly
npm run tauri -- dev
```

- [ ] **Step 4: Verify startup UX manually**

Acceptance:

```text
0-1s: splash visible and responsive
status: Starting ROCm worker...
status: Loading Hunyuan3D 2 Mini...
terminal success: splash closes, main appears
main header/runtime: Hunyuan3D ready
first Shape: cache hit, Load ~0
```

No blank/frozen main window should be shown during preload.

- [ ] **Step 5: Verify failure escape path**

Temporarily point `IMG2MODEL_WORKER` to an invalid path or otherwise use the existing test seam to force startup failure. Acceptance: splash closes, main opens with Runtime error and Restart worker available; Mesh mode remains reachable.

- [ ] **Step 6: Verify Paint remains lazy**

Startup Activity/worker logs must not show Paint pipeline loading or Shape-cache eviction before the user requests Texture.

- [ ] **Step 7: Commit only test-backed follow-up fixes**

```bash
git add <verified-files-only>
git commit -m "test: validate splash preload lifecycle"
```
