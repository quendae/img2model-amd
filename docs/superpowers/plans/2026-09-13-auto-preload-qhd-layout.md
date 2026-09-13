# Automatic Hunyuan Preload and Compact QHD Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Hunyuan3D Shape load automatically after the desktop window appears, remove the manual runtime-check step, fix the Windows persistent-worker stdout regression, and restructure the desktop UI so the default Shape workflow fits comfortably at 2560×1440 with a wider two-column control rail and a smaller 3D viewer.

**Architecture:** Keep the existing persistent Python worker and one-heavy-pipeline cache. Add a protocol-level `preload_shape` command that loads the normal Hunyuan3D 2 Mini shape pipeline into the existing `PipelineCache` without running inference. The desktop starts health checks and preload asynchronously after React mounts; Paint remains lazy and may evict Shape. Replace Python-wide stdout redirection with tolerant Rust-side demultiplexing: valid JSONL is protocol, ordinary text is worker log noise, JSON-looking malformed lines remain protocol errors. The desktop shell widens the left rail and renders Input + Generation side-by-side, while Runtime becomes a compact collapsible panel.

**Tech Stack:** Python 3.11, Hunyuan3D-2, PyTorch ROCm/TheRock, Rust/Tauri 2, React/TypeScript, Vitest/Testing Library, CSS Grid.

**Spec:** Approved in-chat design on 2026-09-13. The user explicitly waived a separate written spec file and accepted: real Shape preload after window startup; Paint lazy; Rust stdout demux; 560–620 px two-column control area; smaller viewer; compact/collapsible Runtime; QHD default Shape workflow without vertical scrolling.

## Global Constraints

- Target runtime remains native Windows ROCm/TheRock on Radeon RX 6950 XT 16 GB; no WSL2 requirement and no silent backend fallback.
- Only one heavyweight ML pipeline is kept resident: Shape preload may be evicted when Hunyuan Paint loads.
- Shape preload uses the same model/subfolder/variant key as normal Shape generation: `tencent/Hunyuan3D-2mini`, `hunyuan3d-dit-v2-mini`, `fp16`.
- A preload failure must not prevent the app from opening or permanently block Shape generation; a normal Shape job may retry lazy loading.
- Ordinary third-party text printed on persistent-worker stdout must not terminate a job. A line that begins like JSON (`{` or `[`) but cannot be parsed remains a `protocol_error`.
- The manual `Check Hunyuan runtime` button is removed. `Restart worker` remains as recovery and restarts health + preload.
- At 2560×1440, `Shape → Model only → Light` must fit without scrolling the overall application viewport. Rails may still become scrollable on shorter windows.
- Paint remains lazy. Switching to Texture is allowed to evict Shape; returning to Shape triggers background preload again.
- Use TDD for every behavior change and keep the four CI jobs green: `frontend`, `python-worker`, `rust-core`, `desktop-windows`.

---

### Task 1: Move noisy worker stdout handling to Rust and remove the Windows `redirect_stdout` regression

**Files:**
- Modify: `apps/desktop/src-tauri/src/worker_session.rs`
- Modify: `backends/hunyuan/worker.py`
- Modify: `backends/hunyuan/tests/test_worker.py`

**Interfaces:**
- Consumes: persistent worker JSONL output from `worker.py serve`.
- Produces: `parse_worker_stdout_line(line: &str) -> Result<Option<Value>, SessionError>` where `Ok(Some(value))` is protocol JSON, `Ok(None)` is ordinary log noise, and malformed JSON-looking lines are protocol errors.

- [ ] **Step 1: Add Rust RED tests for stdout demultiplexing**

Add pure parser tests in `worker_session.rs`:

```rust
#[test]
fn plain_worker_stdout_is_log_noise_not_protocol_error() {
    assert!(parse_worker_stdout_line(
        "PointCrossAttentionEncoder INFO: pc_sharpedge_size is given"
    ).unwrap().is_none());
}

#[test]
fn json_worker_stdout_is_protocol_event() {
    let value = parse_worker_stdout_line(r#"{"event":"progress","job_id":"job-1"}"#)
        .unwrap()
        .unwrap();
    assert_eq!(value["event"], "progress");
}

#[test]
fn malformed_json_looking_stdout_is_protocol_error() {
    let error = parse_worker_stdout_line("{not-json").unwrap_err();
    assert_eq!(error.kind, "protocol_error");
}
```

