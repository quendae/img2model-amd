# Generation and Texture Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split geometry generation and Hunyuan Paint into robust independent jobs, add model-only/model+texture and texture-existing-model workflows, introduce Auto/Safe/Balanced/Quality texture profiles, and provide OOM recovery, timings, and mesh statistics for the RX 6950 XT 16 GiB target.

**Architecture:** Keep React responsible for user intent and display, move job orchestration out of `App.tsx` into a focused hook, keep Tauri as the typed process boundary, and let the Hunyuan worker resolve texture profiles against detected GPU VRAM. Shape and texture remain separate Python process invocations so successful geometry survives a texture failure and GPU resources are released between stages.

**Tech Stack:** React 19, TypeScript 5.9, Vitest + Testing Library, Tauri 2, Rust 2021, Python 3.11, PyTorch ROCm/TheRock, Hunyuan3D-2 Mini, Hunyuan Paint.

**Spec:** `docs/superpowers/specs/2026-09-12-generation-texture-workflows-design.md`

## Global Constraints

- Primary validation target is Radeon RX 6950 XT with approximately 16 GiB dedicated VRAM on Windows native ROCm/TheRock.
- `Auto` resolves GPUs with approximately 16 GiB VRAM or less to the Safe profile; larger cards resolve to Balanced until benchmark data supports other thresholds.
- Texture profile working limits are Safe 10,000 triangles, Balanced 20,000, Quality 40,000.
- Safe/Balanced/Quality use CPU model offload, maximum attention slicing, and `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`.
- Shape and texture must be independent worker jobs; texture failure must never delete or hide a successful shape.
- No silent compute-backend fallback.
- Progress must come from real worker events, not a fake timer.
- The first implementation includes only Hunyuan Paint as a texture engine.
- TRELLIS.2, Vulkan inference, Paint3D, MVPaint, SageAttention installation, FlashAttention installation, custom Triton kernels, and quantization remain follow-up work.
- Keep texture working triangle budget distinct from future final game-ready triangle target.

---

## File Structure

### Create
- `apps/desktop/src/domain/textureProfiles.ts` — frontend profile metadata and display labels only; no Hunyuan implementation flags.
- `apps/desktop/src/domain/textureProfiles.test.ts` — frontend profile policy tests.
- `apps/desktop/src/lib/useGenerationJob.ts` — orchestration for separate shape/texture jobs, progress composition, retry context, timings, and normalized UI error state.
- `apps/desktop/src/lib/useGenerationJob.test.ts` — hook/controller regression tests with mocked Tauri calls.

### Modify
- `apps/desktop/src/domain/types.ts` — workflow, output mode, texture engine/profile, job result/timing types.
- `apps/desktop/src/lib/tauri.ts` — existing-mesh picker, generic texture request shape, structured worker result fields.
- `apps/desktop/src/components/GenerationPanel.tsx` — Shape/Texture tabs, output selector, four texture profiles, mesh selector, dynamic primary action.
- `apps/desktop/src/components/GenerationPanel.test.tsx` — UI behavior coverage.
- `apps/desktop/src/App.tsx` — compose the new controller and recovery actions; remove inference orchestration from the component.
- `apps/desktop/src/styles.css` — tabs, segmented choices, profile buttons, mesh row, recovery actions and timing summary.
- `apps/desktop/src-tauri/src/worker.rs` — texture request engine/profile fields, allocator env, streamed structured error/result fields, profile argument forwarding.
- `apps/desktop/src-tauri/src/lib.rs` — keep async/spawn-blocking commands while accepting the updated request type.
- `backends/hunyuan/worker.py` — profile resolution using actual PyTorch VRAM, normalized OOM events, final mesh/profile metadata.
- `backends/hunyuan/tests/test_worker.py` — profile resolution/OOM protocol tests.

No dependency additions are required for this implementation.

---

### Task 1: Add workflow and texture-profile domain types

**Files:**
- Create: `apps/desktop/src/domain/textureProfiles.ts`
- Create: `apps/desktop/src/domain/textureProfiles.test.ts`
- Modify: `apps/desktop/src/domain/types.ts`

