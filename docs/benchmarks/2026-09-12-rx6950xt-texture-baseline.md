# RX 6950 XT Hunyuan Paint baseline — 2026-09-12

Source generated mesh: **604,308 triangles**  
GPU: **AMD Radeon RX 6950 XT, ~16 GiB**  
Runtime: **Windows native ROCm/TheRock**

| Profile | Working triangles | Texture total | Inference | Result |
| --- | ---: | ---: | ---: | --- |
| Safe | 10,000 | 1:20 | 28 s | Success |
| Balanced | 20,000 | 1:07 | 31 s | Success |
| Quality | 40,000 | 1:18 | 41 s | Success |

Combined Auto→Safe run before retuning:

- Shape: 2:49
- Texture: 1:20
- Total: 4:09

## Decision

Auto on this validated ~16 GiB Radeon class changes to **Balanced / 20,000 working triangles**. Safe remains the explicit low-memory profile and the OOM recovery target.

## Persistent-worker cold/warm results

| Run | Profile | Cache | Texture total | Model load | Prep | Inference | Export | Mesh | Dedicated/shared GPU memory | Result |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| Cold texture after app start | Balanced | miss · texture | 1:28 | 22 s | 30 s | 32 s | 0 s | 604,308 → 20,000 | Not measured | Success |
| Immediate repeated texture | Balanced | hit · texture | 59 s | 0 s | 30 s | 30 s | 0 s | 604,308 → 20,000 | Not measured | Success |

Hardware measurements were captured from the desktop Activity panel on the RX 6950 XT after the persistent worker implementation.

### Observations

- Reusing the cached Hunyuan Paint pipeline reduced end-to-end texture time from **88 s to 59 s**, a reduction of **29 s (~33%)** for the immediate repeated run.
- Reported model-load time fell from **22 s to 0 s**, confirming that the persistent worker removes the heavyweight Hunyuan Paint reload on a cache hit.
- The warm run is now dominated almost equally by **mesh preprocessing (~30 s)** and **texture inference (~30 s)**.
- Because preprocessing is repeated even for the identical mesh/profile, caching or reusing the prepared 20k working mesh is the next low-risk optimization candidate before or alongside inference-kernel work.
- SageAttention/Triton-style inference optimization can only attack roughly the inference half of the current warm path; it cannot remove the ~30 s preprocessing cost.