- [ ] **Step 2: Run Rust tests and verify RED**

Run through CI or locally:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
```

Expected: compile/test failure because `parse_worker_stdout_line` does not exist.

- [ ] **Step 3: Implement Rust-side demultiplexing and log tail**

Add a helper near `read_json_line`:

```rust
fn parse_worker_stdout_line(line: &str) -> Result<Option<Value>, SessionError> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(value) => Ok(Some(value)),
        Err(error) if trimmed.starts_with('{') || trimmed.starts_with('[') => {
            Err(SessionError::protocol(format!(
                "Persistent worker emitted malformed JSON stdout: {error}; line={trimmed:?}"
            )))
        }
        Err(_) => Ok(None),
    }
}
```

Change `read_json_line()` to loop until it receives `Some(value)`. Store plain text lines in a bounded `stdout_log_tail` (`VecDeque<String>`, same `STDERR_TAIL_LINES` limit) and include that tail in crash diagnostics alongside stderr. Do not convert plain text into progress events.

- [ ] **Step 4: Revert Python-wide stdout redirection**

In `backends/hunyuan/worker.py`, remove `contextlib`, `protocol_stdout`, `protocol_emit`, and `redirect_stdout`. Restore `run_serve()` to direct dispatch using the established `_emit_payload` JSON emitter:

```python
def run_serve(_args: argparse.Namespace) -> int:
    cache = PipelineCache(event_sink=_emit_payload)
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("Serve command must be a JSON object")
        except Exception as exc:
            print(json.dumps({
                "event": "error",
                "ok": False,
                "error_kind": "protocol_error",
                "error": f"{type(exc).__name__}: {exc}",
            }, ensure_ascii=False), flush=True)
            continue
        if not dispatch_serve_command(message, cache=cache):
            return 0
    cache.clear()
    return 0
```

- [ ] **Step 5: Replace the Python regression expectation**

Replace `test_serve_keeps_third_party_prints_off_json_stdout` with a test that allows the third-party text line but verifies the protocol event is still valid JSON and carries the correct `job_id`:

```python
def test_serve_protocol_survives_third_party_stdout_noise(self) -> None:
    # fake dispatch prints the PointCrossAttentionEncoder line, then emits completed
    # stdout must contain the noise plus a final parseable protocol JSON event
    payload = json.loads(stdout.getvalue().strip().splitlines()[-1])
    self.assertEqual(payload["event"], "completed")
    self.assertEqual(payload["job_id"], "job-noisy")
```

- [ ] **Step 6: Verify GREEN and commit**

Run:

```powershell
python -m unittest discover -s backends/hunyuan/tests -v
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
```

Expected: all worker and Rust tests PASS.

Commit:

```bash
git add backends/hunyuan/worker.py backends/hunyuan/tests/test_worker.py apps/desktop/src-tauri/src/worker_session.rs
git commit -m "fix: tolerate Hunyuan stdout noise in persistent worker"
```

---

### Task 2: Add a real Shape preload command to the persistent worker

**Files:**
- Modify: `backends/hunyuan/worker_base.py`
- Modify: `backends/hunyuan/tests/test_worker.py`
- Modify: `apps/desktop/src-tauri/src/worker_session.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src/lib/tauri.ts`

**Interfaces:**
- Produces Python command: `{"command":"preload_shape","job_id":"...","request":{model?,subfolder?,variant?}}`.
- Produces Rust: `WorkerSessionManager::preload_shape() -> Result<GenerateResult, String>`.
- Produces Tauri: `preload_hunyuan_shape`.
- Produces TypeScript: `preloadHunyuanShape(): Promise<GenerateResult>`.

- [ ] **Step 1: Add Python RED tests**

Add tests asserting that `preload_shape` uses the normal shape cache and that a second preload is a cache hit:

```python
def test_preload_shape_reuses_shape_pipeline_cache(self) -> None:
    module = self.load_worker_module()
    replies: list[dict[str, object]] = []
    cache = module.PipelineCache(event_sink=replies.append)
    built: list[str] = []

    original = module._base.build_shape_pipeline
    module._base.build_shape_pipeline = lambda args: built.append(args.model) or object()
    try:
        message = {"command": "preload_shape", "job_id": "job-preload", "request": {}}
        self.assertTrue(module.dispatch_serve_command(message, cache=cache, emit_fn=replies.append))
        self.assertTrue(module.dispatch_serve_command({**message, "job_id": "job-preload-2"}, cache=cache, emit_fn=replies.append))
    finally:
        module._base.build_shape_pipeline = original

    self.assertEqual(len(built), 1)
    completed = [item for item in replies if item.get("event") == "completed"]
    self.assertFalse(completed[0]["cache_hit"])
    self.assertTrue(completed[-1]["cache_hit"])
