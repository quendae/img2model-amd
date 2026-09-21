# Local Repaint v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe, UV-aware Local Repaint workflow that lets the user brush a mask on the 3D model, repaint only that albedo region with a local prompt/reference model, preview it immediately, and export the edited GLB.

**Architecture:** Keep geometry and UVs immutable. Convert 3D brush hits into a deterministic atlas-space mask, extract a padded patch, send only that patch and mask through the existing Tauri/persistent-worker path, then composite the validated result into a copy of the current atlas. The first real backend is SDXL Inpainting with IP-Adapter behind a backend-neutral adapter so it can be replaced without changing the viewer or IPC contract.

**Tech Stack:** React 19, TypeScript, Three.js 0.180, Tauri v2/Rust, Python 3.11, Pillow, NumPy, PyTorch ROCm/TheRock, Diffusers SDXL Inpainting, IP-Adapter, Hugging Face cache.

**Spec:** `docs/superpowers/specs/2026-09-21-local-repaint-v1-design.md`

## Global Constraints

- Local Repaint v1 edits only base color/albedo; geometry, UV coordinates, normal, roughness and metallic data must remain unchanged.
- Prompt-only, reference-only and prompt+reference are valid; a request with neither is invalid.
- Pixels outside the selected mask plus the explicit feather band must remain pixel-identical to the current atlas.
- Inference never mutates the active atlas in place; the atlas is swapped only after validation and successful compositing.
- A second repaint uses the previously accepted repaint atlas as its source.
- The local repaint model is not bundled in the installer; weights download on first use and remain in the persistent Hugging Face/model cache across app upgrades.
- The installed Windows/RX 6950 XT path is the hardware acceptance target.
- Do not turn this milestone into a full UV editor, layer system, PBR painter or multi-view rebake system.
- Use Img2Model AMD naming throughout.

## Review Focus

1. **UV seams and neighboring atlas islands:** a screen-space brush that crosses a visible surface seam must mark only raycast-hit surface samples, not unrelated islands that happen to be adjacent in UV space. Task 1 adds a seam/island test.
2. **Texture transform / flipY:** painting must target the visibly rendered texel when the active texture has flipY or a KHR/Three.js texture transform. Task 1 adds transformed-UV tests.
3. **Multiple distinct albedo atlases:** v1 must reject this clearly instead of silently editing the wrong material. Task 2 adds a multi-atlas rejection test.
4. **Failed/invalid inference result:** malformed PNG, wrong dimensions, OOM or worker crash must leave the current atlas byte-for-byte unchanged. Tasks 3, 5 and 6 pin this behavior.
5. **Cancel during inference:** cancelling Local Repaint must terminate the worker job, report `cancelled`, preserve the atlas, and permit a fresh worker session on the next job. Task 5 adds cancellation tests.

---

## File Structure

### New focused frontend modules

- `apps/desktop/src/lib/localRepaintMask.ts` — pure UV/sample-to-mask math; no React or Three renderer ownership.
- `apps/desktop/src/lib/localRepaintMask.test.ts` — mask rasterization, erase, seams, transforms and bounds tests.
- `apps/desktop/src/lib/localRepaintAtlas.ts` — editable-atlas capture helpers, patch extraction, deterministic feather/compositing and PNG conversion helpers.
- `apps/desktop/src/lib/localRepaintAtlas.test.ts` — exact pixel preservation, bbox/padding and failure-safety tests.

### Existing frontend files

- `apps/desktop/src/components/ModelViewer.tsx` — Local Repaint interaction state, raycasting, overlay, controls and final apply flow.
- `apps/desktop/src/components/ModelViewer.test.tsx` — UI state and interaction contracts.
- `apps/desktop/src/styles.css` — compact Local Repaint controls/overlay styling.
- `apps/desktop/src/domain/types.ts` — shared repaint progress/result types only.
- `apps/desktop/src/lib/tauri.ts` — Tauri IPC request/response and cancel helper.

### Rust/Tauri bridge

- `apps/desktop/src-tauri/src/worker.rs` — internal worker-path request structs for Local Repaint.
- `apps/desktop/src-tauri/src/worker_session.rs` — persistent `local_repaint` command, worker PID cancellation and recovery.
- `apps/desktop/src-tauri/src/lib.rs` — byte-oriented Tauri command that writes temporary patch files, invokes the worker and returns edited PNG bytes.

### Python backend

- `backends/hunyuan/local_repaint.py` — backend-neutral adapter contract, deterministic fake backend used by tests, SDXL/IP-Adapter implementation and cache lifecycle.
- `backends/hunyuan/tests/test_local_repaint.py` — validation, compositing-facing contract, cache, prompt/reference and OOM tests.
- `backends/hunyuan/requirements-repaint.txt` — runtime-only Python dependencies for the local edit backend.
- `backends/hunyuan/worker.py` — persistent protocol dispatch and pipeline cache integration.

