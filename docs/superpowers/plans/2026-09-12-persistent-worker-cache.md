# Persistent Worker Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tune Auto to Balanced on the validated 16 GiB Radeon target, persist Hunyuan generation inside one Tauri-owned Python worker session, reuse Hunyuan Paint across repeated texture jobs, and expose explicit cache/restart controls without regressing OOM recovery or streamed progress.

**Architecture:** Keep the existing one-shot Python CLI for setup/smoke tests, but add a `serve` JSONL protocol for desktop generation. A dedicated Rust session manager owns one Python child, serializes jobs, routes `job_id`-tagged events into the existing Tauri channels, and invalidates/restarts the session on crash or protocol failure. Python owns a bounded heavyweight pipeline cache: repeated jobs of the same kind may reuse the cached pipeline, while switching between Shape and Texture evicts the other heavyweight pipeline by default.

**Tech Stack:** Python 3.11, PyTorch ROCm/TheRock, Hunyuan3D-2 Mini, Hunyuan Paint, Rust 2021, Tauri 2, React 19, TypeScript 5.9, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-12-persistent-worker-and-uv-roadmap-design.md`

## Global Constraints

- Primary hardware target remains Radeon RX 6950 XT with approximately 16 GiB dedicated VRAM on Windows native ROCm/TheRock.
- `Auto` on approximately 16 GiB resolves to **Balanced / 20,000 working triangles**.
- Safe remains 10,000 triangles and is the explicit OOM recovery target.
- Balanced remains 20,000 triangles; Quality remains 40,000 triangles.
- Safe/Balanced/Quality keep CPU model offload and maximum attention slicing in this milestone.
- `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` remains the default allocator policy unless the user supplied another value.
- Shape and Texture remain separate logical jobs and a texture failure must never delete a successful Shape.
- No automatic replay after OOM/crash and no silent compute-backend fallback.
- Only one generation job may execute at a time inside one desktop worker session.
- Repeated Texture may reuse Hunyuan Paint, but Shape and Paint are not both kept heavyweight-resident by default.
- One-shot CLI commands remain supported for health/setup/smoke tests.
- UV editor implementation, TRELLIS.2, Vulkan inference, SageAttention, Triton, FlashAttention, quantization, Paint3D and MVPaint are out of scope for this branch.

---

## File Structure

### Create
- `apps/desktop/src-tauri/src/worker_session.rs` — persistent child lifecycle, JSONL command protocol, job serialization, crash/protocol invalidation, restart/clear-cache control.
- `docs/benchmarks/2026-09-12-rx6950xt-texture-baseline.md` — measured Safe/Balanced/Quality baseline and later cold/warm cache results.

### Modify
- `backends/hunyuan/worker.py` — Auto policy, reusable pipeline cache, `serve` protocol, cache events, cold/warm timings.
- `backends/hunyuan/tests/test_worker.py` — profile, JSONL protocol, cache hit/eviction, OOM cleanup tests.
- `apps/desktop/src-tauri/src/worker.rs` — shared request/result/event protocol types, one-shot CLI compatibility helpers, persistent command payload conversion.
- `apps/desktop/src-tauri/src/lib.rs` — Tauri managed session state and persistent generation commands; restart/clear-cache commands.
- `apps/desktop/src/lib/tauri.ts` — restart/clear-cache client functions and cache/timing metadata types.
- `apps/desktop/src/lib/useGenerationJob.ts` — worker crash state, cache/timing propagation, clear-cache before OOM retry where required.
- `apps/desktop/src/lib/useGenerationJob.test.ts` — recovery and cache metadata regression tests.
- `apps/desktop/src/App.tsx` — explicit Restart worker / Clear cache actions and cold/warm timing display.
- `apps/desktop/src/styles.css` — small worker-control/cache status styles only.

No new third-party dependency is required.

---

### Task 1: Retune Auto and record the validated RX 6950 XT baseline

**Files:**
- Modify: `backends/hunyuan/worker.py`
- Modify: `backends/hunyuan/tests/test_worker.py`
- Create: `docs/benchmarks/2026-09-12-rx6950xt-texture-baseline.md`

**Interfaces:**
- `resolve_texture_profile("auto", total_vram_gib)` returns Balanced for the current <=16.5 GiB policy window.
- Safe remains unchanged and is still the retry profile.

- [ ] **Step 1: Change the profile-policy test first**

Replace the existing Auto-at-16-GiB expectation with:

```py
def test_auto_texture_profile_is_balanced_at_16_gib(self) -> None:
    module = self.load_worker_module()
    resolved = module.resolve_texture_profile("auto", 15.98)
    self.assertEqual(resolved["name"], "balanced")
    self.assertEqual(resolved["max_faces"], 20_000)
    self.assertTrue(resolved["cpu_offload"])
    self.assertEqual(resolved["attention_slicing"], "max")