```

- [ ] **Step 2: Verify Python RED**

Run:

```powershell
python -m unittest discover -s backends/hunyuan/tests -v
```

Expected: failure because `preload_shape` is unsupported.

- [ ] **Step 3: Implement Python preload using the existing cache key**

In `worker_base.py` add:

```python
def _preload_shape_namespace(request: dict[str, Any]) -> argparse.Namespace:
    return argparse.Namespace(
        model=request.get("model") or "tencent/Hunyuan3D-2mini",
        subfolder=request.get("subfolder") or "hunyuan3d-dit-v2-mini",
        variant=request.get("variant") or "fp16",
    )


def run_preload_shape(args: argparse.Namespace, cache: PipelineCache) -> int:
    started = time.perf_counter()
    try:
        emit("progress", ok=True, stage="preloading_shape", progress=0.25)
        pipeline, cache_hit = cache.get_shape_pipeline(
            lambda: build_shape_pipeline(args),
            (args.model, args.subfolder, args.variant),
        )
        _ = pipeline
        load_ms = (time.perf_counter() - started) * 1000.0
        emit(
            "completed",
            ok=True,
            stage="shape_preloaded",
            progress=1.0,
            cache_hit=cache_hit,
            cache_kind="shape",
            model=args.model,
            subfolder=args.subfolder,
            model_load_ms=round(load_ms, 3),
        )
        return 0
    except Exception as exc:
        emit(
            "error",
            ok=False,
            stage="preloading_shape",
            error_kind=classify_generation_error(exc),
            error=f"{type(exc).__name__}: {exc}",
        )
        return 1
```

Handle `command == "preload_shape"` in `dispatch_serve_command` before normal `shape`, requiring a request object or `{}` and calling `run_preload_shape`.

- [ ] **Step 4: Add Rust RED tests and command builder**

Add:

```rust
fn preload_shape_command(job_id: &str) -> Value {
    json!({
        "command": "preload_shape",
        "job_id": job_id,
        "request": {},
    })
}
```

First write a test asserting `command == "preload_shape"` and `job_id` is preserved; run `cargo test` and verify RED before implementation.

- [ ] **Step 5: Implement Rust session + Tauri command**

Add `WorkerSession::preload_shape()` using `run_generation(preload_shape_command(...))`, then manager method:

```rust
pub fn preload_shape(&self) -> Result<GenerateResult, String> {
    let mut guard = self.inner.lock()
        .map_err(|_| "Persistent worker session lock is poisoned.".to_string())?;
    let result = self.get_or_spawn(&mut guard)?.preload_shape();
    match result {
        Ok(result) => Ok(result),
        Err(error) => {
            Self::invalidate(&mut guard);
            Ok(failure_result(error.kind, error.message))
        }
    }
}
```

Expose in `lib.rs`:

```rust
#[tauri::command]
async fn preload_hunyuan_shape(app: tauri::AppHandle) -> Result<worker::GenerateResult, String> {
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        app_handle.state::<worker_session::WorkerSessionManager>().preload_shape()
    })
    .await
    .map_err(|error| format!("Shape preload task failed: {error}"))?
}
```

Register it in `generate_handler!`.

- [ ] **Step 6: Add TypeScript bridge**

In `tauri.ts` add:

```ts
export async function preloadHunyuanShape(): Promise<GenerateResult> {
  if (!isTauri()) {
    throw new Error('Shape preload requires the Tauri desktop runtime.');
  }
  return invoke<GenerateResult>('preload_hunyuan_shape');
}
```

- [ ] **Step 7: Verify GREEN and commit**

Run worker tests, Rust tests, and frontend type build.

Commit:

```bash
git add backends/hunyuan/worker_base.py backends/hunyuan/tests/test_worker.py apps/desktop/src-tauri/src/worker_session.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/lib/tauri.ts
git commit -m "feat: preload Hunyuan shape pipeline"
```

---

### Task 3: Automatically initialize Hunyuan after the window mounts

**Files:**
- Create: `apps/desktop/src/lib/useRuntimeStartup.ts`
- Create: `apps/desktop/src/lib/useRuntimeStartup.test.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/App.test.tsx`
- Modify: `apps/desktop/src/components/DiagnosticsPanel.tsx`

**Interfaces:**
- Produces hook state:

```ts
export type RuntimePhase = 'starting' | 'checking' | 'preloading' | 'ready' | 'error';

