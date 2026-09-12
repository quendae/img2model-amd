# Persistent Worker, Auto Profile Tuning, and UV Roadmap Design

**Date:** 2026-09-12
**Status:** proposed for implementation
**Branch:** `feat/generation-texture-workflow`

## Context

The split Shape / Texture workflow is now validated on a Radeon RX 6950 XT 16 GiB under native Windows ROCm/TheRock. Hunyuan Paint is stable when the working mesh is reduced before texturing, and the new profile system provides enough information to tune defaults from measured behavior rather than assumptions.

Observed RX 6950 XT benchmark using the same source image and a 604,308-triangle generated mesh:

| Texture profile | Working triangles | Texture total | Inference | Result |
| --- | ---: | ---: | ---: | --- |
| Safe | 10,000 | 1:20 | 28 s | Success |
| Balanced | 20,000 | 1:07 | 31 s | Success |
| Quality | 40,000 | 1:18 | 41 s | Success |

The combined Shape + Texture run using Auto→Safe measured Shape 2:49, Texture 1:20, Total 4:09. Balanced was both stable and faster overall than Safe and Quality in this sample while retaining twice Safe's working mesh detail.

The timing split also shows that Hunyuan Paint inference is only part of the texture job. At Balanced, approximately 31 seconds of a 67-second texture job are inference; the remainder is model loading, preprocessing, UV/material setup, export, and process startup/teardown. Optimizing attention alone therefore cannot remove most of the current texture latency.

## Goals

1. Change the RX 6950 XT / ~16 GiB Auto texture policy from Safe 10k to Balanced 20k based on measured local results.
2. Keep Safe as the explicit low-memory profile and as the automatic OOM recovery target.
3. Replace per-job Python process startup for generation jobs with one Tauri-managed persistent worker process per app session.
4. Cache Hunyuan Paint across repeated texture jobs so model loading and initialization do not repeat unnecessarily.
5. Keep GPU/CPU memory bounded and make cache eviction explicit and observable.
6. Preserve real streamed progress, structured OOM handling, and the current no-silent-backend-fallback rule.
7. Record a staged UV/texture-authoring roadmap without implementing a full UV editor in this milestone.
8. Produce timing data that separates worker startup, model load, mesh preparation, inference, and export so later SageAttention/Triton/Vulkan work can target the actual bottleneck.

## Non-goals

This milestone does **not** implement TRELLIS.2, Vulkan inference, SageAttention, FlashAttention, custom Triton attention, quantization, Paint3D, MVPaint, a full UV editor, or game-ready final-polycount reduction. Those remain later benchmarks or features.

The persistent worker is not a daemon/service outside the app. It exists only for the lifetime of the desktop application and is owned by Tauri.

## Decision 1: Auto uses Balanced on approximately 16 GiB GPUs

The texture profile policy becomes:

- **Safe:** 10,000 working triangles, CPU model offload ON, max attention slicing.
- **Balanced:** 20,000 working triangles, CPU model offload ON, max attention slicing.
- **Quality:** 40,000 working triangles, CPU model offload ON, max attention slicing.
- **Auto:**
  - up to and including approximately 16.5 GiB VRAM → Balanced,
  - larger GPUs → Balanced until additional hardware data justifies a higher automatic tier.

This intentionally makes Auto conservative about memory features while less conservative about mesh reduction. Auto does **not** become Quality on larger GPUs in this milestone because there is no benchmark evidence yet that 40k is a better default.

### OOM recovery

If Auto/Balanced runs out of memory, the existing recovery path offers **Retry with Safe** using the same source image and preserved mesh. Auto is not dynamically downgraded mid-job because an automatic retry could consume several more minutes without user consent.

## Decision 2: One persistent worker process owned by Tauri

### Process lifecycle

Tauri owns one long-lived Python worker process for generation work. The process starts lazily on the first Shape or Texture request and exits when:

- the application closes,
- the user requests **Restart worker**,
- the worker crashes and Tauri marks the session unhealthy,
- a protocol violation makes the process unsafe to reuse.

Diagnostics may still use short one-shot commands where convenient, but Shape and Texture generation use the persistent session.

The worker gains a `serve` command that reads newline-delimited JSON commands from stdin and emits newline-delimited JSON events on stdout. Human-readable logs remain on stderr so stdout stays machine-parseable.

