# Startup Splash and Preload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a responsive splash immediately, start the persistent worker and preload Hunyuan3D Shape before revealing the main UI, while preserving clean recovery when startup fails.

**Architecture:** Convert Tauri startup into a two-window lifecycle: `splash` is visible immediately and `main` starts hidden. Rust owns the first worker health/preload sequence and window visibility; the React runtime hook becomes a consumer/recovery layer for restart and post-Texture re-preload instead of duplicating the first startup on mount.

**Tech Stack:** Tauri v2, Rust async runtime, React/TypeScript/Vite multi-page build, existing `WorkerSessionManager` and Shape preload path.

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
- `apps/desktop/src-tauri/src/lib.rs` — register startup state, setup hook, and startup-state command.
- `apps/desktop/splashscreen.html` — dedicated lightweight Vite entry.
- `apps/desktop/src/splash.tsx` — splash UI/status subscription.
- `apps/desktop/src/splash.css` — minimal splash styling.
- `apps/desktop/vite.config.ts` — build both `index.html` and `splashscreen.html`.
- `apps/desktop/src/lib/tauri.ts` — startup state bridge.
- `apps/desktop/src/lib/useRuntimeStartup.ts` — hydrate from Rust state and keep restart/re-preload behavior.
- `apps/desktop/src/lib/useRuntimeStartup.test.tsx` and `apps/desktop/src/AppRuntimeStartup.test.tsx` — no duplicate mount preload and correct error recovery.

---

### Task 1: Add a dedicated splash window and Vite entry

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Create: `apps/desktop/splashscreen.html`
- Create: `apps/desktop/src/splash.tsx`
- Create: `apps/desktop/src/splash.css`
- Modify: `apps/desktop/vite.config.ts`
- Create: `apps/desktop/src/splash.test.tsx`

**Interfaces:**
- Tauri windows: `main`, `splash`.
- Splash subscribes to `runtime-startup-status` with `{ phase: string, message: string }`.

- [ ] **Step 1: Write RED splash tests**

In `splash.test.tsx`, render the splash and assert the default visible content:

```tsx
expect(screen.getByText('Img2Model AMD')).toBeInTheDocument();
expect(screen.getByText('Starting ROCm worker...')).toBeInTheDocument();
```

Add a config test or direct JSON assertion that `main.visible` is `false`, `splash.visible` is `true`, and `splash.url` is `splashscreen.html`.

- [ ] **Step 2: Verify RED**

```bash
cd apps/desktop && npm test -- --run
```

Expected: FAIL because the splash entry/config does not exist.

- [ ] **Step 3: Configure both windows**

Set main:

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

`splashscreen.html` mounts `/src/splash.tsx` only. It must not import the main App/Three.js viewer.

- [ ] **Step 5: Implement the minimal splash**

`splash.tsx` owns local `{ phase, message }`, defaults to `Starting ROCm worker...`, subscribes with `@tauri-apps/api/event.listen('runtime-startup-status', ...)`, and renders title, status and an indeterminate progress element. Unlisten on unmount.

- [ ] **Step 6: Verify GREEN**

```bash
cd apps/desktop && npm test -- --run && npm run build
```

Expected: PASS and `dist/splashscreen.html` exists.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/tauri.conf.json apps/desktop/splashscreen.html apps/desktop/src/splash.tsx apps/desktop/src/splash.css apps/desktop/src/splash.test.tsx apps/desktop/vite.config.ts
git commit -m "feat: add startup splash window"
```

---

### Task 2: Move first health/preload lifecycle into Rust

**Files:**
- Create: `apps/desktop/src-tauri/src/startup.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**

```rust
#[derive(Clone, Debug, Default, serde::Serialize)]
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
pub struct RuntimeStartupState(pub std::sync::Mutex<RuntimeStartupSnapshot>);

pub async fn run_and_publish(app: tauri::AppHandle);
```

Tauri command:

```rust
#[tauri::command]
fn get_runtime_startup_state(app: tauri::AppHandle) -> RuntimeStartupSnapshot;
```

- [ ] **Step 1: Write RED state-machine tests**

Create a pure helper in `startup.rs` with injected callbacks:

```rust
fn run_startup_with<H, T, P>(health: H, texture_health: T, preload: P) -> RuntimeStartupSnapshot
where
    H: FnOnce() -> Result<worker::WorkerHealth, String>,
    T: FnOnce() -> Result<worker::TextureHealth, String>,
    P: FnOnce() -> Result<worker::GenerateResult, String>;
```

Tests:

```rust
#[test]
fn successful_startup_reaches_ready() {
    let snapshot = run_startup_with(
        || Ok(fake_health_ok()),
        || Ok(fake_texture_health_ok()),
        || Ok(fake_preload_result(21_000.0)),
    );
    assert_eq!(snapshot.phase, "ready");
    assert!(snapshot.shape_cache_ready);
}

#[test]
fn preload_failure_reaches_error_without_hanging() {
    let snapshot = run_startup_with(
        || Ok(fake_health_ok()),
        || Ok(fake_texture_health_ok()),
        || Err("preload failed".into()),
    );
    assert_eq!(snapshot.phase, "error");
    assert!(!snapshot.shape_cache_ready);
}
```