export interface RuntimeStartupState {
  phase: RuntimePhase;
  health: WorkerHealth | null;
  textureHealth: TextureHealth | null;
  shapeCacheReady: boolean;
  shapePreloadMs?: number;
  error: string | null;
  initialize: () => Promise<void>;
  ensureShapePreloaded: () => Promise<void>;
  markShapeEvicted: () => void;
}
```

- Consumes: `getHunyuanHealth`, `getHunyuanTextureHealth`, `preloadHunyuanShape`.

- [ ] **Step 1: Write hook RED tests**

Use `renderHook` and `act` to verify mount initialization sequence:

```ts
it('checks runtime and preloads Shape automatically', async () => {
  getHunyuanHealth.mockResolvedValue({ ok: true });
  getHunyuanTextureHealth.mockResolvedValue({ ok: true });
  preloadHunyuanShape.mockResolvedValue({
    ok: true,
    event: 'completed',
    cache_hit: false,
    model_load_ms: 17000,
  });

  const { result } = renderHook(() => useRuntimeStartup());
  await waitFor(() => expect(result.current.phase).toBe('ready'));
  expect(getHunyuanHealth).toHaveBeenCalledOnce();
  expect(preloadHunyuanShape).toHaveBeenCalledOnce();
  expect(result.current.shapeCacheReady).toBe(true);
});
```

Also test: health failure -> `error` but hook remains usable; preload failure -> `error`, `shapeCacheReady=false`; `markShapeEvicted()` then `ensureShapePreloaded()` calls preload again.

- [ ] **Step 2: Verify hook RED**

Run:

```powershell
npm test -- --run apps/desktop/src/lib/useRuntimeStartup.test.tsx
```

Expected: FAIL because hook does not exist.

- [ ] **Step 3: Implement the startup hook**

Implement mount `useEffect(() => { void initialize(); }, [initialize])`. `initialize()` sets `checking`, obtains shape and texture health, then if shape health is OK sets `preloading` and awaits `preloadHunyuanShape()`. A failed texture-health probe must not block Shape preload. A failed preload sets `phase='error'` but does not mutate health to false.

- [ ] **Step 4: Write App RED tests for automatic behavior and removed manual check**

Update hoisted mocks to include `preloadHunyuanShape`. Add assertions:

```ts
it('starts Hunyuan automatically and has no manual runtime-check button', async () => {
  render(<App />);
  await waitFor(() => expect(mocks.preloadHunyuanShape).toHaveBeenCalledOnce());
  expect(screen.queryByRole('button', { name: /check hunyuan runtime/i })).toBeNull();
});

it('restart worker starts health and Shape preload again', async () => {
  render(<App />);
  await waitFor(() => expect(mocks.preloadHunyuanShape).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: /restart worker/i }));
  await waitFor(() => expect(mocks.preloadHunyuanShape).toHaveBeenCalledTimes(2));
});
```

- [ ] **Step 5: Integrate hook into App**

Replace `health`, `textureHealth`, `healthLoading`, and `checkHealth()` ownership in `App.tsx` with `useRuntimeStartup()`. Keep system diagnostics separate. Header copy is derived from phase:

```ts
const runtimeLabel = runtime.phase === 'preloading'
  ? 'Loading Hunyuan3D…'
  : runtime.phase === 'ready'
    ? 'Hunyuan3D ready'
    : runtime.phase === 'error'
      ? 'Runtime error'
      : 'Starting worker…';