```

Keep an explicit Safe test:

```py
def test_safe_texture_profile_remains_10k(self) -> None:
    module = self.load_worker_module()
    resolved = module.resolve_texture_profile("safe", 15.98)
    self.assertEqual(resolved["max_faces"], 10_000)
```

- [ ] **Step 2: Run the Python worker suite and verify the changed test fails**

Run:

```bash
python -m unittest discover -s backends/hunyuan/tests -v
```

Expected: Auto-at-16-GiB test fails because current code still resolves Safe.

- [ ] **Step 3: Update the resolver minimally**

Use:

```py
def resolve_texture_profile(profile: str, total_vram_gib: float) -> dict[str, Any]:
    resolved_name = "balanced" if profile == "auto" else profile
    if resolved_name not in TEXTURE_PROFILES:
        raise ValueError(f"Unsupported texture profile: {profile}")
    return {"name": resolved_name, **TEXTURE_PROFILES[resolved_name]}
```

Do not promote Auto to Quality on larger cards in this milestone.

- [ ] **Step 4: Add the benchmark document**

Record exactly the validated measurements:

```markdown
# RX 6950 XT Hunyuan Paint baseline — 2026-09-12

Source generated mesh: 604,308 triangles
GPU: AMD Radeon RX 6950 XT, ~16 GiB
Runtime: Windows native ROCm/TheRock

| Profile | Working triangles | Texture total | Inference | Result |
| Safe | 10,000 | 1:20 | 28 s | Success |
| Balanced | 20,000 | 1:07 | 31 s | Success |
| Quality | 40,000 | 1:18 | 41 s | Success |

Combined Auto→Safe run before retuning:
- Shape: 2:49
- Texture: 1:20
- Total: 4:09

Decision: Auto on this hardware class changes to Balanced 20k. Safe remains the OOM recovery profile.
```

Leave a `Cold/warm persistent-worker results` section with a Markdown table containing explicit columns but no invented measurements; mark rows `Not measured yet` rather than TODO.

- [ ] **Step 5: Run the Python suite again**

```bash
python -m unittest discover -s backends/hunyuan/tests -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backends/hunyuan/worker.py backends/hunyuan/tests/test_worker.py docs/benchmarks/2026-09-12-rx6950xt-texture-baseline.md
git commit -m "perf: tune auto texture profile for 16gb radeon"
```

---

### Task 2: Add a reusable Python pipeline cache and `serve` JSONL protocol

**Files:**
- Modify: `backends/hunyuan/worker.py`
- Modify: `backends/hunyuan/tests/test_worker.py`

**Interfaces:**
- Produces `PipelineCache` with `get_shape_pipeline(...)`, `get_texture_pipeline(...)`, `clear()`, `clear_shape()`, `clear_texture()`.
- Produces `run_serve(args) -> int`.
- `serve` reads newline-delimited JSON from stdin and writes only newline-delimited JSON events to stdout.
- Supported commands: `ping`, `shape`, `texture`, `clear_cache`, `shutdown`.
- Every serve request and emitted event carries `job_id`.

- [ ] **Step 1: Add failing cache-policy tests**

Test with fake loader callbacks so no ML runtime is required:

```py
def test_pipeline_cache_reuses_texture_and_evicts_shape(self) -> None:
    module = self.load_worker_module()
    events = []
    cache = module.PipelineCache(event_sink=events.append)
    shape = object()
    texture = object()

    self.assertIs(cache.get_shape_pipeline(lambda: shape), shape)
    self.assertIs(cache.get_shape_pipeline(lambda: object()), shape)
    self.assertIs(cache.get_texture_pipeline(lambda: texture), texture)
    self.assertIsNone(cache.shape_pipeline)
    self.assertIs(cache.texture_pipeline, texture)

    stages = [event["stage"] for event in events]
    self.assertIn("cache_hit", stages)
    self.assertIn("evicted_shape", stages)
