# Img2Model AMD — Generation and Texture Workflow Design

**Date:** 2026-09-12  
**Project:** `quendae/img2model-amd`  
**Branch:** `feat/workflow-profiles-design`  
**Status:** Design approved in chat; implementation plan pending user review of this written spec.

## 1. Purpose

Refine the current Hunyuan3D workflow into a robust desktop generation flow for AMD GPUs, with special focus on the Radeon RX 6950 XT 16 GB target.

The current pipeline has already proven that native Windows ROCm/TheRock can generate a Hunyuan3D-2 Mini shape and can also complete Hunyuan Paint texturing. However, Hunyuan Paint can saturate essentially all available VRAM, spill heavily into shared GPU memory/system RAM, take several times longer than shape generation, and occasionally fail with an out-of-memory error.

The product therefore needs to treat shape generation and texturing as related but independent jobs.

This design also prepares the application for future alternative workloads such as TRELLIS.2 and alternative compute backends such as Vulkan, without making either a dependency of the current Hunyuan MVP.

## 2. Goals

The immediate implementation must:

- keep the desktop UI responsive during all inference jobs,
- let the user generate either a model only or a model plus texture,
- let the user texture an existing GLB/OBJ without regenerating shape,
- preserve a successful shape when texturing fails,
- provide one-click recovery after texture OOM,
- expose simple memory/quality profiles for Hunyuan Paint,
- report meaningful progress and stage timings,
- report mesh reduction statistics,
- isolate texture-engine-specific configuration from the React UI,
- keep room for later Hunyuan optimization, TRELLIS.2, and Vulkan work.

## 3. UX Structure

The Generation panel uses one top-level mode switch:

- **Shape**
- **Texture**

This is intentionally one panel rather than two permanent side-by-side panels.

### 3.1 Shape mode

Shape mode shows the current Hunyuan shape controls:

- backend,
- shape quality profile: Fast / Balanced / Quality,
- steps,
- seed,
- remove background.

It adds an **Output** choice:

- **Model only**
- **Model + texture**

If `Model + texture` is selected, the texture profile controls are also shown before generation.

The main action reads either:

- `Generate model`
- `Generate model + texture`

For `Model + texture`, the user selects the final output path. The successful shape is preserved beside it with the `-shape` suffix before the texture job starts.

### 3.2 Texture mode

Texture mode accepts:

- source image,
- existing mesh path (`.glb` or `.obj`),
- texture engine,
- texture profile,
- output path.

For the first implementation, the only texture engine is:

- `Hunyuan Paint`

The engine selector is still part of the conceptual model so a future engine can be added without redesigning the whole workflow.

The primary action is:

- `Generate texture`

### 3.3 Texture profiles

All four profiles are visible directly in the main panel:

- **Auto**
- **Safe**
- **Balanced**
- **Quality**

No Advanced drawer is required for the first implementation.

Initial policy:

| Profile | Texture working triangle limit | CPU offload | Attention slicing | Allocator |
| --- | ---: | --- | --- | --- |
| Auto | based on detected VRAM | automatic | automatic | expandable segments |
| Safe | 10,000 | on | max | expandable segments |
| Balanced | 20,000 | on | max | expandable segments |
| Quality | 40,000 | on | max | expandable segments |

For the first implementation, `Auto` resolves GPUs with approximately 16 GiB VRAM or less to `Safe`. Larger cards default to `Balanced` until benchmark data justifies more aggressive automatic thresholds.

These triangle counts are policy defaults, not permanent model limitations. They must remain easy to tune after benchmark data is collected.

## 4. Job Architecture

Shape and texture are separate worker jobs even when the user selects `Model + texture`.

```text
Source image
   |
   v
Shape job
   |
   +--> preserved *-shape.glb
   |
   v
Shape worker exits / resources are released
   |
   v
Texture job
   |
   v
Final textured GLB/OBJ
```

This separation is mandatory for reliability on memory-constrained cards.

A successful shape job must never be discarded because a later texture job fails.