```

When starting a Texture-only workflow call `runtime.markShapeEvicted()` before/after the texture request. For Shape+Texture, mark Shape evicted after the combined workflow resolves. Add an effect that calls `ensureShapePreloaded()` when `workflowMode === 'shape'`, `!job.busy`, health is OK, and `shapeCacheReady` is false.

`restartWorker()` becomes:

```ts
await restartHunyuanWorker();
job.markWorkerRestarted();
await runtime.initialize();
```

- [ ] **Step 6: Simplify DiagnosticsPanel**

Remove `onHealthCheck` and the large health button. Accept `textureHealth` and `runtimePhase`; render a compact summary with a `<details>` body. Keep the small refresh icon only for host diagnostics.

- [ ] **Step 7: Verify GREEN and commit**

Run:

```powershell
npm test -- --run
npm run build
```

Commit:

```bash
git add apps/desktop/src/lib/useRuntimeStartup.ts apps/desktop/src/lib/useRuntimeStartup.test.tsx apps/desktop/src/App.tsx apps/desktop/src/App.test.tsx apps/desktop/src/components/DiagnosticsPanel.tsx
git commit -m "feat: initialize Hunyuan automatically on startup"
```

---

### Task 4: Rebuild the desktop shell for QHD with a two-column control rail

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/components/GenerationPanel.tsx`
- Modify: `apps/desktop/src/components/DiagnosticsPanel.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/App.test.tsx`
- Modify or create focused component tests under `apps/desktop/src/components/*.test.tsx`

**Interfaces:**
- No backend contract changes.
- Produces stable layout class names: `control-rail`, `control-column`, `cleanup-presets`, `texture-profile-control`, `runtime-details`.

- [ ] **Step 1: Add frontend RED tests for the intended compact structure**

Mock/Input tests should assert the left control area contains two columns and the runtime check button is absent. Add GenerationPanel tests asserting three workflow tabs occupy one logical row and cleanup presets use the compact four-option control class.

Example:

```ts
expect(screen.getByTestId('control-rail').className).toContain('control-rail');
expect(screen.getByRole('tab', { name: 'Shape' })).toBeTruthy();
expect(screen.getByRole('tab', { name: 'Texture' })).toBeTruthy();
expect(screen.getByRole('tab', { name: 'Mesh' })).toBeTruthy();
```

- [ ] **Step 2: Verify frontend RED**

Run `npm test -- --run`. Expected failures on missing structure/classes.

- [ ] **Step 3: Change shell structure**

In `App.tsx`, keep InputPanel and GenerationPanel inside the left rail but wrap them as two side-by-side control columns:

```tsx
<aside className="left-rail control-rail" data-testid="control-rail">
  <div className="control-column input-column">
    <InputPanel ... />
  </div>
  <div className="control-column generation-column">
    <GenerationPanel ... />
  </div>
</aside>
```

Do not move Activity out of the right rail in this milestone.

- [ ] **Step 4: Compact GenerationPanel controls**

Make mode tabs three columns. Add `cleanup-presets` to cleanup segmented control. Replace the four large Texture cards with one compact four-option control and render only the selected profile description beneath it:

```tsx
<div className="segmented-control texture-profile-control" aria-label="Texture profile">
  {textureProfiles.map((value) => (
    <button ...>{textureProfileLabels[value]}</button>
  ))}
</div>
<small className="profile-description">{textureProfileDescriptions[textureProfile]}</small>
```

Remove the always-visible green backend note for native ROCm; only show the warning note for non-executable backends.

- [ ] **Step 5: Apply QHD desktop CSS**

Use a compact header and wider left rail:

```css
.app-shell { grid-template-rows: 56px minmax(0, 1fr); }
.app-header { padding: 0 18px; }

.workspace {
  grid-template-columns: minmax(560px, 620px) minmax(560px, 1fr) 320px;
}

.left-rail.control-rail {
  display: grid;
  grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr);
  align-items: start;
  gap: 10px;
  padding: 10px;
}

.control-column { min-width: 0; }
.image-drop { height: 155px; aspect-ratio: auto; }
.panel { padding: 12px; }
.panel-heading { margin-bottom: 10px; }
.mode-tabs { grid-template-columns: repeat(3, 1fr); margin-bottom: 8px; }
.cleanup-presets { grid-template-columns: repeat(4, 1fr); }
.texture-profile-control { grid-template-columns: repeat(4, 1fr); }
```