**Interfaces:**
- Produces: `WorkflowMode`, `ShapeOutputMode`, `TextureProfile`, `TextureEngineId`, `GenerationPhase`, `GenerationProgress`, `GenerationTimingSummary`, `TextureRetryContext`.
- Produces: `textureProfileLabels: Record<TextureProfile, string>` and `textureProfileDescriptions: Record<TextureProfile, string>`.
- Consumes: existing `BackendId` and `GenerationOptions['profile']` shape profile.

- [ ] **Step 1: Write failing domain tests**

Create `textureProfiles.test.ts` with explicit expectations that all four profiles are user-visible and that Auto is not represented as a hard-coded triangle budget in the frontend:

```ts
import { describe, expect, it } from 'vitest';
import { textureProfileDescriptions, textureProfileLabels } from './textureProfiles';

describe('texture profiles', () => {
  it('exposes all user-facing profiles', () => {
    expect(Object.keys(textureProfileLabels)).toEqual(['auto', 'safe', 'balanced', 'quality']);
  });

  it('describes auto as hardware-selected rather than a fixed triangle limit', () => {
    expect(textureProfileDescriptions.auto.toLowerCase()).toContain('gpu');
    expect(textureProfileDescriptions.auto).not.toContain('10000');
  });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
npm test -- --run apps/desktop/src/domain/textureProfiles.test.ts
```

Expected: FAIL because `textureProfiles.ts` does not exist.

- [ ] **Step 3: Add the types and profile metadata**

Add to `types.ts`:

```ts
export type WorkflowMode = 'shape' | 'texture';
export type ShapeOutputMode = 'model-only' | 'model-and-texture';
export type TextureProfile = 'auto' | 'safe' | 'balanced' | 'quality';
export type TextureEngineId = 'hunyuan-paint';
export type GenerationPhase = 'shape' | 'texture';

export interface GenerationProgress {
  phase: GenerationPhase;
  value: number;
  label: string;
}

export interface GenerationTimingSummary {
  shapeMs?: number;
  textureMs?: number;
  totalMs: number;
  textureStages?: Record<string, number>;
  trianglesBefore?: number;
  trianglesAfter?: number;
  resolvedTextureProfile?: Exclude<TextureProfile, 'auto'>;
}

export interface TextureRetryContext {
  image: string;
  mesh: string;
  output: string;
  backend: BackendId;
  engine: TextureEngineId;
  profile: TextureProfile;
  removeBackground: boolean;
}
```

Create `textureProfiles.ts`:

```ts
import type { TextureProfile } from './types';

export const textureProfileLabels: Record<TextureProfile, string> = {
  auto: 'Auto',
  safe: 'Safe',
  balanced: 'Balanced',
  quality: 'Quality',
};

export const textureProfileDescriptions: Record<TextureProfile, string> = {
  auto: 'Chooses a conservative profile from detected GPU memory.',
  safe: 'Lowest memory pressure · 10k working triangles.',
  balanced: 'Medium working mesh · 20k triangles.',
  quality: 'Largest working mesh · 40k triangles.',
};
```

- [ ] **Step 4: Run tests and TypeScript build**

Run:

```bash
npm test -- --run apps/desktop/src/domain/textureProfiles.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/domain/types.ts apps/desktop/src/domain/textureProfiles.ts apps/desktop/src/domain/textureProfiles.test.ts
git commit -m "feat: add generation workflow domain types"
```

---

### Task 2: Resolve texture profiles inside the Python worker and normalize OOM

**Files:**
- Modify: `backends/hunyuan/worker.py`
- Modify: `backends/hunyuan/tests/test_worker.py`

**Interfaces:**
- Produces: `resolve_texture_profile(profile: str, total_vram_gib: float) -> dict[str, Any]`.
- Worker CLI accepts `--profile {auto,safe,balanced,quality}` instead of requiring callers to choose low-level `--max-faces`, offload, and slicing for normal app use.
- Worker progress/final events expose `requested_profile`, `resolved_profile`, `max_faces`, `faces_before`, `faces_after` where known.
- OOM final event exposes `error_kind="out_of_memory"` and `stage="texture"`.