## 5. Frontend State Model

Introduce explicit workflow state rather than continuing to encode all behavior through one `texture: boolean` flag.

Conceptual types:

```ts
type WorkflowMode = 'shape' | 'texture';
type ShapeOutputMode = 'model-only' | 'model-and-texture';
type TextureProfile = 'auto' | 'safe' | 'balanced' | 'quality';
type TextureEngineId = 'hunyuan-paint';
```

The React app should not know the low-level flags required by Hunyuan Paint. It chooses a profile and engine; backend orchestration resolves that into worker arguments.

The current `App.tsx` already owns image selection, shape generation, texture generation, progress and error state. This feature should reduce rather than increase that concentration of responsibilities.

Move job orchestration into a focused hook/controller such as:

```text
src/lib/useGenerationJob.ts
```

or an equivalent small module following existing project conventions.

The controller owns:

- running state,
- current stage,
- streamed worker progress,
- stage timing,
- preserved shape path,
- texture retry context,
- normalized failure classification,
- final result path.

`App.tsx` remains responsible for composing panels and passing the current output to the viewer.

## 6. Texture Engine Boundary

Introduce a conceptual texture-engine adapter.

```text
TextureEngine
   |
   +-- HunyuanPaintEngine
```

The initial public request shape should resemble:

```ts
{
  engine: 'hunyuan-paint',
  profile: 'auto',
  mesh,
  image,
  output
}
```

The Rust/worker side resolves the profile into concrete parameters such as:

- maximum working triangles,
- CPU offload,
- attention slicing,
- allocator policy,
- future attention implementation.

The first implementation should not add Paint3D or MVPaint. The boundary exists so a future implementation can add another engine without coupling its flags to the main UI.

## 7. OOM Recovery

Texture OOM is a first-class failure category.

The worker/backend layer should normalize common memory errors into a structured failure such as:

```text
kind: out_of_memory
stage: texture
preserved_shape: <path>
```

The UI then presents a concise message instead of only a raw traceback:

> Texture generation ran out of GPU memory. The generated shape was preserved successfully.

Actions:

- **Retry texture only** — same settings and same preserved mesh,
- **Retry with Safe** — immediately retry with the Safe texture profile when the failed profile was not already Safe,
- **Open Texture mode** — switch modes and preload the image and preserved mesh.

The full worker traceback remains available as technical details/log output.

No retry action may regenerate shape unless the user explicitly starts a new shape generation.

## 8. Progress and Timings

Continue using the existing streamed worker events through the Tauri channel.

Progress remains based on actual worker stage events rather than a fake timer.

For `Model only`, shape progress occupies the full progress range.

For `Model + texture`, use an initial overall weighting of:

- shape: 25%
- texture: 75%

This weighting reflects observed local behavior where texturing takes at least several times longer than shape generation. It is not presented as an ETA.

Track timings for meaningful stages, including where available:

- shape total,
- texture preparation,
- texture model loading,
- texture inference,
- texture postprocessing/export,
- overall total.

Example completion summary:

```text
Shape: 01:32
Texture: 04:48
Total: 06:20
Mesh: 40,000 -> 10,000 triangles
Profile: Safe
```

## 9. Mesh Budget and Future Game-Ready Controls

Hunyuan Paint preprocessing already reduces the working mesh before texturing. The budget is measured as triangular faces after triangulation, so the UI and logs call them **triangles** consistently.

The texture profiles use that reduction path to control memory use.

Separately, the already planned game-ready output controls remain a product feature:

- Mobile: 500 triangles
- Low: 1,000
- Medium: 2,500
- High: 5,000
- Hero: 10,000
- Quality/working maximum: 40,000
- Custom: 300–40,000

The implementation must keep these two concepts distinguishable:

1. **texture working triangle budget** — controls inference cost and reliability,
2. **final game-ready triangle target** — controls exported asset complexity.

They may initially share the same decimation machinery, but the UI meaning is different and must not be conflated silently.