### Installer/runtime packaging

- `scripts/setup/prepare-installer-resources.mjs` — bundle the repaint source and requirements file.
- `scripts/setup/install-img2model-runtime.ps1` — sync repaint source and install missing repaint Python packages without rebuilding the Hunyuan texture extension.

---

### Task 1: Pure 3D-hit to atlas-mask math

**Files:**
- Create: `apps/desktop/src/lib/localRepaintMask.ts`
- Create: `apps/desktop/src/lib/localRepaintMask.test.ts`

**Interfaces:**
- Consumes: normalized visible UV samples from Three.js raycast intersections plus active texture transform metadata.
- Produces:
  - `type RepaintMask = { width: number; height: number; data: Uint8ClampedArray }`
  - `createRepaintMask(width: number, height: number): RepaintMask`
  - `textureUvToAtlasPixel(uv: {x:number;y:number}, width: number, height: number, transform: TextureUvTransform): {x:number;y:number}`
  - `stampMaskSamples(mask: RepaintMask, samples: readonly AtlasSample[], mode: 'paint'|'erase', radiusPx: number): RepaintMask`
  - `maskBounds(mask: RepaintMask): MaskBounds | null`

- [ ] **Step 1: Write failing unit tests for mask creation, paint, erase and empty bounds.**

```ts
it('paints and erases deterministic atlas pixels', () => {
  const mask = createRepaintMask(8, 8);
  stampMaskSamples(mask, [{ x: 4, y: 4 }], 'paint', 1);
  expect(mask.data[4 * 8 + 4]).toBe(255);
  stampMaskSamples(mask, [{ x: 4, y: 4 }], 'erase', 1);
  expect(mask.data[4 * 8 + 4]).toBe(0);
  expect(maskBounds(mask)).toBeNull();
});
```

- [ ] **Step 2: Add the review-focus seam test before implementation.** The test supplies two distinct raycast sample sets with UVs close in atlas space and asserts that only supplied samples are stamped; the implementation must never flood-fill or expand across UV islands automatically.

```ts
it('does not paint a neighboring UV island that was not raycast-hit', () => {
  const mask = createRepaintMask(32, 32);
  stampMaskSamples(mask, [{ x: 10, y: 10 }], 'paint', 0);
  expect(mask.data[10 * 32 + 10]).toBe(255);
  expect(mask.data[10 * 32 + 11]).toBe(0);
});
```

- [ ] **Step 3: Add transformed-UV/flipY tests.** Pin identity, flipY and centered rotation/scale mapping through a plain `TextureUvTransform` value rather than importing Three.js into the pure module.

```ts
expect(textureUvToAtlasPixel({x: 0.25, y: 0.75}, 100, 100, {
  offsetX: 0, offsetY: 0, repeatX: 1, repeatY: 1, rotationRad: 0,
  centerX: 0, centerY: 0, flipY: true,
})).toEqual({x: 25, y: 25});
```

- [ ] **Step 4: Run RED.**

Run: `npm --prefix apps/desktop test -- --run src/lib/localRepaintMask.test.ts`

Expected: FAIL because `localRepaintMask.ts` does not exist.

- [ ] **Step 5: Implement the minimal pure mask module.** Use integer clamping and Euclidean circle stamps; do not infer islands. Keep mask data one byte per pixel and mutate only the returned mask instance.

```ts
export interface TextureUvTransform {
  offsetX: number; offsetY: number;
  repeatX: number; repeatY: number;
  rotationRad: number;
  centerX: number; centerY: number;
  flipY: boolean;
}

export function maskBounds(mask: RepaintMask): MaskBounds | null {
  let minX = mask.width, minY = mask.height, maxX = -1, maxY = -1;
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (mask.data[y * mask.width + x] === 0) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}
```

- [ ] **Step 6: Run GREEN.**

Run: `npm --prefix apps/desktop test -- --run src/lib/localRepaintMask.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add apps/desktop/src/lib/localRepaintMask.ts apps/desktop/src/lib/localRepaintMask.test.ts
git commit -m "feat: add UV repaint mask math"
```

---

### Task 2: Editable albedo atlas discovery and 3D brush UI