### Protocol

Every command and event carries a `job_id`.

Example request:

```json
{"command":"texture","job_id":"job-42","request":{"mesh":"...","image":"...","output":"...","profile":"balanced"}}
```

Example streamed events:

```json
{"job_id":"job-42","event":"progress","stage":"loading_model","progress":0.22}
{"job_id":"job-42","event":"progress","stage":"running_texture","progress":0.35}
{"job_id":"job-42","event":"completed","ok":true,"output":"...","resolved_profile":"balanced"}
```

Control commands:

- `ping` — confirms worker responsiveness and protocol version.
- `shape` — runs one shape job.
- `texture` — runs one texture job.
- `clear_cache` — releases cached pipelines and calls Python/torch garbage collection.
- `shutdown` — graceful exit.

The first implementation processes one generation job at a time. Concurrent Shape/Texture execution is explicitly unsupported.

## Decision 3: Logical Shape and Paint cache slots with bounded residency

The worker exposes two logical cache slots:

- Shape pipeline cache.
- Hunyuan Paint pipeline cache.

However, the default cache policy is **bounded single-heavy-pipeline residency**. The two slots are logical, not permission to keep both heavyweight pipelines fully resident simultaneously.

### Why

The validated texture run on the 16 GiB card previously pushed dedicated VRAM and shared system memory close to their limits. Keeping both Shape and Paint initialized at the same time could increase RAM/VRAM pressure and make the persistent worker slower or less stable than the current one-shot design.

### Eviction policy

For this milestone:

1. Repeated Texture jobs reuse the cached Hunyuan Paint pipeline.
2. Repeated Shape jobs may reuse the cached Shape pipeline.
3. Switching from Shape→Texture or Texture→Shape may evict the other heavyweight pipeline before loading the requested one.
4. Cache eviction performs `del`, Python `gc.collect()`, and `torch.cuda.empty_cache()` when CUDA/ROCm is available.
5. The worker emits cache events so the UI/timing report can distinguish `cache_hit`, `cache_miss`, `evicted_shape`, and `evicted_texture`.

This design optimizes the important repeated-texture workflow while avoiding an assumption that the machine has enough RAM to retain both models.

A later benchmark may permit dual residency on systems with significantly more RAM/VRAM, but it is not automatic in this milestone.

## Decision 4: Tauri session manager

Rust gains a process/session manager stored in Tauri application state. Its responsibilities are:

- spawn the Python `serve` worker with the configured persistent runtime Python and worker path,
- set `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` unless the user already supplied a value,
- serialize requests so only one generation job runs at once,
- write one JSON command to stdin,
- continuously read stdout and route events by `job_id` into the existing Tauri `Channel`,
- drain stderr concurrently to avoid deadlocks,
- detect EOF/crash/protocol errors,
- expose restart/clear-cache operations,
- never silently switch compute backend or Python runtime.

The existing one-shot argument builders remain useful for CLI/smoke tests but desktop generation commands move to the persistent protocol.

## Decision 5: Failure and recovery behavior

### Worker crash

If the Python process exits unexpectedly:

- the active job fails with a normalized `worker_crashed` error,
- a completed Shape file remains preserved exactly as today,
- Tauri discards the broken session object,
- the next user-started job may create a fresh worker,
- the UI shows **Restart worker** when the session is unhealthy.

There is no automatic replay of the failed ML job.

### OOM

For a texture OOM:

- preserve the input/generated Shape,
- clear the persistent model cache before retry,
- offer **Retry texture only** and **Retry with Safe**,
- the retry uses a fresh/clean texture pipeline state rather than assuming the OOMed pipeline is reusable.

For a Shape OOM, surface the error and clear the cached Shape pipeline before the next attempt.

### Protocol corruption

Any non-JSON content on stdout, mismatched `job_id`, or unexpected terminal event invalidates the session. Logs belong on stderr.

## Decision 6: Timing and benchmark instrumentation

The worker should report enough boundaries to measure:

- process startup / handshake,
- cache lookup,
- model load,
- image preparation,
- mesh preprocessing,
- texture inference,
- export/postprocessing,
- total job time.