## 10. Memory Policy for 16 GB AMD

For the validated RX 6950 XT class target, conservative texture defaults are required.

Initial Safe behavior:

- CPU model offload enabled,
- maximum Diffusers attention slicing,
- `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` supplied to the worker environment,
- texture working mesh limited to approximately 10k triangles,
- shape and texture run as separate processes/jobs,
- no silent fallback to another compute backend.

The allocator setting may reduce fragmentation but is not treated as a guarantee against OOM.

## 11. Attention and Inference Optimization Strategy

Performance optimization is explicitly part of the roadmap, but it must be benchmark-driven and capability-gated.

Potential techniques include:

- PyTorch scaled-dot-product attention backend selection,
- SageAttention where supported,
- FlashAttention-compatible implementations where supported,
- Triton-based kernels,
- lower precision / quantization,
- reduced texture denoising steps,
- fewer multiview texture views,
- lower intermediate render resolution,
- model-specific turbo/distilled variants,
- better memory scheduling and explicit model unloads.

### 11.1 SageAttention

Hunyuan3D-family code has upstream support paths for SageAttention in newer shape code, so SageAttention is a legitimate optimization candidate.

It must not be enabled blindly on the RX 6950 XT target.

Current AMD/Windows support is fragmented and often depends on experimental ROCm/Triton forks. The target `gfx1030` is particularly important because TheRock currently supports the device but excludes some ROCm components used by common optimized attention implementations, including Composable Kernel and hipBLASLt in the current target configuration.

Therefore the app should eventually use an **attention backend probe** rather than a hard-coded SageAttention switch.

Conceptual selection:

```text
Attention backend
├─ Auto
├─ PyTorch SDPA
├─ SageAttention          (only if capability test passes)
└─ Experimental backend   (future)
```

`Auto` chooses an alternative only after a startup/runtime microbenchmark verifies:

- import/build success,
- numerical correctness within tolerance,
- no crash on the detected GPU,
- lower or equal peak memory,
- meaningful speed improvement on the actual workload.

If an optimized attention implementation is slower or unstable, Auto keeps the known-good path.

### 11.2 Hunyuan Paint-specific optimization

Hunyuan Paint is based on a multiview diffusion/UNet-style texture pipeline, so potential attention substitutions are worth investigating, but no current speedup is assumed until measured on the target Windows/TheRock stack.

The first optimization pass should benchmark low-risk knobs before adding custom kernel dependencies:

1. texture inference step count,
2. number of generated views,
3. texture/intermediate resolution,
4. attention slicing policy,
5. CPU offload strategy,
6. texture working triangle budget,
7. PyTorch allocator configuration.

Only then should SageAttention/Triton/quantized kernels be introduced experimentally.

## 12. Workload and Compute Backend Model

The application should distinguish the **generation workload/model family** from the **compute backend**.

Target architecture:

```text
Workload
├─ Hunyuan3D
│  ├─ Shape
│  └─ Hunyuan Paint
│
└─ TRELLIS.2                 (future)
   └─ image -> textured mesh

Compute backend
├─ Native ROCm / TheRock
├─ WSL2 ROCm                 (compatibility path)
└─ Vulkan                    (experimental / workload-dependent)
```

A backend is not assumed to work with every workload.

For example, current Hunyuan Python/PyTorch inference cannot become a Vulkan implementation merely by changing one runtime flag. Vulkan support requires an implementation/runtime that actually targets Vulkan.

## 13. TRELLIS.2 Roadmap

TRELLIS.2 should be evaluated later as an alternative complete image-to-textured-3D workload.

It is especially interesting because community/native implementations now expose non-CUDA paths, including Vulkan and AMD-oriented variants.

TRELLIS is not part of this first workflow refactor.

A later benchmark should compare, on the same source images:

- Hunyuan shape + Paint on native ROCm,
- TRELLIS.2 on native ROCm where practical,
- TRELLIS.2 Vulkan implementation where practical.

Compare:

- total runtime,
- peak dedicated VRAM,
- shared GPU memory use,
- system RAM,
- geometry quality,
- texture quality,
- seams/artifacts,
- output GLB size,
- setup complexity and reliability.

## 14. Vulkan Strategy

Vulkan is important as a future backend, but is not assumed to be faster than ROCm.

It can be attractive because a purpose-built native runtime may offer:

- easier packaging,
- less Python/runtime complexity,
- quantized model support,
- potentially lower VRAM use,
- broad AMD hardware access.

ROCm/PyTorch may remain faster for workloads whose optimized tensor kernels are already mature.

The product should therefore treat Vulkan as a benchmarked backend per workload, not a global performance switch.

## 15. Testing

### 15.1 Functional regression matrix

Using the same source image:

1. Shape -> Model only.
2. Shape -> Model + texture.
3. Texture -> existing GLB/OBJ.
4. Texture OOM -> Retry texture only.
5. Texture OOM -> Retry with Safe.
6. Second generation in the same app session.
7. App restart -> runtime and texture engine still detected.

### 15.2 Texture profile benchmark

Run the same preserved shape through:

- Safe,
- Balanced,
- Quality.

Capture:

- elapsed time,
- stage timings,
- triangles before/after preprocessing,
- peak VRAM if available,
- shared GPU memory observation,
- pass/OOM result,
- visual texture quality.

### 15.3 Optimization experiments

Every experimental optimization must use an A/B benchmark against the stable baseline.

Do not keep an optimization solely because it imports or runs. It must prove a useful improvement in at least one of:

- runtime,
- memory,
- quality at equal runtime,
- reliability.

## 16. First Implementation Scope

Implement now:

- Shape / Texture modes in one Generation panel,
- Model only / Model + texture output choice,
- existing-model texture-only flow,
- Hunyuan Paint texture engine adapter boundary,
- Auto / Safe / Balanced / Quality texture profiles,
- <=16 GiB Auto -> Safe policy,
- `expandable_segments` worker environment,
- independent shape and texture jobs,
- OOM classification and retry actions,
- stage timings,
- mesh triangle before/after reporting,
- existing streamed progress integration,
- tests for the above behavior.

Do not implement in this iteration:

- TRELLIS.2,
- Paint3D,
- MVPaint,
- Vulkan inference implementation,
- SageAttention installation,
- FlashAttention installation,
- custom Triton kernels,
- quantization.

Those remain follow-up benchmark/optimization work after the stable split workflow is complete.

## 17. Acceptance Criteria

The feature is ready for local RX 6950 XT validation when:

- the UI can generate shape only,
- the UI can generate shape then texture,
- the UI can texture an existing mesh directly,
- failed texture generation never destroys or hides the preserved shape,
- OOM exposes texture-only retry without recomputing shape,
- Auto resolves to a conservative profile on a 16 GB GPU,
- progress remains live and the app remains responsive,
- completion reports timing and mesh stats,
- existing diagnostics and viewer functionality still work,
- automated frontend/Python/Rust checks pass.

## 18. Follow-up Optimization Order

After the workflow refactor passes local regression testing:

1. benchmark Hunyuan Paint Safe / Balanced / Quality,
2. tune view count, resolution and texture steps,
3. add an attention-backend capability/microbenchmark probe,
4. investigate SageAttention/Triton on the actual gfx1030 Windows/TheRock stack,
5. investigate low-precision/quantized Paint variants,
6. benchmark TRELLIS.2 as a second workload,
7. compare TRELLIS.2 ROCm vs Vulkan,
8. only promote a new backend or optimization to Auto after measured stability and speed/memory gains.

## 19. Final Direction

Keep Hunyuan3D as the current production workload, but redesign generation around independently recoverable shape and texture jobs.

Optimize first for reliability on 16 GB AMD hardware, then performance. Keep texture engines, model workloads, compute backends and attention implementations as separate concerns so future TRELLIS, Vulkan and attention optimizations can be added without another UI or orchestration rewrite.