```

Add `clear()` test asserting both slots become `None` and cleanup callback runs.

- [ ] **Step 2: Add failing JSONL serve tests**

Add a pure helper test for command parsing/dispatch without launching models:

```py
def test_serve_ping_returns_same_job_id(self) -> None:
    module = self.load_worker_module()
    replies = []
    keep_running = module.dispatch_serve_command(
        {"command": "ping", "job_id": "job-1"},
        cache=module.PipelineCache(),
        emit_fn=replies.append,
    )
    self.assertTrue(keep_running)
    self.assertEqual(replies[-1]["job_id"], "job-1")
    self.assertEqual(replies[-1]["event"], "pong")
```

Also cover `clear_cache`, `shutdown`, unknown command, and missing `job_id`.

- [ ] **Step 3: Run worker tests and verify failures**

```bash
python -m unittest backends.hunyuan.tests.test_worker -v
```

Expected: FAIL because cache/serve helpers do not exist.

- [ ] **Step 4: Implement `PipelineCache` with bounded residency**

Use one class that owns `shape_pipeline` and `texture_pipeline`. Before loading Shape, evict Texture; before loading Texture, evict Shape. Cleanup must execute:

```py
import gc

def release_torch_memory() -> None:
    gc.collect()
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
```

Cache methods return `(pipeline, cache_hit: bool)` internally or emit `cache_hit` / `cache_miss` through the provided event sink.

- [ ] **Step 5: Refactor Shape/Texture internals to accept an optional cache**

Keep current one-shot CLI behavior unchanged when `cache is None`.

Extract loaders:

```py
def build_shape_pipeline(args: argparse.Namespace) -> Any: ...
def build_texture_pipeline(args: argparse.Namespace) -> Any: ...
```

Then `run_generate(args, cache=None)` and `run_texture(args, cache=None)` obtain the pipeline from the cache when provided. On OOM, clear the affected cached pipeline before emitting the terminal error.

- [ ] **Step 6: Add job-id aware event context**

Extend `emit()` so serve mode can attach `job_id` without changing all existing one-shot call sites. One acceptable implementation is a module-level single-threaded `_CURRENT_JOB_ID` set only while dispatching one serve job:

```py
_CURRENT_JOB_ID: str | None = None

def emit(event: str, **values: Any) -> None:
    payload = {"event": event, **values}
    if _CURRENT_JOB_ID is not None:
        payload["job_id"] = _CURRENT_JOB_ID
    print(json.dumps(payload, ensure_ascii=False), flush=True)
```

Reset it in `finally` after every dispatched job.

- [ ] **Step 7: Implement `dispatch_serve_command()` and `run_serve()`**

`run_serve()` loops over `sys.stdin`, rejects malformed JSON with a terminal protocol error for that line, and exits cleanly on EOF or `shutdown`.

`dispatch_serve_command()` validates `command` and `job_id`, creates an `argparse.Namespace` with the same defaults as the existing CLI parser, and calls the shared generation functions using the persistent cache.

`ping` response must include a protocol version, e.g.:

```json
{"job_id":"job-1","event":"pong","ok":true,"protocol_version":1}
```

- [ ] **Step 8: Add the parser entry**

```py
serve = subparsers.add_parser("serve", help="Run the persistent JSONL desktop worker")
serve.set_defaults(func=run_serve)
```

- [ ] **Step 9: Run all worker tests**

```bash
python -m unittest discover -s backends/hunyuan/tests -v
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add backends/hunyuan/worker.py backends/hunyuan/tests/test_worker.py
git commit -m "feat: add persistent hunyuan worker protocol"
```

---

### Task 3: Add the Rust persistent worker session manager

**Files:**
- Create: `apps/desktop/src-tauri/src/worker_session.rs`
- Modify: `apps/desktop/src-tauri/src/worker.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Produces `WorkerSessionManager::run_shape(request, on_event)`.
- Produces `WorkerSessionManager::run_texture(request, on_event)`.
- Produces `WorkerSessionManager::restart()` and `clear_cache()`.
- Uses existing `GenerateRequest`, `TextureRequest`, `GenerateResult`, `WorkerProgressEvent`.