Keep the right rail at ~320 px; Runtime `<details>` is collapsed by default. The 3D viewer automatically becomes smaller because the control rail consumes more width.

- [ ] **Step 6: Add responsive fallbacks**

At widths where 560 + viewer + 320 no longer fits (recommended breakpoint around 1500 px), switch the left rail back to a single column and allow rail scrolling. At `max-width: 720px`, preserve the existing stacked mobile layout.

- [ ] **Step 7: Verify frontend GREEN and commit**

Run all frontend tests and build.

Commit:

```bash
git add apps/desktop/src/App.tsx apps/desktop/src/components/GenerationPanel.tsx apps/desktop/src/components/DiagnosticsPanel.tsx apps/desktop/src/styles.css apps/desktop/src/App.test.tsx apps/desktop/src/components
git commit -m "feat: compact desktop controls for QHD"
```

---

### Task 5: Full regression verification and RX 6950 XT acceptance

**Files:**
- Modify after hardware run: `docs/benchmarks/2026-09-13-rx6950xt-preload-cleanup.md`

**Interfaces:**
- Validates all preceding contracts; no new production API.

- [ ] **Step 1: Run complete automated verification**

Require all of:

```powershell
python -m unittest discover -s backends/hunyuan/tests -v
python -m unittest discover -s backends/mesh_processing/tests -v
npm test -- --run
npm run build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

CI must show `frontend`, `python-worker`, `rust-core`, `desktop-windows` all success on the same HEAD.

- [ ] **Step 2: Sync the Windows runtime**

```powershell
git fetch origin
git switch feat/game-ready-mesh-cleanup
git pull
powershell -ExecutionPolicy Bypass -File .\scripts\setup\windows-native-rocm.ps1 -VerifyOnly
npm run tauri -- dev
```

- [ ] **Step 3: Verify startup preload on RX 6950 XT**

Acceptance:
- App window appears before Hunyuan finishes loading.
- Header transitions `Starting worker…` / `Loading Hunyuan3D…` → `Hunyuan3D ready`.
- No `Check Hunyuan runtime` button exists.
- Startup preload takes roughly the old cold-load time (~17 s is a reference, not a pass/fail limit).
- First `Shape → Model only → Light` shows Shape `cache hit` and `Load` near zero, then non-zero inference.
- No `OSError: [Errno 22] Invalid argument` and no `non-JSON stdout` failure.

- [ ] **Step 4: Verify eviction/reload behavior**

Run Texture once so Paint evicts Shape, then return to Shape. Confirm background preload begins again without pressing a button and the next Shape job is a cache hit.

- [ ] **Step 5: Verify QHD layout manually at 2560×1440**

Acceptance:
- Header, two-column left controls, viewer, and right rail all visible simultaneously.
- `Shape → Model only → Light` controls and Generate button are visible without scrolling the application viewport.
- Input preview is compact (~155 px high).
- Shape / Texture / Mesh tabs are one row.
- Off / Light / Game-ready / Aggressive are one row at QHD.
- Viewer remains usable for orbit/zoom but is visibly smaller than before.
- Runtime is collapsed by default and Activity remains readable.

- [ ] **Step 6: Re-run cleanup acceptance**

Repeat the previously blocked tests:
1. Shape → Model only → Light.
2. Shape → Model + texture → Light.
3. Mesh → Game-ready with Before/After.
4. Mesh → Aggressive.

Capture Activity values for cleanup time, triangles/vertices, components removed, welded vertices, spikes adjusted, warnings, and texture cache timings.

- [ ] **Step 7: Record benchmark and commit**

Write measured startup preload, first Shape cache behavior, cleanup metrics, texture metrics, and QHD acceptance outcome to `docs/benchmarks/2026-09-13-rx6950xt-preload-cleanup.md`.

Commit:

```bash
git add docs/benchmarks/2026-09-13-rx6950xt-preload-cleanup.md
git commit -m "docs: record RX 6950 XT preload and cleanup validation"
```