**Files:**
- Modify: `apps/desktop/src/components/ModelViewer.tsx`
- Modify: `apps/desktop/src/components/ModelViewer.test.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: Task 1 mask helpers.
- Produces: an in-memory active repaint mask and one resolved editable base-color atlas; no AI call yet.

- [ ] **Step 1: Add failing viewer tests for Local Repaint controls.** Require `Local Repaint`, `Paint`, `Erase`, `Clear mask`, brush-size slider, prompt field, reference chooser and `Apply repaint` disabled for an empty mask.

```tsx
render(<ModelViewer modelUrl="textured.glb" busy={false} />);
expect(screen.getByRole('button', { name: 'Local Repaint' })).toBeTruthy();
fireEvent.click(screen.getByRole('button', { name: 'Local Repaint' }));
expect(screen.getByRole('button', { name: 'Paint' })).toBeTruthy();
expect(screen.getByRole('button', { name: 'Erase' })).toBeTruthy();
expect(screen.getByRole('button', { name: 'Clear mask' })).toBeTruthy();
```

- [ ] **Step 2: Add a failing multi-atlas rejection test.** Extend the Three.js test mock so two meshes expose different `material.map` texture objects. Entering Local Repaint must show `Local Repaint v1 supports one base-color atlas at a time.` and must not enable painting.

- [ ] **Step 3: Run RED.**

Run: `npm --prefix apps/desktop test -- --run src/components/ModelViewer.test.tsx`

Expected: FAIL because Local Repaint controls do not exist.

- [ ] **Step 4: Add `resolveEditableBaseColorTexture(root)` in `ModelViewer.tsx`.** Traverse real meshes, ignore internal wire/mask-overlay meshes, collect unique non-null `material.map` references, return exactly one texture or a typed reason (`no_albedo`, `multiple_albedo`). Keep direct-imported atlas support by treating `importedTextureRef.current` as the current atlas when present.

- [ ] **Step 5: Add Local Repaint state without using the global `busy` prop.** The viewer must stay mounted while repaint runs. Add local state for `repaintMode`, `brushMode`, `brushSizePx`, `prompt`, `referencePath`, `mask`, `repaintBusy`, `repaintStatus`.

- [ ] **Step 6: Add screen-space brush sampling to the renderer effect.** On pointer drag while Local Repaint is active, temporarily disable OrbitControls and sample a disk of screen offsets around the cursor. Raycast each sample into visible meshes, use `Intersection.uv`, transform it with the active texture transform/flipY, and pass only successful surface samples to Task 1. This is what prevents a UV-space circle from painting an unrelated neighboring island.

Pseudo-code that the implementation should follow:

```ts
for (const [dx, dy] of brushDiskSamples(brushSizePx)) {
  pointerToNdc(event.clientX + dx, event.clientY + dy, canvasRect, ndc);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(editableMeshes, false)[0];
  if (!hit?.uv) continue;
  atlasSamples.push(textureUvToAtlasPixel(hit.uv, atlas.width, atlas.height, currentTransform));
}
stampMaskSamples(mask, atlasSamples, brushMode, 0);
```

- [ ] **Step 7: Add a translucent mask overlay.** Use a `CanvasTexture`/alpha map built from the mask and a marked overlay mesh per editable mesh (`userData.img2modelRepaintOverlay = true`). Use shared geometry, transparent `MeshBasicMaterial`, `depthWrite=false`, `polygonOffset=true`; update the alpha texture when mask changes. Ensure `applyInspectionMode()` skips repaint overlay meshes.

- [ ] **Step 8: Make Clear/Erase and navigation predictable.** Paint gesture owns LMB only while Local Repaint is active; right drag/wheel continue to orbit/pan/zoom only when not painting. Exiting Local Repaint disposes overlay material/texture and restores controls.

- [ ] **Step 9: Run GREEN plus existing viewer regression tests.**

Run: `npm --prefix apps/desktop test -- --run src/components/ModelViewer.test.tsx src/components/ModelViewerUvContract.test.js src/components/ModelViewerUvTextureContract.test.js`

Expected: PASS.

- [ ] **Step 10: Commit.**

```bash
git add apps/desktop/src/components/ModelViewer.tsx apps/desktop/src/components/ModelViewer.test.tsx apps/desktop/src/styles.css
git commit -m "feat: add 3D Local Repaint brush mask"
```

---

### Task 3: Atlas capture, padded patch extraction and exact compositing

**Files:**
- Create: `apps/desktop/src/lib/localRepaintAtlas.ts`
- Create: `apps/desktop/src/lib/localRepaintAtlas.test.ts`
- Modify: `apps/desktop/src/components/ModelViewer.tsx`

**Interfaces:**
- Consumes: `RepaintMask` from Task 1 and the resolved base-color texture from Task 2.
- Produces:
  - `EditableAtlas { width, height, rgba, flipY, name }`
  - `PatchRect { x, y, width, height }`
  - `extractRepaintPatch(atlas, mask, paddingPx)`
  - `compositeRepaintPatch(atlas, editedPatch, maskPatch, rect, featherPx): EditableAtlas`
  - `editableAtlasToPng(atlas): Promise<Uint8Array>`
  - `pngBytesToEditableAtlas(bytes): Promise<EditableAtlas>`

- [ ] **Step 1: Write failing bbox/padding tests.** Padding must clamp to atlas edges and patch dimensions must be positive.

```ts
expect(expandMaskBounds({minX: 2, minY: 3, maxX: 5, maxY: 6}, 4, 10, 10))
  .toEqual({x: 0, y: 0, width: 10, height: 10});