- [ ] **Step 1: Add Rust protocol tests before integration**

In `worker_session.rs` test pure serialization helpers first:

```rust
#[test]
fn shape_command_has_job_id_and_request() {
    let value = shape_command("job-7", &fixture_shape_request());
    assert_eq!(value["command"], "shape");
    assert_eq!(value["job_id"], "job-7");
    assert_eq!(value["request"]["steps"], 20);
}
```

Add equivalent Texture and terminal-event matching tests. A mismatched `job_id` must be rejected.

- [ ] **Step 2: Run Rust tests and verify failure**

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
```

Expected: FAIL until the new module/helpers exist.

- [ ] **Step 3: Implement the owned child session**

`WorkerSession` owns:

```rust
struct WorkerSession {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    next_job_id: u64,
}
```

Spawn:

```rust
Command::new(configured_python())
    .arg(configured_worker_path()?)
    .arg("serve")
    .env("PYTORCH_CUDA_ALLOC_CONF", allocator)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
```

Drain stderr on a dedicated thread and retain only the last bounded number of lines (for example 200) in `stderr_tail`.

- [ ] **Step 4: Implement handshake and job routing**

Immediately after spawn, send `ping` and require `pong` with protocol version 1. `run_job()` must:

1. allocate a `job-N` id,
2. write exactly one JSON line and flush,
3. read stdout lines,
4. parse JSON,
5. reject mismatched `job_id`, malformed stdout and EOF before terminal event,
6. route `progress`, `cache`, `completed`, `error` events to the callback,
7. return the terminal `GenerateResult` for `completed/error`.

A protocol failure kills and invalidates the child before returning an error.

- [ ] **Step 5: Implement `WorkerSessionManager` with one-job serialization**

Use an internal `Mutex<Option<WorkerSession>>`. `with_session()` lazily spawns on first generation request. `restart()` gracefully sends shutdown if possible, kills as fallback, and clears the Option. `clear_cache()` sends `clear_cache` through the same protocol.

No automatic retry of a generation job is allowed if the child crashes.

- [ ] **Step 6: Keep one-shot worker helpers for diagnostics/tests**

Do not remove `worker_health()`, `worker_texture_health()`, argument builders or one-shot generation helpers yet. Desktop commands will switch in the next step, while CLI/setup tests continue to use the existing path.

Extend `WorkerProgressEvent` / `GenerateResult` optional fields as needed for:

```rust
pub cache_hit: Option<bool>,
pub cache_kind: Option<String>,
pub model_load_ms: Option<f64>,
pub inference_ms: Option<f64>,
pub preprocess_ms: Option<f64>,
pub export_ms: Option<f64>,
```

- [ ] **Step 7: Run Rust tests**

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src-tauri/src/worker_session.rs apps/desktop/src-tauri/src/worker.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat: add tauri persistent worker session"
```

---

### Task 4: Switch desktop generation commands to the persistent session

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/worker_session.rs`

**Interfaces:**
- Tauri commands keep frontend names `generate_shape` and `texture_mesh`.
- Adds `restart_hunyuan_worker` and `clear_hunyuan_worker_cache`.

- [ ] **Step 1: Register managed state**

Add:

```rust
pub mod worker_session;
```

and in `run()`:

```rust
.manage(worker_session::WorkerSessionManager::default())
```

- [ ] **Step 2: Route blocking work through an `AppHandle`**

Because `spawn_blocking` needs `'static` data, pass `tauri::AppHandle` to the command, clone it, and retrieve state inside the closure:

```rust
let app = app.clone();
tauri::async_runtime::spawn_blocking(move || {
    let manager = app.state::<worker_session::WorkerSessionManager>();
    manager.run_shape(request, |event| { let _ = on_event.send(event); })
})
```

Use the same pattern for Texture.

- [ ] **Step 3: Add control commands**

```rust
#[tauri::command]
fn restart_hunyuan_worker(app: tauri::AppHandle) -> Result<(), String> { ... }

#[tauri::command]
fn clear_hunyuan_worker_cache(app: tauri::AppHandle) -> Result<(), String> { ... }
```