The UI Activity panel keeps the current concise Shape / Texture / Total display and may add `Load`, `Inference`, and `Cache hit` when those values are known.

The benchmark log stored in the repo should capture at least:

- GPU model and VRAM,
- profile requested/resolved,
- source triangle count and working triangle count,
- cold texture total,
- warm texture total,
- inference time,
- cache hit/miss,
- success/OOM,
- optional observed dedicated/shared GPU memory from Task Manager.

Success for the persistent-worker milestone is not defined as a fixed percentage speedup. It is defined as removing repeated pipeline initialization where technically possible, proving that warm repeated texture jobs are faster or no worse, and not regressing stability/memory behavior.

## Decision 7: UV and texture-authoring roadmap

The current Hunyuan Paint pipeline automatically prepares the mesh and produces/bakes texture coordinates/material output. The user does not currently choose UV islands or directly assign source-image regions to selected surfaces.

Manual texture authoring is useful, especially for stylized/game assets and for correcting stretched side surfaces, but a full Blender-like UV editor is too large for the current optimization milestone.

Implement later in this order:

### Phase A — UV debug tools

- Display/export current texture atlas.
- Export/show UV wireframe over the texture image.
- Show material/texture resolution and UV availability.
- Highlight a selected mesh face/group and its corresponding UV region where possible.

### Phase B — Surface patch projection

- Click/select faces or a connected surface region in the 3D viewer.
- Select a rectangular region from the source image or texture atlas.
- Choose planar or box projection.
- Project/bake that patch onto the selected surface.
- Support undo/reset for the manual patch.

This is intentionally simpler than direct vertex-level UV editing and should solve many practical corrections, such as replacing smeared side textures.

### Phase C — Advanced UV editing

Only if Phases A/B prove insufficient:

- UV island selection,
- move/scale/rotate islands,
- pinning,
- seam editing,
- repacking,
- manual rebake.

## Implementation sequence

1. Update Auto policy and tests: ~16 GiB resolves to Balanced; Safe remains OOM recovery.
2. Add benchmark documentation for the current Safe/Balanced/Quality RX 6950 XT results.
3. Add persistent `serve` protocol to the Python worker with protocol unit tests.
4. Add explicit pipeline cache abstraction and bounded eviction policy.
5. Add Tauri persistent worker session manager and streamed event routing.
6. Switch Shape/Texture desktop commands to the session manager.
7. Add clear-cache/restart-worker handling and crash/OOM tests.
8. Extend timing metadata for cold vs warm jobs.
9. Run full CI.
10. Hardware validation on RX 6950 XT: cold Balanced texture, immediate second warm Balanced texture, profile changes, OOM recovery, app restart.
11. Record cold/warm benchmark results before evaluating SageAttention/Triton/quantization.

## Acceptance criteria

- Auto resolves to Balanced 20k on the validated RX 6950 XT 16 GiB system.
- Safe remains available and is the retry target after texture OOM.
- Two consecutive texture jobs in one app session can reuse Hunyuan Paint without spawning a new Python process between them.
- The second job reports a cache hit when the cached pipeline is reusable.
- Switching workload type obeys the bounded cache policy and does not leave both heavyweight pipelines resident by default.
- Worker crash or OOM does not delete a completed Shape and does not trigger an automatic rerun.
- Restart worker and clear-cache behavior are explicit and testable.
- Existing streamed progress remains responsive.
- Frontend, Python worker, Rust core, and Windows desktop CI pass.
- A real RX 6950 XT cold/warm texture benchmark is recorded after implementation.
- UV work remains documented only; no full UV editor is introduced in this milestone.

## Follow-up optimization order

After the persistent-worker benchmark, optimize based on measured time distribution rather than model reputation:

1. Reduce/reuse model loading and preprocessing overhead.
2. Evaluate texture steps/view count/resolution only if quality remains acceptable.
3. Benchmark attention alternatives such as SageAttention/Triton only when a compatible AMD path exists and passes correctness + memory tests.
4. Evaluate quantization if it materially lowers memory or improves throughput without unacceptable quality loss.
5. Benchmark TRELLIS.2 and Vulkan as separate workloads/backends rather than assuming Vulkan is automatically faster than ROCm.
6. Begin UV Debug Phase A when generation performance/stability is satisfactory.