```

- [ ] **Step 2: Write the pixel-identity review-focus test.** Build a synthetic atlas, composite a solid edited patch with a one-pixel mask and feather=0, then assert every RGBA byte outside that pixel is unchanged.

```ts
for (let i = 0; i < before.rgba.length; i += 4) {
  if (pixelIndex(i) === selectedPixel) continue;
  expect(after.rgba.slice(i, i + 4)).toEqual(before.rgba.slice(i, i + 4));
}
```

- [ ] **Step 3: Add feather determinism tests.** Define feather alpha as a deterministic distance-transform/radius falloff from mask coverage; no canvas blur filter because browser/GPU implementations can vary. `featherPx=0` means exact binary mask.

- [ ] **Step 4: Add malformed/wrong-size result tests.** `compositeRepaintPatch` must reject a patch whose width/height differs from the extracted rect before allocating/swapping the current atlas.

- [ ] **Step 5: Run RED.**

Run: `npm --prefix apps/desktop test -- --run src/lib/localRepaintAtlas.test.ts`

Expected: FAIL because the atlas module does not exist.

- [ ] **Step 6: Implement pure RGBA extraction/compositing first.** Keep the compositing core independent of browser Canvas. Browser decode/encode helpers live at the edge of the same module.

```ts
export function compositeRepaintPatch(
  source: EditableAtlas,
  edited: EditableAtlas,
  maskPatch: RepaintMask,
  rect: PatchRect,
  featherPx: number,
): EditableAtlas {
  if (edited.width !== rect.width || edited.height !== rect.height) {
    throw new Error('Edited repaint patch dimensions do not match the requested patch.');
  }
  const rgba = new Uint8ClampedArray(source.rgba);
  // compute alpha from mask + feather, blend only covered pixels
  return { ...source, rgba };
}
```

- [ ] **Step 7: Add `captureEditableAtlas(texture)` and `atlasToCanvasTexture(atlas, sourceTexture)`.** Draw the texture image into a 2D canvas, preserve `flipY`, color space and wrap/transform settings, and return a new `CanvasTexture` suitable for `GLTFExporter`. Do not mutate the original texture.

- [ ] **Step 8: Wire only the deterministic round-trip into `ModelViewer`.** Add a development/test-only function path that composites a fixed color into the mask so hardware testing can verify brush→UV→atlas before any AI dependency. Do not expose a permanent fake-backend button in production UI.

- [ ] **Step 9: Run GREEN.**

Run: `npm --prefix apps/desktop test -- --run src/lib/localRepaintAtlas.test.ts src/components/ModelViewer.test.tsx`

Expected: PASS.

- [ ] **Step 10: Commit.**

```bash
git add apps/desktop/src/lib/localRepaintAtlas.ts apps/desktop/src/lib/localRepaintAtlas.test.ts apps/desktop/src/components/ModelViewer.tsx
git commit -m "feat: add transactional atlas repaint compositing"
```

---

### Task 4: Tauri IPC and persistent worker protocol contract

**Files:**
- Modify: `apps/desktop/src/domain/types.ts`
- Modify: `apps/desktop/src/lib/tauri.ts`
- Modify: `apps/desktop/src-tauri/src/worker.rs`
- Modify: `apps/desktop/src-tauri/src/worker_session.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Frontend IPC request:

```ts
export interface LocalRepaintRequest {
  sourcePng: number[];
  maskPng: number[];
  prompt?: string | null;
  referenceImage?: string | null;
  featherPx: number;
}

export interface LocalRepaintResponse {
  ok: boolean;
  editedPng?: number[] | null;
  error?: string | null;
  errorKind?: string | null;
  model?: string | null;
  cacheHit?: boolean | null;
  modelLoadMs?: number | null;
  inferenceMs?: number | null;
}
```

- Internal Rust worker request uses temporary paths rather than byte arrays:

```rust
pub struct LocalRepaintWorkerRequest {
    pub source: String,
    pub mask: String,
    pub output: String,
    pub prompt: Option<String>,
    pub reference_image: Option<String>,
    pub feather_px: u32,
}
```

- [ ] **Step 1: Add failing Rust serialization tests.** Require camelCase Tauri input and a persistent protocol message with `command="local_repaint"`, job id and path-based request.

```rust
#[test]
fn local_repaint_command_has_request_and_job_id() {
    let value = local_repaint_command("job-11", &fixture_local_repaint_request());
    assert_eq!(value["command"], "local_repaint");
    assert_eq!(value["request"]["source"], "source.png");
}
```