- [ ] **Step 1: Add failing profile-resolution and OOM-classification tests**

Add tests equivalent to:

```py
def test_auto_texture_profile_is_safe_at_16_gib(self) -> None:
    module = self.load_worker_module()
    resolved = module.resolve_texture_profile("auto", 15.98)
    self.assertEqual(resolved["name"], "safe")
    self.assertEqual(resolved["max_faces"], 10_000)
    self.assertTrue(resolved["cpu_offload"])
    self.assertEqual(resolved["attention_slicing"], "max")


def test_auto_texture_profile_is_balanced_above_16_gib(self) -> None:
    module = self.load_worker_module()
    resolved = module.resolve_texture_profile("auto", 24.0)
    self.assertEqual(resolved["name"], "balanced")
    self.assertEqual(resolved["max_faces"], 20_000)


def test_explicit_quality_profile_uses_40k(self) -> None:
    module = self.load_worker_module()
    resolved = module.resolve_texture_profile("quality", 16.0)
    self.assertEqual(resolved["name"], "quality")
    self.assertEqual(resolved["max_faces"], 40_000)


def test_classify_texture_error_detects_rocm_cuda_oom_wording(self) -> None:
    module = self.load_worker_module()
    kind = module.classify_texture_error(
        RuntimeError("CUDA out of memory. Tried to allocate 2.81 GiB")
    )
    self.assertEqual(kind, "out_of_memory")
```

Also change the existing parser-default test to assert `args.profile == "auto"` instead of treating 40k as the default safe policy.

- [ ] **Step 2: Run worker tests and verify failure**

```bash
python -m unittest backends.hunyuan.tests.test_worker -v
```

Expected: FAIL because the resolver/classifier and `--profile` do not exist.

- [ ] **Step 3: Implement the profile resolver**

Add a pure helper before `run_texture`:

```py
TEXTURE_PROFILES = {
    "safe": {"max_faces": 10_000, "cpu_offload": True, "attention_slicing": "max"},
    "balanced": {"max_faces": 20_000, "cpu_offload": True, "attention_slicing": "max"},
    "quality": {"max_faces": 40_000, "cpu_offload": True, "attention_slicing": "max"},
}


def resolve_texture_profile(profile: str, total_vram_gib: float) -> dict[str, Any]:
    resolved_name = "safe" if profile == "auto" and total_vram_gib <= 16.5 else profile
    if profile == "auto" and total_vram_gib > 16.5:
        resolved_name = "balanced"
    if resolved_name not in TEXTURE_PROFILES:
        raise ValueError(f"Unsupported texture profile: {profile}")
    return {"name": resolved_name, **TEXTURE_PROFILES[resolved_name]}


def classify_texture_error(exc: BaseException) -> str:
    text = f"{type(exc).__name__}: {exc}".lower()
    if "outofmemory" in text or "out of memory" in text:
        return "out_of_memory"
    return "worker_error"
```

Use `torch.cuda.get_device_properties(0).total_memory` after importing torch to calculate GiB. Resolve the profile before mesh reduction and use its values for `prepare_texture_mesh()` and `configure_texture_memory_profile()`.

- [ ] **Step 4: Update the CLI and emitted protocol**

The texture parser must accept:

```py
texture.add_argument(
    "--profile",
    choices=["auto", "safe", "balanced", "quality"],
    default="auto",
)
```

Keep the low-level flags only if existing standalone smoke scripts still need them; if retained, treat them as explicit expert overrides after profile resolution. Normal app calls must use `--profile` only.

Before preprocessing emit the resolved policy:

```py
emit(
    "progress",
    ok=True,
    stage="preparing_mesh",
    progress=0.14,
    requested_profile=args.profile,
    resolved_profile=profile["name"],
    max_faces=profile["max_faces"],
    faces_before=faces_before,
)
```

On texture success include `faces_before`, `faces_after`, `requested_profile`, `resolved_profile`, and `max_faces` in the final `completed` event.

