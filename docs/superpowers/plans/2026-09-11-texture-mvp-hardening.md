# Texture MVP Hardening Plan

**Goal:** Turn the hardware-proven RX 6950 XT Hunyuan Paint path into the normal worker flow, with no one-off BAT patches required.

**Validated hardware path:** Windows + TheRock/ROCm, Radeon RX 6950 XT 16 GB, Hunyuan3D-2 Paint, official mesh cleanup/reduction, CPU model offload, and maximum Diffusers attention slicing.

## Scope

- Keep shape and texture as separate stages so a texture failure never destroys a good shape.
- Keep the official Hunyuan cleanup flow: `FloaterRemover -> DegenerateFaceRemover -> FaceReducer`.
- Keep `40000` as the safe upper working-mesh limit, not as a claim that 40k triangles are game-ready.
- Make the validated 16 GB memory profile the default: CPU offload + MAX attention slicing.
- Preserve explicit opt-out flags for higher-memory GPUs.
- Keep the `trust_remote_code=True` compatibility shim scoped only to Hunyuan Paint's bundled local Diffusers pipeline.

## Tasks

- [x] Add official mesh preprocessing before Paint.
- [x] Add regression tests for the official 40k preprocessing flow.
- [x] Validate the ROCm/HIP texture extensions on RX 6950 XT.
- [x] Validate an actual textured GLB on RX 6950 XT.
- [x] Write RED tests requiring CPU offload + MAX attention slicing as defaults.
- [ ] Make CPU offload + MAX attention slicing the worker defaults and keep opt-out controls.
- [ ] Emit the active memory profile in texture progress/completion events.
- [ ] Run Python, frontend, Rust, and Windows CI to green.
- [ ] Update the PR description and README with the hardware-validated path.

## Acceptance criteria

The normal `worker.py texture` command, with no test BAT and no extra patching, must use the same configuration that produced the successful RX 6950 XT textured log asset:

- mesh cleanup + reduction (`--max-faces 40000` by default),
- CPU model offload enabled by default,
- multiview attention slicing set to `max` by default,
- explicit `--no-cpu-offload` and `--attention-slicing off` escape hatches,
- separate output path so the original shape survives any texture failure.

A successful run must report the face count before/after preprocessing plus the selected memory profile in its JSON events.