- [ ] **Step 2: Run RED.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features local_repaint`

Expected: FAIL because the request/command does not exist.

- [ ] **Step 3: Add `LocalRepaintWorkerRequest` and `local_repaint_command()` in Rust.** Validate backend remains `native-rocm` implicitly through the configured persistent worker; Local Repaint has no alternate backend selector in v1.

- [ ] **Step 4: Add `WorkerSession::run_local_repaint()` and `WorkerSessionManager::run_local_repaint()`.** Reuse `run_generation()` and `GenerateResult`; the Python terminal event must use existing fields (`output`, `model`, `cache_hit`, `cache_kind="local-repaint"`, `model_load_ms`, `inference_ms`).

- [ ] **Step 5: Add Tauri `local_repaint` command.** It must create a unique temp directory, write source/mask bytes, construct the path-based worker request, invoke the manager, validate `result.ok` and output file existence, read edited PNG bytes, remove the temp directory in `finally`/Drop-style cleanup, and return `LocalRepaintResponse`. Never expose a worker temp path to the React layer.

Pseudo-code:

```rust
let temp = create_repaint_temp_dir()?;
std::fs::write(temp.join("source.png"), &request.source_png)?;
std::fs::write(temp.join("mask.png"), &request.mask_png)?;
let result = manager.run_local_repaint(worker_request, on_event)?;
let edited_png = if result.ok { Some(std::fs::read(result.output.as_ref().ok_or("missing output")?)?) } else { None };
let _ = std::fs::remove_dir_all(&temp);
```

- [ ] **Step 6: Register the command in `tauri::generate_handler!` and add `localRepaint()` in `tauri.ts`.** Forward worker progress through the same `Channel<WorkerProgressEvent>` pattern used by Shape/Texture.

- [ ] **Step 7: Add frontend request validation before invoke.** Neither prompt nor reference is an immediate rejected promise; empty `sourcePng`/`maskPng` is also rejected.

- [ ] **Step 8: Run GREEN.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features`

Run: `npm --prefix apps/desktop test -- --run`

Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
git add apps/desktop/src/domain/types.ts apps/desktop/src/lib/tauri.ts apps/desktop/src-tauri/src/worker.rs apps/desktop/src-tauri/src/worker_session.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat: add Local Repaint IPC contract"
```

---

### Task 5: Worker-side validation, fake adapter, cache lifecycle and cancellation

**Files:**
- Create: `backends/hunyuan/local_repaint.py`
- Create: `backends/hunyuan/tests/test_local_repaint.py`
- Modify: `backends/hunyuan/worker.py`
- Modify: `apps/desktop/src-tauri/src/worker_session.rs`
- Modify: `apps/desktop/src/lib/tauri.ts`

**Interfaces:**
- Python adapter protocol:

```py
class LocalRepaintBackend(Protocol):
    model_id: str
    def repaint(self, source: Image.Image, mask: Image.Image, *, prompt: str | None,
                reference: Image.Image | None) -> Image.Image: ...
```

- `run_local_repaint(args, cache) -> int` emits standard worker `progress/cache/completed/error` JSON lines.

- [ ] **Step 1: Write failing Python validation tests.** Cover source/mask existence, exact matching dimensions, non-empty mask, valid prompt/reference combinations, reference path existence and output PNG dimensions.

```py
def test_request_rejects_neither_prompt_nor_reference(tmp_path):
    args = repaint_args(tmp_path, prompt=None, reference=None)
    assert run_local_repaint(args, cache=PipelineCache()) == 2
    assert last_event()["error_kind"] == "invalid_input"
```

- [ ] **Step 2: Add a deterministic fake backend test.** `FakeLocalRepaintBackend` fills masked pixels with a known color and leaves the rest untouched. Use it to test protocol and caching without importing torch/diffusers.

- [ ] **Step 3: Add worker dispatch RED test.** `dispatch_serve_command({"command":"local_repaint", ...})` must emit a terminal event carrying the same job id.

- [ ] **Step 4: Run RED.**

Run: `python -m pytest backends/hunyuan/tests/test_local_repaint.py -q`

Expected: FAIL because `local_repaint.py`/dispatch does not exist.

- [ ] **Step 5: Implement `LocalRepaintCache`.** One entry only, with `get_or_create(key, loader) -> (backend, cache_hit)`, `clear()` and explicit VRAM cleanup callback. Extend `worker.PipelineCache` with `local_repaint_cache`.

- [ ] **Step 6: Add cross-pipeline VRAM eviction.** Before a repaint model loads, clear Shape and Texture pipelines. Before Shape or Hunyuan Paint starts, clear the repaint cache. This prevents a resident SDXL edit pipeline and Hunyuan pipeline from competing for 16 GB VRAM.

- [ ] **Step 7: Implement `run_local_repaint()` validation and fake-adapter injection seam.** Normal production path requests `get_sdxl_backend()`, while tests monkeypatch that factory. Emit stages: `preparing_repaint`, `loading_repaint_model`, `running_repaint`, `writing_repaint`, `completed`.

- [ ] **Step 8: Add OOM mapping test and cleanup.** Catch `torch.OutOfMemoryError` when torch is available and string-classify ROCm/CUDA out-of-memory errors otherwise; clear the repaint cache and call `torch.cuda.empty_cache()` when available, emit `error_kind="out_of_memory"`.

- [ ] **Step 9: Add cancellable worker-process control in Rust.** Store the persistent child PID in an `AtomicU32` on `WorkerSessionManager` whenever a session is spawned. Add an `AtomicBool cancel_requested`. `cancel_local_repaint` sets the flag and, on Windows, invokes `taskkill /PID <pid> /T /F` without acquiring the session mutex. The blocked repaint call then observes worker termination, invalidates the session, and maps the result to `error_kind="cancelled"` if the flag was set. Clear both PID and flag after terminal handling.

- [ ] **Step 10: Add cancellation tests.** Rust unit tests cover cancel flag mapping and PID reset; frontend test verifies Cancel calls `cancelLocalRepaint()` and leaves the active atlas reference unchanged. Do not require an actual `taskkill` process in unit tests—put platform termination behind a small `terminate_worker_pid(pid)` function and test its state machine separately.

- [ ] **Step 11: Run GREEN.**

Run: `python -m pytest backends/hunyuan/tests/test_local_repaint.py -q`

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features`