On exception emit:

```py
emit(
    "error",
    ok=False,
    stage="texture",
    error_kind=classify_texture_error(exc),
    error=f"{type(exc).__name__}: {exc}",
    requested_profile=args.profile,
    resolved_profile=resolved_profile,
    faces_before=faces_before,
    faces_after=faces_after,
)
```

Initialize the metadata variables before the `try` so the exception path is safe even if loading fails early.

- [ ] **Step 5: Run the full Python worker suite**

```bash
python -m unittest discover -s backends/hunyuan/tests -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backends/hunyuan/worker.py backends/hunyuan/tests/test_worker.py
git commit -m "feat: add Hunyuan texture profiles and OOM classification"
```

---

### Task 3: Update the Rust worker boundary and allocator policy

**Files:**
- Modify: `apps/desktop/src-tauri/src/worker.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` only if command signatures need formatting/import updates.

**Interfaces:**
- Consumes: frontend `TextureRequest` containing `engine` and `profile`.
- Produces: worker CLI arguments `--profile <value>`.
- Produces: structured `GenerateResult` fields `error_kind`, `stage`, `requested_profile`, `resolved_profile`, `faces_before`, `faces_after`, `max_faces`.
- Produces: expanded `WorkerProgressEvent` fields for requested/resolved profile.

- [ ] **Step 1: Add failing Rust tests for texture arguments and structured results**

Update the existing `texture_arguments_keep_paths_as_separate_process_arguments` fixture to construct:

```rust
TextureRequest {
    backend: "native-rocm".to_string(),
    engine: "hunyuan-paint".to_string(),
    profile: "safe".to_string(),
    mesh: "C:\\input folder\\shape.glb".to_string(),
    image: "C:\\input folder\\source.png".to_string(),
    output: "C:\\output folder\\textured.glb".to_string(),
    model: None,
    subfolder: None,
    remove_background: true,
}
```

Then assert:

```rust
assert!(arguments.windows(2).any(|pair| pair == ["--profile", "safe"]));
assert!(!arguments.iter().any(|arg| arg == "--cpu-offload"));
```

Add a test that deserializes a final OOM JSON result and verifies `error_kind == Some("out_of_memory")`.

- [ ] **Step 2: Run Rust tests and verify failure**

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
```

Expected: FAIL until request/result structs are updated.

- [ ] **Step 3: Change `TextureRequest`, progress and result structs**

Use camelCase serde for the request while preserving snake_case JSON fields emitted by Python for results/events:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureRequest {
    pub backend: String,
    pub engine: String,
    pub profile: String,
    pub mesh: String,
    pub image: String,
    pub output: String,
    pub model: Option<String>,
    pub subfolder: Option<String>,
    pub remove_background: bool,
}
```

Extend `GenerateResult` and `WorkerProgressEvent` with optional metadata; optional fields preserve compatibility with shape events.

Reject unknown engines in `texture_arguments()`:

```rust
if request.engine != "hunyuan-paint" {
    return Err(format!("Texture engine '{}' is not implemented.", request.engine));
}
```

Append `--profile` and the requested value.

- [ ] **Step 4: Set allocator policy on the Python child process**

In `run_worker_streamed`, set the environment for every worker invocation without overwriting a user-supplied process value:

```rust
let allocator = std::env::var("PYTORCH_CUDA_ALLOC_CONF")
    .unwrap_or_else(|_| "expandable_segments:True".to_string());

let mut child = Command::new(&python)
    .arg(worker)
    .args(arguments)
    .env("PYTORCH_CUDA_ALLOC_CONF", allocator)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()?;
```

Apply the same helper/environment to non-streamed health/probe execution only if doing so is centralized cleanly; the requirement is mandatory for generation/texture jobs.