Register both in `invoke_handler!`.

- [ ] **Step 4: Normalize worker crash result**

If a live session exits unexpectedly, return a `GenerateResult` error with:

```text
error_kind = "worker_crashed"
stage = "worker"
```

and invalidate the session. Do not replay the job.

- [ ] **Step 5: Run Rust tests and Windows cargo check via CI/local command**

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/worker_session.rs
git commit -m "feat: route desktop generation through persistent worker"
```

---

### Task 5: Expose cache/restart controls and cold/warm metadata to React

**Files:**
- Modify: `apps/desktop/src/lib/tauri.ts`
- Modify: `apps/desktop/src/lib/useGenerationJob.ts`
- Modify: `apps/desktop/src/lib/useGenerationJob.test.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Produces `restartHunyuanWorker(): Promise<void>`.
- Produces `clearHunyuanWorkerCache(): Promise<void>`.
- Hook exposes `workerNeedsRestart`, `cacheHit`, and worker timing metadata where known.

- [ ] **Step 1: Extend frontend protocol types**

Add optional result/progress fields matching Rust/Python:

```ts
cache_hit?: boolean | null;
cache_kind?: string | null;
model_load_ms?: number | null;
inference_ms?: number | null;
preprocess_ms?: number | null;
export_ms?: number | null;
```

Add:

```ts
export async function restartHunyuanWorker(): Promise<void> {
  if (!isTauri()) throw new Error('Worker restart requires Tauri.');
  await invoke('restart_hunyuan_worker');
}

export async function clearHunyuanWorkerCache(): Promise<void> {
  if (!isTauri()) throw new Error('Worker cache control requires Tauri.');
  await invoke('clear_hunyuan_worker_cache');
}
```

- [ ] **Step 2: Add failing hook tests**

Cover:

```ts
it('marks restart required after worker_crashed', ...);
it('keeps preserved shape after texture worker crash', ...);
it('reports cache hit from texture result', ...);
it('retry with Safe does not regenerate shape', ...);
```

- [ ] **Step 3: Run focused tests and verify failure**

```bash
npm test -- --run apps/desktop/src/lib/useGenerationJob.test.ts
```

- [ ] **Step 4: Implement hook metadata/recovery changes**

When `error_kind === 'worker_crashed'`, set `workerNeedsRestart=true`. Do not create an automatic replay. Texture retry context remains available if a mesh was already preserved.

On a texture OOM, keep existing retry behavior but call the explicit cache-clear action from App before user-triggered Retry only if the session manager did not already clear the affected cache. Prefer backend-owned cleanup; frontend should not blindly clear cache after successful jobs.

Expose worker timing fields in `GenerationTimingSummary`, keeping existing stage timing as fallback.

- [ ] **Step 5: Add Activity controls**

In `App.tsx`:
- show **Restart worker** when `workerNeedsRestart` is true,
- show a small **Clear cache** action whenever runtime is ready and no job is running,
- after restart success, clear the restart-required state and show `Worker restarted.`,
- do not conflate worker restart with Hunyuan runtime installation/health.

Display `Cache: hit/miss`, `Load`, `Inference` only when values are known.

- [ ] **Step 6: Run frontend tests/build**

```bash
npm test -- --run
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/lib/tauri.ts apps/desktop/src/lib/useGenerationJob.ts apps/desktop/src/lib/useGenerationJob.test.ts apps/desktop/src/App.tsx apps/desktop/src/styles.css
git commit -m "feat: expose persistent worker controls and timings"
```

---

### Task 6: Add Python cold/warm timing metadata and cache-safe OOM behavior

**Files:**
- Modify: `backends/hunyuan/worker.py`
- Modify: `backends/hunyuan/tests/test_worker.py`

**Interfaces:**
- Texture terminal result includes `cache_hit`, `model_load_ms`, `preprocess_ms`, `inference_ms`, `export_ms` when measured.
- OOM clears the affected cached pipeline before the next command.

- [ ] **Step 1: Add pure timing/result tests with fake pipelines**

Mock monotonic timestamps so a cached second Texture call has `model_load_ms == 0` (or absent) and `cache_hit == True`, while the first has `cache_hit == False` and non-zero model-load duration.