Expected: PASS.

- [ ] **Step 12: Commit.**

```bash
git add backends/hunyuan/local_repaint.py backends/hunyuan/tests/test_local_repaint.py backends/hunyuan/worker.py apps/desktop/src-tauri/src/worker_session.rs apps/desktop/src/lib/tauri.ts
git commit -m "feat: add repaint worker lifecycle and cancellation"
```

---

### Task 6: Real SDXL Inpainting + IP-Adapter backend and persistent model acquisition

**Files:**
- Modify: `backends/hunyuan/local_repaint.py`
- Modify: `backends/hunyuan/tests/test_local_repaint.py`
- Create: `backends/hunyuan/requirements-repaint.txt`
- Modify: `scripts/setup/prepare-installer-resources.mjs`
- Modify: `scripts/setup/install-img2model-runtime.ps1`

**Interfaces:**
- Model id: `diffusers/stable-diffusion-xl-1.0-inpainting-0.1`
- Load with fp16 variant through `AutoPipelineForInpainting`.
- Reference adapter: `h94/IP-Adapter`, `sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors`, with ViT-H encoder from `models/image_encoder`.
- Production backend class: `SdxlLocalRepaintBackend`.

- [ ] **Step 1: Add mocked Diffusers load tests before imports are added.** Monkeypatch `snapshot_download`, `AutoPipelineForInpainting.from_pretrained`, `CLIPVisionModelWithProjection.from_pretrained`, `load_ip_adapter` and verify prompt-only does not require IP image while reference-only and prompt+reference pass `ip_adapter_image`.

- [ ] **Step 2: Add model-cache acquisition tests.** `resolve_model_snapshot(repo_id, allow_download)` first attempts `snapshot_download(..., local_files_only=True)`. If absent, emit/download once with normal `snapshot_download`. A second call uses the local cached snapshot and reports disk cache hit.

- [ ] **Step 3: Run RED.**

Run: `python -m pytest backends/hunyuan/tests/test_local_repaint.py -q`

Expected: FAIL on missing SDXL backend.

- [ ] **Step 4: Add runtime dependencies.** `requirements-repaint.txt` must contain bounded compatible packages and must not reinstall torch:

```text
diffusers>=0.36,<0.38
transformers>=4.48,<5
accelerate>=1.2,<2
safetensors>=0.4.5
```

- [ ] **Step 5: Implement the real backend with conservative Radeon settings.** Do not use xFormers. Load fp16, enable attention slicing and VAE slicing/tiling, then move the pipeline to `cuda` (PyTorch ROCm presents HIP through the CUDA-compatible device API). Keep inference patch normalization at 1024x1024, 20 steps, guidance 7.0. Resize the output back to the exact requested patch dimensions before returning.

```py
pipe = AutoPipelineForInpainting.from_pretrained(
    model_path,
    torch_dtype=torch.float16,
    variant="fp16",
    use_safetensors=True,
    image_encoder=image_encoder,
)
pipe.load_ip_adapter(
    ip_adapter_path,
    subfolder="sdxl_models",
    weight_name="ip-adapter-plus_sdxl_vit-h.safetensors",
)
pipe.set_ip_adapter_scale(0.6)
pipe.enable_attention_slicing()
pipe.enable_vae_slicing()
pipe.enable_vae_tiling()
pipe.to("cuda")
```

- [ ] **Step 6: Define reference-only behavior explicitly.** If `prompt` is empty but a reference exists, pass an empty prompt string and image guidance; do not invent semantic content. If no reference exists, do not load/use IP-Adapter image input for that job.

- [ ] **Step 7: Preserve the source outside the model mask twice.** The diffusion pipeline gets the binary patch mask, and the frontend Task 3 compositor remains the authoritative final boundary. This prevents a model that slightly alters unmasked pixels from leaking changes into the atlas.