- [ ] **Step 5: Run Rust tests**

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/worker.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat: pass texture profiles through Tauri worker"
```

---

### Task 4: Update the frontend Tauri API and add existing-mesh selection

**Files:**
- Modify: `apps/desktop/src/lib/tauri.ts`

**Interfaces:**
- Produces: `chooseInputMesh(): Promise<string | null>`.
- `TextureMeshRequest` consumes `TextureEngineId` and `TextureProfile`, not `cpuOffload`.
- `GenerateResult` and `WorkerProgressEvent` expose structured OOM/profile/mesh fields.

- [ ] **Step 1: Add the new typed request/result surface**

Import domain types and define:

```ts
export interface TextureMeshRequest {
  backend: BackendId;
  engine: TextureEngineId;
  profile: TextureProfile;
  mesh: string;
  image: string;
  output: string;
  model?: string;
  subfolder?: string;
  removeBackground: boolean;
}

export interface GenerateResult {
  ok: boolean;
  event: string;
  output?: string | null;
  error?: string | null;
  error_kind?: string | null;
  stage?: string | null;
  requested_profile?: string | null;
  resolved_profile?: string | null;
  faces_before?: number | null;
  faces_after?: number | null;
  max_faces?: number | null;
  model?: string | null;
  subfolder?: string | null;
}
```

Use this result type for both `generateShape()` and `textureMesh()`.

- [ ] **Step 2: Add the mesh picker**

```ts
export async function chooseInputMesh(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: '3D mesh', extensions: ['glb', 'obj'] }],
  });
  return typeof selected === 'string' ? selected : null;
}
```

- [ ] **Step 3: Build TypeScript**

```bash
npm run build
```

Expected: the build may identify existing `App.tsx` call sites that still pass `cpuOffload`; fix only the API typing required to make the next task possible or leave App integration to Task 7 by temporarily updating its texture call to `engine: 'hunyuan-paint', profile: 'auto'`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/lib/tauri.ts
git commit -m "feat: expose texture workflow through Tauri client"
```

---

### Task 5: Extract generation orchestration into `useGenerationJob`

**Files:**
- Create: `apps/desktop/src/lib/useGenerationJob.ts`
- Create: `apps/desktop/src/lib/useGenerationJob.test.ts`

**Interfaces:**
- Consumes: `generateShape`, `textureMesh`, `WorkerProgressEvent`.
- Produces hook state: `busy`, `progress`, `message`, `error`, `technicalError`, `resultPath`, `preservedShapePath`, `retryContext`, `timingSummary`.
- Produces actions: `runShapeWorkflow()`, `runTextureWorkflow()`, `retryTexture()`, `retryTextureSafe()`, `clearError()`.

Define request types locally or in `types.ts`:

```ts
export interface ShapeWorkflowRequest {
  backend: BackendId;
  image: string;
  output: string;
  outputMode: ShapeOutputMode;
  shapeProfile: GenerationOptions['profile'];
  steps: number;
  seed: number;
  removeBackground: boolean;
  textureEngine: TextureEngineId;
  textureProfile: TextureProfile;
}

export interface TextureWorkflowRequest extends TextureRetryContext {}
```

- [ ] **Step 1: Write failing hook tests with mocked Tauri functions**

Use `vi.mock('./tauri', ...)` and `renderHook`/`act` from Testing Library. Cover at least:

```ts
it('does not start texture for model-only output', async () => { /* generateShape once; textureMesh never */ });
it('runs texture only after successful shape', async () => { /* order: shape then texture */ });
it('preserves shape and creates retry context when texture OOMs', async () => { /* error_kind out_of_memory */ });
it('retryTextureSafe reuses mesh and image without calling generateShape', async () => { /* profile safe */ });
it('maps shape+texture overall progress as 25/75', async () => { /* shape 1.0 => .25; texture .5 => .625 */ });
```

The test mock should manually invoke progress callbacks so progress behavior is deterministic.

- [ ] **Step 2: Run the focused tests and verify failure**

```bash
npm test -- --run apps/desktop/src/lib/useGenerationJob.test.ts
```

Expected: FAIL because the hook does not exist.

- [ ] **Step 3: Implement progress helpers and timing bookkeeping**

Move `clampProgress`, stage labels, and composition out of `App.tsx`. Use 25% shape / 75% texture for combined jobs:

```ts
function overallProgress(phase: GenerationPhase, raw: number, includesTexture: boolean): number {
  if (!includesTexture) return raw;
  return phase === 'shape' ? raw * 0.25 : 0.25 + raw * 0.75;
}
```

Track timestamps using `performance.now()` with a `Date.now()` fallback for tests/non-browser contexts. Record stage boundaries when `event.stage` changes. Format times later in UI; keep raw milliseconds in state.

- [ ] **Step 4: Implement separate shape and texture job actions**

`runShapeWorkflow()` must:

1. derive `<output>-shape.<ext>` only for `model-and-texture`,
2. await `generateShape`,
3. expose the successful shape immediately as `resultPath` and `preservedShapePath`,
4. return immediately for `model-only`,
5. start a new `textureMesh` invocation only after shape completed,
6. retain the shape if texture fails.

`runTextureWorkflow()` must never call `generateShape()`.

- [ ] **Step 5: Implement normalized OOM recovery**

When `result.error_kind === 'out_of_memory'` during texture:

```ts
setError('Texture generation ran out of GPU memory. The generated shape was preserved successfully.');
setTechnicalError(result.error ?? null);
setRetryContext(request);
```

`retryTexture()` calls `runTextureWorkflow(retryContext)`; `retryTextureSafe()` clones the context with `profile: 'safe'`. Neither function may regenerate geometry.

- [ ] **Step 6: Run focused and full frontend tests**

```bash
npm test -- --run apps/desktop/src/lib/useGenerationJob.test.ts
npm test -- --run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/lib/useGenerationJob.ts apps/desktop/src/lib/useGenerationJob.test.ts
git commit -m "feat: orchestrate split shape and texture jobs"
```

---

### Task 6: Rebuild `GenerationPanel` around Shape and Texture modes

**Files:**
- Modify: `apps/desktop/src/components/GenerationPanel.tsx`
- Modify: `apps/desktop/src/components/GenerationPanel.test.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: workflow/output/profile/mesh state supplied by `App`.
- Emits: `onWorkflowModeChange`, `onShapeOutputModeChange`, `onTextureProfileChange`, `onChooseMesh`, plus existing shape setting callbacks and primary `onGenerate`.

- [ ] **Step 1: Replace old checkbox tests with failing workflow tests**

Test these visible behaviors:

```ts
it('shows Shape and Texture mode tabs', ...);
it('shows Model only and Model + texture choices in Shape mode', ...);
it('shows all four texture profiles when Model + texture is selected', ...);
it('shows mesh selection and Hunyuan Paint engine in Texture mode', ...);
it('disables Generate texture until image, mesh, runtime and backend are ready', ...);
it('keeps non-native backends visibly unsupported without fallback', ...);
```

Use roles/names that match the intended UI copy exactly.

- [ ] **Step 2: Run the component tests and verify failure**

```bash
npm test -- --run apps/desktop/src/components/GenerationPanel.test.tsx
```

Expected: FAIL against the old checkbox UI.

- [ ] **Step 3: Implement the mode switch and dynamic controls**

Use buttons with `aria-pressed` or a `role="tablist"`/`role="tab"` pair. Do not hide profile controls behind Advanced.

Shape mode renders:
- Backend
- Fast/Balanced/Quality shape profile
- Steps/Seed
- Remove background
- Output: Model only / Model + texture
- texture profile row only for Model + texture

Texture mode renders:
- Backend
- Engine: Hunyuan Paint (read-only/select with one option)
- Existing mesh path + Choose model button
- Auto/Safe/Balanced/Quality profile row
- Remove background

Primary button labels:

```ts
const actionLabel = workflowMode === 'texture'
  ? 'Generate texture'
  : outputMode === 'model-and-texture'
    ? 'Generate model + texture'
    : 'Generate model';