Add a fake pipeline that raises `RuntimeError("CUDA out of memory")`; assert cache texture slot is cleared before the next command.

- [ ] **Step 2: Run Python tests and verify failure**

```bash
python -m unittest discover -s backends/hunyuan/tests -v
```

- [ ] **Step 3: Instrument monotonic boundaries**

Use `time.perf_counter()` around:
- model cache lookup/load,
- input/mesh preprocessing,
- `pipeline(...)` inference,
- export.

Emit/cache final values in milliseconds. Do not include frontend queueing time in Python worker timings.

- [ ] **Step 4: Ensure cache events are observable**

For each generation request emit one cache event before model execution:

```json
{"event":"cache","stage":"cache_hit","cache_kind":"texture","cache_hit":true}
```

or miss equivalent. Evictions emit `evicted_shape` / `evicted_texture`.

- [ ] **Step 5: Run the Python suite**

```bash
python -m unittest discover -s backends/hunyuan/tests -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backends/hunyuan/worker.py backends/hunyuan/tests/test_worker.py
git commit -m "perf: report persistent worker cache timings"
```

---

### Task 7: Full protocol regression and RX 6950 XT hardware handoff

**Files:**
- Modify tests only if cross-language gaps are found.
- Update `docs/benchmarks/2026-09-12-rx6950xt-texture-baseline.md` after hardware measurements.

**Interfaces:**
- Verifies Python JSONL, Rust session routing, Tauri client types and UI recovery as one protocol.

- [ ] **Step 1: Run all automated suites**

```bash
python -m unittest discover -s backends/hunyuan/tests -v
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
npm test -- --run
npm run build
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: all PASS.

- [ ] **Step 2: Sync the persistent runtime worker on Windows**

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup\windows-native-rocm.ps1 -VerifyOnly
```

This refreshes the installed worker without reinstalling ROCm/model packages.

- [ ] **Step 3: Launch desktop app**

```powershell
npm run tauri -- dev
```

Confirm health still detects the RX 6950 XT runtime.

- [ ] **Step 4: Validate cold/warm Texture reuse**

Using the same preserved mesh and source image:
1. Texture Balanced 20k once after app start — record cold total/load/inference and `Cache miss`.
2. Immediately Texture Balanced 20k again — record warm total/load/inference and require `Cache hit`.
3. Confirm the second job does not spawn a new visible Python generation process/session.
4. Confirm memory remains bounded after both jobs.

- [ ] **Step 5: Validate workload switch eviction**

Run Shape after a warm Texture, then Texture again. Confirm emitted Activity/cache metadata indicates Texture eviction before Shape and Shape eviction before reloading Texture, with no automatic dual-heavy residency.

- [ ] **Step 6: Validate controls/recovery**

- Clear cache, then Texture again: require cache miss.
- Restart worker, then Texture: require fresh worker/cache miss.
- If an OOM occurs, require preserved Shape and Retry with Safe without shape regeneration.
- If no natural OOM occurs, rely on automated structured OOM tests rather than intentionally exhausting VRAM.

- [ ] **Step 7: Record measured cold/warm values**

Replace the benchmark document's `Not measured yet` cells with observed values only. Include Task Manager dedicated/shared GPU memory observations if available.

- [ ] **Step 8: Verify the latest CI run is green**

Require frontend, python-worker, rust-core, and desktop-windows jobs to complete successfully for the final branch HEAD.

---

## Self-Review Result

- **Spec coverage:** Auto→Balanced, Safe OOM recovery, JSONL `serve`, one-job serialization, bounded Shape/Paint cache, crash/protocol invalidation, explicit restart/clear-cache, cold/warm timings, one-shot CLI preservation and RX 6950 XT validation are all mapped to tasks.
- **Scope:** UV implementation is intentionally not in the implementation tasks; the approved spec records the staged UV roadmap only.
- **No placeholders:** Hardware values not yet measured are explicitly represented as `Not measured yet`; no invented benchmark result is required.
- **Type consistency:** Python snake_case event fields are preserved through Rust result/event structs and TypeScript protocol types; request structs keep the current camelCase Tauri boundary.
- **Dependency policy:** implementation uses Python/Rust standard-library primitives plus existing project dependencies only.