- [ ] **Step 8: Add progress/telemetry.** Report `model`, `cache_hit`, `cache_kind="local-repaint"`, `model_load_ms`, `inference_ms`; emit `loading_repaint_model` before any first-use Hugging Face download so the UI can say `Downloading/preparing local repaint model…`.

- [ ] **Step 9: Package source and dependencies.** Add `backends/hunyuan/local_repaint.py` and `requirements-repaint.txt` to `prepare-installer-resources.mjs`. In `install-img2model-runtime.ps1`, sync `local_repaint.py` beside `worker.py`; on a healthy reused runtime, run a cheap import check `import diffusers, transformers, accelerate` and only execute `pip install -r requirements-repaint.txt` when missing. This must not trigger native ROCm/Hunyuan texture rebuild.

- [ ] **Step 10: Add installer-script contract tests or static validation.** Extend whichever existing setup validation test checks payload contents so missing `local_repaint.py` or `requirements-repaint.txt` fails CI.

- [ ] **Step 11: Run GREEN without downloading model weights in CI.**

Run: `python -m pytest backends/hunyuan/tests/test_local_repaint.py -q`

Run: `node scripts/setup/prepare-installer-resources.mjs`

Expected: tests PASS and payload contains the two new repaint files. CI tests must mock all Hugging Face downloads.

- [ ] **Step 12: Commit.**

```bash
git add backends/hunyuan/local_repaint.py backends/hunyuan/tests/test_local_repaint.py backends/hunyuan/requirements-repaint.txt scripts/setup/prepare-installer-resources.mjs scripts/setup/install-img2model-runtime.ps1
git commit -m "feat: add Radeon local repaint backend"
```

---

### Task 7: Connect Apply Repaint, transactionally swap atlas, retry and export

**Files:**
- Modify: `apps/desktop/src/components/ModelViewer.tsx`
- Modify: `apps/desktop/src/components/ModelViewer.test.tsx`
- Modify: `apps/desktop/src/lib/tauri.ts`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: complete Local Repaint v1 UI flow and edited atlas handed to the existing GLB exporter.

- [ ] **Step 1: Add failing Apply-flow tests with mocked `localRepaint()`.** Build a known current atlas and mask, return a known edited patch PNG, click Apply, then assert the displayed/current atlas changed only inside mask+feather and the request contains prompt/reference.

- [ ] **Step 2: Add prompt-mode tests.** Three tests: prompt-only accepted; reference-only accepted; prompt+reference accepted. A fourth test asserts neither keeps Apply disabled and does not invoke Tauri.

- [ ] **Step 3: Add failure transaction test.** Mock `localRepaint()` rejection and assert the prior atlas object/pixel buffer is still the export source and the UI shows Retry/error status.

- [ ] **Step 4: Add sequential repaint test.** First response changes selected region A; second request source PNG must be encoded from the atlas containing A, proving repaint 2 starts from repaint 1 rather than the original GLB texture.

- [ ] **Step 5: Run RED.**

Run: `npm --prefix apps/desktop test -- --run src/components/ModelViewer.test.tsx src/lib/localRepaintAtlas.test.ts`

Expected: FAIL because Apply is not connected to IPC.

- [ ] **Step 6: Implement `handleApplyLocalRepaint()`.** Sequence must be exactly:

```text
validate mask + prompt/reference
-> capture current atlas snapshot
-> extract padded patch + mask patch
-> encode patch/mask PNG bytes
-> call localRepaint()
-> decode/validate edited PNG
-> composite into COPY of current atlas
-> build replacement Three.js texture
-> apply replacement to compatible materials
-> only now update currentAtlasRef/currentAtlas state
```

Never set `currentAtlasRef` before composite validation succeeds.

- [ ] **Step 7: Map worker stages into local status copy.** Keep the 3D renderer alive. Show `Preparing UV patch…`, `Downloading/preparing local repaint model…`, `Applying local repaint…`, `Compositing atlas…`; use the existing local repaint panel rather than the global `busy` overlay.

- [ ] **Step 8: Implement Cancel and Retry.** Cancel calls Task 5 `cancelLocalRepaint()`, marks status cancelled and preserves atlas. Retry reuses the same current mask/prompt/reference after worker recovery; it must generate a fresh temp job.

- [ ] **Step 9: Generalize textured GLB export so a repainted original atlas counts as editable texture even if the user never clicked `Import UV texture`.** `handleExportTexturedGlb` should gate on `currentAtlasRef` rather than `uvTextureInfo` only. Preserve existing direct-UV import/export behavior and UV texture transform.

- [ ] **Step 10: Clear the mask after successful repaint but not after failure/cancel.** This makes the accepted result visually unambiguous while preserving retry input on failure.

- [ ] **Step 11: Run GREEN.**

Run: `npm --prefix apps/desktop test -- --run`