- [ ] **Step 2: Verify RED**

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features startup
```

Expected: FAIL because startup module/helpers do not exist.

- [ ] **Step 3: Implement pure orchestration semantics**

`run_startup_with` performs:

```text
health fails -> error
health ok -> texture health best effort
the preload callback runs
preload success -> ready + shapeCacheReady=true + model_load_ms
preload failure -> error + shapeCacheReady=false
```

Texture health failure stores `None` but does not fail startup.

- [ ] **Step 4: Implement `run_and_publish(app)`**

`run_and_publish` must:

1. emit `runtime-startup-status` / `Checking ROCm runtime...` to `splash`;
2. execute `worker::worker_health()` and best-effort `worker::worker_texture_health()` inside `spawn_blocking`;
3. emit `Loading Hunyuan3D 2 Mini...`;
4. execute `app.state::<WorkerSessionManager>().preload_shape()` inside `spawn_blocking`;
5. update `RuntimeStartupState` with the terminal snapshot;
6. emit `Ready` or `Runtime startup failed`;
7. close `splash` and show/focus `main` in both success and failure paths.

Use the same managed `WorkerSessionManager` already registered in `run()` so startup and later jobs share one persistent session/cache.

- [ ] **Step 5: Wire `.setup()` and command**

In `lib.rs`:

```rust
pub mod startup;

// ...
.manage(worker_session::WorkerSessionManager::default())
.manage(startup::RuntimeStartupState::default())
.setup(|app| {
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        startup::run_and_publish(handle).await;
    });
    Ok(())
})
```

Register `get_runtime_startup_state` in `generate_handler!`. It clones the snapshot held by `RuntimeStartupState`.

- [ ] **Step 6: Verify GREEN**

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

### Task 3: Hydrate React from Rust startup state

**Files:**
- Modify: `apps/desktop/src/lib/tauri.ts`
- Modify: `apps/desktop/src/lib/useRuntimeStartup.ts`
- Modify: `apps/desktop/src/lib/useRuntimeStartup.test.tsx`
- Modify: `apps/desktop/src/AppRuntimeStartup.test.tsx`
- Modify: `apps/desktop/src/App.tsx` only if call sites require it.

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

export function getRuntimeStartupState(): Promise<RuntimeStartupSnapshot>;
```

- [ ] **Step 1: Write RED hook tests**

Mock a ready Rust snapshot and assert:

```ts
expect(preloadHunyuanShape).not.toHaveBeenCalled();
expect(result.current.phase).toBe('ready');
expect(result.current.shapeCacheReady).toBe(true);
```

Mock an error snapshot and assert the error is exposed while `initialize()` / `ensureShapePreloaded()` remain available for explicit recovery.

- [ ] **Step 2: Verify RED**

```bash
cd apps/desktop && npm test -- --run src/lib/useRuntimeStartup.test.tsx src/AppRuntimeStartup.test.tsx
```

Expected: FAIL because the hook still starts health/preload itself on mount.

- [ ] **Step 3: Implement hydration**

Add `getRuntimeStartupState()` to `tauri.ts`. On initial hook mount, call only that command and copy snapshot fields into React state. Remove the automatic `void initialize()` mount path.

Keep `initialize()` for explicit Retry/Restart after main is visible.

- [ ] **Step 4: Preserve post-Texture re-preload**

Keep `markShapeEvicted()` and `ensureShapePreloaded()`. Returning to Shape after Paint evicts Shape may preload again; this is independent from first startup.

- [ ] **Step 5: Verify GREEN**

```bash
cd apps/desktop && npm test -- --run && npm run build
```

Expected: PASS; tests prove the first preload happens only in Rust.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/tauri.ts apps/desktop/src/lib/useRuntimeStartup.ts apps/desktop/src/lib/useRuntimeStartup.test.tsx apps/desktop/src/AppRuntimeStartup.test.tsx apps/desktop/src/App.tsx
git commit -m "fix: hydrate frontend from rust startup state"
```

---

### Task 4: Full CI and RX 6950 XT startup acceptance

**Files:** no production edits during acceptance; a discovered defect starts a RED regression test in the owning task before any fix.

- [ ] **Step 1: Run complete automated verification**

```bash
python -m unittest discover -s backends/hunyuan/tests -v
python -m unittest discover -s backends/mesh_processing/tests -v
cd apps/desktop && npm test -- --run && npm run build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
```

- [ ] **Step 2: Require CI 4/4 GREEN**

Require `frontend`, `python-worker`, `rust-core`, `desktop-windows` on one HEAD.

- [ ] **Step 3: Sync and launch on Windows**

```powershell
git pull
powershell -ExecutionPolicy Bypass -File .\scripts\setup\windows-native-rocm.ps1 -VerifyOnly
npm run tauri -- dev
```

- [ ] **Step 4: Verify startup UX**

Acceptance:

```text
0-1s: splash visible and responsive
Starting ROCm worker... / Checking ROCm runtime...
Loading Hunyuan3D 2 Mini...
splash closes
main appears with Hunyuan3D ready
first Shape: cache hit and Load approximately 0
```

The blank/frozen main window must not appear during preload.

- [ ] **Step 5: Verify failure escape path**

Use the existing runtime-path test seam or temporarily set `IMG2MODEL_WORKER` to a nonexistent path before launch. Acceptance: splash terminates, main appears with Runtime error and Restart worker; Mesh mode remains reachable.

- [ ] **Step 6: Verify Paint remains lazy**

Startup logs/activity must not contain Hunyuan Paint loading or Shape-cache eviction before Texture is requested.

- [ ] **Step 7: Acceptance conclusion**

If all checks pass, do not create a validation-only commit. If any check fails, return to the owning task, add a RED regression test, implement one fix, rerun that task, then repeat this acceptance task.
