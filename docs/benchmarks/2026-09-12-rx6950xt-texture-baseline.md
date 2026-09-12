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

| Run | Profile | Cache | Texture total | Model load | Inference | Dedicated/shared GPU memory | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Cold texture after app start | Balanced | Not measured yet | Not measured yet | Not measured yet | Not measured yet | Not measured yet | Not measured yet |
| Immediate repeated texture | Balanced | Not measured yet | Not measured yet | Not measured yet | Not measured yet | Not measured yet | Not measured yet |

These rows must be filled only from RX 6950 XT hardware measurements after the persistent worker is implemented.