```

- [ ] **Step 4: Add focused CSS without changing the overall visual language**

Add compact styles such as `.mode-tabs`, `.segmented-control`, `.texture-profile-grid`, `.mesh-picker`, `.recovery-actions`. Reuse current dark panels, red accent and existing button tokens. Keep the panel usable at the existing 320px rail width.

- [ ] **Step 5: Run component tests and build**

```bash
npm test -- --run apps/desktop/src/components/GenerationPanel.test.tsx
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/GenerationPanel.tsx apps/desktop/src/components/GenerationPanel.test.tsx apps/desktop/src/styles.css
git commit -m "feat: add shape and texture workflow UI"
```

---

### Task 7: Integrate the controller into `App.tsx` and add recovery/timing UI

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: `useGenerationJob()` and `chooseInputMesh()`.
- Produces: viewer switches to preserved shape after shape completion and final textured model after texture completion.
- Produces: Activity recovery actions and timing/triangle summary.

- [ ] **Step 1: Replace the old `texture: boolean` state with explicit workflow state**

Initialize:

```ts
const [workflowMode, setWorkflowMode] = useState<WorkflowMode>('shape');
const [shapeOutputMode, setShapeOutputMode] = useState<ShapeOutputMode>('model-only');
const [textureProfile, setTextureProfile] = useState<TextureProfile>('auto');
const [textureEngine] = useState<TextureEngineId>('hunyuan-paint');
const [textureMeshPath, setTextureMeshPath] = useState<string | null>(null);
```

Keep existing shape profile/steps/seed/background state.

- [ ] **Step 2: Wire file selection and primary generation actions**

For Shape mode, call `chooseOutputModel()` then `job.runShapeWorkflow(...)`.

For Texture mode, require `inputPath` and `textureMeshPath`, call `chooseOutputModel()`, then `job.runTextureWorkflow(...)`.

When a shape job completes successfully, update `modelPath` from `job.resultPath`. When the texture job completes, the same state points to the final output.

- [ ] **Step 3: Add `Texture this model` and OOM recovery actions**

After a model-only shape completes, provide a small Activity action `Texture this model` that sets:

```ts
setWorkflowMode('texture');
setTextureMeshPath(job.preservedShapePath ?? job.resultPath);
```

When `job.retryContext` exists after a texture failure, show:
- Retry texture only
- Retry with Safe when failed profile was not already Safe
- Open Texture mode

`Open Texture mode` preloads image and mesh from retry context and does not start work automatically.

- [ ] **Step 4: Add timing and mesh summary**

Format milliseconds with a local helper:

```ts
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, '0')}` : `${seconds}s`;
}
```

Activity metadata should show only fields actually known, e.g. Shape, Texture, Total, `40,000 → 10,000 triangles`, resolved profile.

Keep raw traceback under technical details or the existing styled error box; the concise normalized message should be the first thing the user sees.

- [ ] **Step 5: Remove orchestration helpers from `App.tsx`**

Delete the old local `GenerationPhase`, `GenerationProgress`, `stageLabels`, `clampProgress`, `combinedProgress`, and the large `runGeneration()` implementation now owned by the hook. Leave diagnostics/health logic in App.

- [ ] **Step 6: Run frontend tests and build**

```bash
npm test -- --run
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/src/styles.css
git commit -m "feat: integrate split generation workflows"
```

---

### Task 8: Add end-to-end protocol regression coverage

**Files:**
- Modify: `backends/hunyuan/tests/test_worker.py`
- Modify: `apps/desktop/src-tauri/src/worker.rs`
- Modify: frontend tests only where gaps are found.

**Interfaces:**
- Verifies the cross-language names exactly: `profile` request; `requested_profile`, `resolved_profile`, `error_kind`, `faces_before`, `faces_after`, `max_faces` worker fields.

- [ ] **Step 1: Add parser/protocol regression cases**

Python test:

```py
def test_texture_parser_accepts_all_profiles(self) -> None:
    module = self.load_worker_module()
    parser = module.build_parser()
    for profile in ("auto", "safe", "balanced", "quality"):
        args = parser.parse_args([
            "texture", "--mesh", "input.glb", "--image", "input.png",
            "--output", "output.glb", "--profile", profile,
        ])
        self.assertEqual(args.profile, profile)
```