Run: `npm --prefix apps/desktop run build`

Expected: PASS.

- [ ] **Step 12: Commit.**

```bash
git add apps/desktop/src/components/ModelViewer.tsx apps/desktop/src/components/ModelViewer.test.tsx apps/desktop/src/lib/tauri.ts apps/desktop/src/styles.css
git commit -m "feat: complete Local Repaint workflow"
```

---

### Task 8: Full regression verification, diagnostics, installer artifact and Radeon acceptance handoff

**Files:**
- Modify if needed after test evidence: `docs/roadmap/current-priorities.md`
- Modify if needed after test evidence: `docs/roadmap/texture-uv-stylization.md`
- No production refactor is allowed in this task unless a failing regression proves it is required.

**Interfaces:**
- Consumes: complete Local Repaint implementation.
- Produces: fresh CI evidence and a setup artifact for real RX 6950 XT acceptance.

- [ ] **Step 1: Run the complete Python backend suite.**

Run: `python -m pytest backends/hunyuan/tests backends/mesh_processing/tests -q`

Expected: PASS.

- [ ] **Step 2: Run complete frontend tests and build.**

Run: `npm --prefix apps/desktop test -- --run`

Run: `npm --prefix apps/desktop run build`

Expected: PASS.

- [ ] **Step 3: Run Rust core tests/checks.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features`

Run: `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: PASS.

- [ ] **Step 4: Verify installer payload without model weights.** Run the existing installer preparation/validation workflow; inspect the generated payload for `local_repaint.py` and `requirements-repaint.txt`. Confirm no SDXL/IP-Adapter weight files are bundled.

- [ ] **Step 5: Push and require fresh GitHub Actions success.** Record workflow run ids for Python worker, frontend, Rust and Windows installer. Do not claim hardware acceptance from CI.

- [ ] **Step 6: Hardware acceptance checklist on RX 6950 XT.** Install the new setup over the existing app/runtime. Confirm the installer reuses the Radeon/Hunyuan runtime and only adds missing repaint Python packages. Then:
  1. open a generated textured GLB,
  2. paint/erase/clear a visible mask,
  3. run prompt-only repaint,
  4. run reference-only repaint,
  5. run prompt+reference repaint,
  6. cancel one active repaint and retry successfully,
  7. verify unselected texture areas visually remain unchanged,
  8. make a second repaint based on the first,
  9. export GLB and reopen it,
  10. verify the Python console remains hidden.

- [ ] **Step 7: Record actual hardware evidence.** Capture cold first-use model download/load time, warm repaint time, any observed peak VRAM/OOM behavior, patch size and backend/model id in the diagnostic log. Numbers are evidence, not hard acceptance thresholds unless hardware testing shows a clear need for one.

- [ ] **Step 8: Update roadmap only after hardware result.** Mark Local Repaint v1 accepted only after the user confirms real installed-app behavior. If real SDXL+IP-Adapter is unstable on the RX 6950 XT, keep the UI/IPC contract unchanged and replace only `SdxlLocalRepaintBackend` with a lighter adapter implementation in a new RED→GREEN task; do not rewrite Tasks 1–5/7.

- [ ] **Step 9: Commit evidence/docs changes.**

```bash
git add docs/roadmap/current-priorities.md docs/roadmap/texture-uv-stylization.md
git commit -m "docs: record Local Repaint acceptance"
```

---

## Final Self-Review

### Spec coverage

- 3D brush Paint/Erase/Clear and brush size: Tasks 1–2.
- Prompt, reference, prompt+reference: Tasks 4–7.
- Atlas-space mask and padded patch: Tasks 1–3.
- Albedo-only transactional compositing: Tasks 3 and 7.
- Persistent local model cache and first-use download: Tasks 5–6.
- OOM/error recovery and cancellation: Task 5.
- Diagnostics: Tasks 5–6 and hardware verification in Task 8.
- Sequential edits and existing GLB export: Task 7.
- Installed-app/RX 6950 XT acceptance: Task 8.
- Explicit v1 exclusions remain excluded.

### Placeholder scan

The plan contains no TBD/TODO/"implement later" steps. The only runtime contingency is the one explicitly permitted by the approved spec: if SDXL/IP-Adapter fails real Radeon acceptance, the backend adapter is replaced behind the already implemented contract rather than changing product architecture.

### Type consistency

- Frontend byte request is `LocalRepaintRequest`; Rust converts it to path-based `LocalRepaintWorkerRequest`.
- Worker terminal events intentionally reuse `GenerateResult` fields so the existing persistent protocol parser does not gain a parallel terminal schema.
- `RepaintMask`, `EditableAtlas` and `PatchRect` are frontend-local pure data structures and never cross IPC.
- Current atlas ownership stays in `ModelViewer`; the Python worker only sees temporary patch files.

### Review Focus coverage

All five review-focus conditions have explicit tests in Tasks 1, 2, 3 and 5.