Rust test must parse a representative progress payload:

```rust
let event: WorkerProgressEvent = serde_json::from_str(
    r#"{"event":"progress","stage":"mesh_ready","progress":0.18,"requested_profile":"auto","resolved_profile":"safe","faces_before":40000,"faces_after":10000,"max_faces":10000}"#,
).unwrap();
assert_eq!(event.resolved_profile.as_deref(), Some("safe"));
assert_eq!(event.faces_after, Some(10_000));
```

- [ ] **Step 2: Run all three automated suites**

```bash
python -m unittest discover -s backends/hunyuan/tests -v
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
npm test -- --run
npm run build
```

Expected: all PASS.

- [ ] **Step 3: Commit any regression-only additions**

```bash
git add backends/hunyuan/tests apps/desktop/src-tauri/src apps/desktop/src
git commit -m "test: cover split generation protocol"
```

Skip the commit only if Task 8 required no new changes.

---

### Task 9: Windows desktop verification and RX 6950 XT handoff

**Files:**
- No production file is required unless verification exposes a bug.
- Update the plan checkboxes/PR description with observed validation results after the local hardware run.

**Interfaces:**
- Validates the completed feature against the actual TheRock runtime and Hunyuan Paint extensions.

- [ ] **Step 1: Run local static verification**

```powershell
npm test -- --run
npm run build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
python -m unittest discover -s backends/hunyuan/tests -v
```

Expected: all PASS.

- [ ] **Step 2: Launch the desktop app**

```powershell
npm run tauri -- dev
```

Confirm diagnostics still detect the persisted native ROCm worker and texture runtime.

- [ ] **Step 3: Run the manual regression matrix using one fixed image**

Verify in order:
1. Shape → Model only.
2. `Texture this model` → existing shape is preloaded.
3. Texture-only → final textured GLB appears without rerunning shape.
4. Shape → Model + texture → preserved `*-shape.glb` plus final output.
5. Safe, Balanced and Quality use visibly different reported triangle budgets.
6. Auto reports resolved profile `Safe` on the RX 6950 XT class 16 GiB card.
7. UI remains responsive and progress streams through both stages.
8. Second generation in the same app session still works.
9. Restart the app and verify runtime detection remains healthy.

- [ ] **Step 4: Exercise OOM recovery**

If Quality naturally OOMs, use that run. Otherwise this acceptance case may be validated through automated structured-error tests rather than intentionally exhausting the GPU.

When OOM occurs, confirm:
- concise OOM message,
- preserved shape still in viewer and on disk,
- Retry texture only performs no shape generation,
- Retry with Safe uses the same source image and mesh.

- [ ] **Step 5: Record baseline timings for the next optimization milestone**

For the same preserved shape record Safe/Balanced/Quality:
- total texture elapsed time,
- texture inference time,
- triangles before/after,
- resolved profile,
- pass/OOM,
- Windows Task Manager dedicated/shared GPU memory observation.

These are baseline measurements only; do not add SageAttention/Triton/Vulkan/TRELLIS changes in this implementation branch.

- [ ] **Step 6: Verify CI**

The existing workflow must pass:
- frontend: install, tests, build,
- python-worker unit tests,
- rust-core tests,
- desktop-windows build/script validation/cargo check.

If CI fails, fix the smallest regression and rerun the affected local command before pushing.

---

## Self-Review Result

- Spec coverage: Shape/Texture modes, model-only/model+texture, existing model texture flow, four profiles, <=16 GiB Auto→Safe policy, allocator setting, independent jobs, OOM retry, timings, triangle reporting, streaming progress and Hunyuan-only engine boundary are all mapped to tasks above.
- Scope exclusions are preserved: no TRELLIS.2, Vulkan implementation, alternative paint engines, SageAttention/Triton/quantization work in this branch.
- Cross-language field names are consistent: camelCase Tauri request fields map through Rust serde; Python event/result metadata remains snake_case and TypeScript reads it as emitted.
- No new package dependency is required.
- Final game-ready triangle targets remain separate from the texture working mesh budget.
