#!/usr/bin/env python3
"""Img2Model AMD Hunyuan worker.

The worker deliberately keeps ML imports lazy. The desktop app must be able to
run diagnostics before PyTorch or Hunyuan3D has been installed.
"""

from __future__ import annotations

import argparse
import gc
import importlib.util
import json
import platform
import sys
import time
from pathlib import Path
from typing import Any, Callable


TEXTURE_PROFILES = {
    "safe": {"max_faces": 10_000, "cpu_offload": True, "attention_slicing": "max"},
    "balanced": {"max_faces": 20_000, "cpu_offload": True, "attention_slicing": "max"},
    "quality": {"max_faces": 40_000, "cpu_offload": True, "attention_slicing": "max"},
}

PROTOCOL_VERSION = 1
_CURRENT_JOB_ID: str | None = None
_EVENT_SINK: Callable[[dict[str, Any]], None] | None = None


def emit(event: str, **values: Any) -> None:
    payload = {"event": event, **values}
    if _CURRENT_JOB_ID is not None:
        payload["job_id"] = _CURRENT_JOB_ID
    if _EVENT_SINK is not None:
        _EVENT_SINK(payload)
        return
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def _emit_payload(payload: dict[str, Any]) -> None:
    values = dict(payload)
    event = str(values.pop("event", "cache"))
    emit(event, **values)


def module_available(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ModuleNotFoundError, ValueError):
        return False


def release_torch_memory() -> None:
    gc.collect()
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


class PipelineCache:
    """Bounded cache for one heavyweight Hunyuan pipeline at a time."""

    def __init__(self, event_sink: Callable[[dict[str, Any]], None] | None = None) -> None:
        self.shape_pipeline: Any | None = None
        self.shape_key: tuple[Any, ...] | None = None
        self.texture_pipeline: Any | None = None
        self.texture_key: tuple[Any, ...] | None = None
        self.event_sink = event_sink

    def _event(self, stage: str, cache_kind: str, cache_hit: bool | None = None) -> None:
        if self.event_sink is None:
            return
        payload: dict[str, Any] = {
            "event": "cache",
            "stage": stage,
            "cache_kind": cache_kind,
        }
        if cache_hit is not None:
            payload["cache_hit"] = cache_hit
        self.event_sink(payload)

    def clear_shape(self, *, evicted: bool = False) -> None:
        if self.shape_pipeline is None:
            self.shape_key = None
            return
        pipeline = self.shape_pipeline
        self.shape_pipeline = None
        self.shape_key = None
        del pipeline
        release_torch_memory()
        self._event("evicted_shape" if evicted else "cache_cleared", "shape")

    def clear_texture(self, *, evicted: bool = False) -> None:
        if self.texture_pipeline is None:
            self.texture_key = None
            return
        pipeline = self.texture_pipeline
        self.texture_pipeline = None
        self.texture_key = None
        del pipeline
        release_torch_memory()
        self._event("evicted_texture" if evicted else "cache_cleared", "texture")

    def clear(self) -> None:
        had_shape = self.shape_pipeline is not None
        had_texture = self.texture_pipeline is not None
        self.clear_shape()
        self.clear_texture()
        if not had_shape and not had_texture:
            self._event("cache_cleared", "all")

    def get_shape_pipeline(
        self,
        loader: Callable[[], Any],
        key: tuple[Any, ...] = (),
    ) -> tuple[Any, bool]:
        if self.texture_pipeline is not None:
            self.clear_texture(evicted=True)
        if self.shape_pipeline is not None and self.shape_key == key:
            self._event("cache_hit", "shape", True)
            return self.shape_pipeline, True
        if self.shape_pipeline is not None:
            self.clear_shape(evicted=True)
        self._event("cache_miss", "shape", False)
        self.shape_pipeline = loader()
        self.shape_key = key
        return self.shape_pipeline, False

    def get_texture_pipeline(
        self,
        loader: Callable[[], Any],
        key: tuple[Any, ...] = (),
    ) -> tuple[Any, bool]:
        if self.shape_pipeline is not None:
            self.clear_shape(evicted=True)
        if self.texture_pipeline is not None and self.texture_key == key:
            self._event("cache_hit", "texture", True)
            return self.texture_pipeline, True
        if self.texture_pipeline is not None:
            self.clear_texture(evicted=True)
        self._event("cache_miss", "texture", False)
        self.texture_pipeline = loader()
        self.texture_key = key
        return self.texture_pipeline, False


def recover_pipeline_cache_after_error(
    cache: PipelineCache | None,
    cache_kind: str,
    error_kind: str,
) -> None:
    """Discard only a pipeline that may be unsafe after an OOM."""

    if cache is None or error_kind != "out_of_memory":
        return
    if cache_kind == "shape":
        cache.clear_shape()
        return
    if cache_kind == "texture":
        cache.clear_texture()
        return
    raise ValueError(f"Unsupported cache kind: {cache_kind}")


def health_payload() -> dict[str, Any]:
    torch_available = module_available("torch")
    hunyuan_available = module_available("hy3dgen")
    hunyuan_import_ok = False
    torch_version: str | None = None
    hip_version: str | None = None
    gpu_available = False
    device_name: str | None = None
    errors: list[str] = []

    if torch_available:
        try:
            import torch  # type: ignore

            torch_version = getattr(torch, "__version__", None)
            version = getattr(torch, "version", None)
            hip_version = getattr(version, "hip", None) if version else None
            gpu_available = bool(torch.cuda.is_available())
            if gpu_available:
                device_name = torch.cuda.get_device_name(0)
        except Exception as exc:
            errors.append(f"PyTorch probe failed: {type(exc).__name__}: {exc}")

    if hunyuan_available:
        try:
            from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline  # type: ignore  # noqa: F401

            hunyuan_import_ok = True
        except Exception as exc:
            errors.append(f"Hunyuan import failed: {type(exc).__name__}: {exc}")

    usable = bool(
        torch_available
        and hunyuan_available
        and hunyuan_import_ok
        and hip_version
        and gpu_available
    )
    return {
        "ok": usable,
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "torch_available": torch_available,
        "hunyuan_available": hunyuan_available,
        "hunyuan_import_ok": hunyuan_import_ok,
        "torch_version": torch_version,
        "hip_version": hip_version,
        "gpu_available": gpu_available,
        "device_name": device_name,
        "error": "; ".join(errors) if errors else None,
    }


def texture_health_payload() -> dict[str, Any]:
    texgen_available = module_available("hy3dgen.texgen")
    custom_rasterizer_detected = module_available("custom_rasterizer")
    mesh_processor_detected = module_available("mesh_processor")
    custom_rasterizer_available = False
    mesh_processor_available = False
    texture_import_ok = False
    errors: list[str] = []

    if texgen_available:
        try:
            from hy3dgen.texgen import Hunyuan3DPaintPipeline  # type: ignore  # noqa: F401

            texture_import_ok = True
        except Exception as exc:
            errors.append(f"Hunyuan texture import failed: {type(exc).__name__}: {exc}")
    else:
        errors.append("hy3dgen.texgen is not installed")

    if custom_rasterizer_detected:
        try:
            import custom_rasterizer  # type: ignore  # noqa: F401
            import custom_rasterizer_kernel  # type: ignore  # noqa: F401

            custom_rasterizer_available = True
        except Exception as exc:
            errors.append(f"custom_rasterizer import failed: {type(exc).__name__}: {exc}")
    else:
        errors.append("custom_rasterizer is not installed")

    if mesh_processor_detected:
        try:
            import mesh_processor  # type: ignore  # noqa: F401

            mesh_processor_available = True
        except Exception as exc:
            errors.append(f"mesh_processor import failed: {type(exc).__name__}: {exc}")
    else:
        errors.append("mesh_processor is not installed")

    usable = bool(
        texgen_available
        and custom_rasterizer_available
        and mesh_processor_available
        and texture_import_ok
    )
    return {
        "ok": usable,
        "texgen_available": texgen_available,
        "custom_rasterizer_available": custom_rasterizer_available,
        "mesh_processor_available": mesh_processor_available,
        "texture_import_ok": texture_import_ok,
        "error": "; ".join(errors) if errors else None,
    }


def load_hunyuan_paint_pipeline(
    paint_pipeline_class: Any,
    multiview_module: Any,
    model: str,
    subfolder: str,
) -> Any:
    """Load Hunyuan Paint while allowing its bundled local Diffusers pipeline."""

    original_diffusion_pipeline = multiview_module.DiffusionPipeline

    class TrustedLocalDiffusionPipeline:
        @staticmethod
        def from_pretrained(*args: Any, **kwargs: Any) -> Any:
            kwargs.setdefault("trust_remote_code", True)
            return original_diffusion_pipeline.from_pretrained(*args, **kwargs)

    multiview_module.DiffusionPipeline = TrustedLocalDiffusionPipeline
    try:
        return paint_pipeline_class.from_pretrained(model, subfolder=subfolder)
    finally:
        multiview_module.DiffusionPipeline = original_diffusion_pipeline


def prepare_texture_mesh(
    mesh: Any,
    *,
    max_faces: int,
    floater_remover_cls: Any,
    degenerate_face_remover_cls: Any,
    face_reducer_cls: Any,
) -> Any:
    """Match the official Hunyuan texture preprocessing flow."""

    mesh = floater_remover_cls()(mesh)
    mesh = degenerate_face_remover_cls()(mesh)
    mesh = face_reducer_cls()(mesh, max_facenum=max_faces)
    return mesh


def configure_texture_memory_profile(
    pipeline: Any,
    *,
    cpu_offload: bool,
    attention_slicing: str,
) -> None:
    """Apply low-VRAM controls to Hunyuan Paint."""

    if cpu_offload:
        if not hasattr(pipeline, "enable_model_cpu_offload"):
            raise RuntimeError("Hunyuan Paint pipeline does not support CPU model offload")
        pipeline.enable_model_cpu_offload()

    if attention_slicing == "off":
        return
    if attention_slicing != "max":
        raise ValueError(f"Unsupported attention slicing mode: {attention_slicing}")

    try:
        multiview_pipeline = pipeline.models["multiview_model"].pipeline
    except (AttributeError, KeyError, TypeError) as exc:
        raise RuntimeError("Hunyuan Paint multiview pipeline is unavailable for attention slicing") from exc

    if hasattr(multiview_pipeline, "enable_attention_slicing"):
        multiview_pipeline.enable_attention_slicing("max")
        return

    unet = getattr(multiview_pipeline, "unet", None)
    if unet is not None and hasattr(unet, "set_attention_slice"):
        unet.set_attention_slice("max")
        return

    raise RuntimeError("Hunyuan Paint multiview pipeline does not expose attention slicing")


def resolve_texture_profile(profile: str, total_vram_gib: float) -> dict[str, Any]:
    _ = total_vram_gib
    resolved_name = "balanced" if profile == "auto" else profile
    if resolved_name not in TEXTURE_PROFILES:
        raise ValueError(f"Unsupported texture profile: {profile}")
    return {"name": resolved_name, **TEXTURE_PROFILES[resolved_name]}


def classify_texture_error(exc: BaseException) -> str:
    text = f"{type(exc).__name__}: {exc}".lower()
    if "outofmemory" in text or "out of memory" in text:
        return "out_of_memory"
    return "worker_error"


def classify_generation_error(exc: BaseException) -> str:
    return classify_texture_error(exc)


def run_health(_args: argparse.Namespace) -> int:
    print(json.dumps(health_payload(), ensure_ascii=False), flush=True)
    return 0


def run_texture_health(_args: argparse.Namespace) -> int:
    print(json.dumps(texture_health_payload(), ensure_ascii=False), flush=True)
    return 0


def run_probe(_args: argparse.Namespace) -> int:
    try:
        import torch  # type: ignore

        hip_version = getattr(torch.version, "hip", None)
        if not hip_version:
            raise RuntimeError("torch.version.hip is empty; this is not an ROCm PyTorch build")
        if not torch.cuda.is_available():
            raise RuntimeError("ROCm PyTorch does not expose an available GPU")

        device = torch.device("cuda")
        a = torch.arange(1024 * 1024, dtype=torch.float32, device=device).reshape(1024, 1024)
        b = torch.eye(1024, dtype=torch.float32, device=device)
        c = a @ b
        checksum = float(c[0, 0].item() + c[-1, -1].item())
        properties = torch.cuda.get_device_properties(0)

        print(
            json.dumps(
                {
                    "ok": True,
                    "torch": torch.__version__,
                    "hip": hip_version,
                    "device": torch.cuda.get_device_name(0),
                    "vram_gb": round(properties.total_memory / (1024**3), 2),
                    "checksum": checksum,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), flush=True)
        return 1


def build_shape_pipeline(args: argparse.Namespace) -> Any:
    from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline  # type: ignore

    return Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
        args.model,
        subfolder=args.subfolder,
        variant=args.variant,
    )


def build_texture_pipeline(
    args: argparse.Namespace,
    *,
    cpu_offload: bool,
    attention_slicing: str,
) -> Any:
    from hy3dgen.texgen import Hunyuan3DPaintPipeline  # type: ignore
    import hy3dgen.texgen.utils.multiview_utils as multiview_utils  # type: ignore

    pipeline = load_hunyuan_paint_pipeline(
        Hunyuan3DPaintPipeline,
        multiview_utils,
        args.model,
        args.subfolder,
    )
    configure_texture_memory_profile(
        pipeline,
        cpu_offload=cpu_offload,
        attention_slicing=attention_slicing,
    )
    return pipeline


def run_generate(args: argparse.Namespace, cache: PipelineCache | None = None) -> int:
    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()

    if not input_path.is_file():
        emit("error", ok=False, stage="shape", error=f"Input image does not exist: {input_path}")
        return 2
    if output_path.suffix.lower() not in {".glb", ".obj"}:
        emit("error", ok=False, stage="shape", error="Output must use .glb or .obj extension")
        return 2

    cache_hit = False
    model_load_ms = 0.0
    inference_ms = 0.0
    export_ms = 0.0

    try:
        emit("progress", ok=True, stage="starting_backend", progress=0.05)

        import torch  # type: ignore
        from PIL import Image  # type: ignore

        image = Image.open(input_path).convert("RGBA")
        if args.remove_background:
            from hy3dgen.rembg import BackgroundRemover  # type: ignore

            emit("progress", ok=True, stage="preparing_input", progress=0.12)
            image = BackgroundRemover()(image)

        emit("progress", ok=True, stage="loading_model", progress=0.2)
        load_started = time.perf_counter()
        if cache is None:
            pipeline = build_shape_pipeline(args)
        else:
            pipeline, cache_hit = cache.get_shape_pipeline(
                lambda: build_shape_pipeline(args),
                (args.model, args.subfolder, args.variant),
            )
        model_load_ms = (time.perf_counter() - load_started) * 1000.0

        generator = None
        if hasattr(torch, "Generator") and torch.cuda.is_available():
            generator = torch.Generator(device="cuda").manual_seed(args.seed)
        else:
            torch.manual_seed(args.seed)

        generate_kwargs: dict[str, Any] = {
            "image": image,
            "num_inference_steps": args.steps,
            "output_type": "trimesh",
        }
        if generator is not None:
            generate_kwargs["generator"] = generator

        emit("progress", ok=True, stage="running_shape", progress=0.3, cache_hit=cache_hit, cache_kind="shape")
        inference_started = time.perf_counter()
        mesh = pipeline(**generate_kwargs)[0]
        inference_ms = (time.perf_counter() - inference_started) * 1000.0

        output_path.parent.mkdir(parents=True, exist_ok=True)
        emit("progress", ok=True, stage="postprocessing", progress=0.92)
        export_started = time.perf_counter()
        mesh.export(str(output_path))
        export_ms = (time.perf_counter() - export_started) * 1000.0
        emit(
            "completed",
            ok=True,
            stage="completed",
            progress=1.0,
            output=str(output_path),
            model=args.model,
            subfolder=args.subfolder,
            variant=args.variant,
            cache_hit=cache_hit,
            cache_kind="shape",
            model_load_ms=round(model_load_ms, 3),
            inference_ms=round(inference_ms, 3),
            export_ms=round(export_ms, 3),
        )
        return 0
    except Exception as exc:
        error_kind = classify_generation_error(exc)
        recover_pipeline_cache_after_error(cache, "shape", error_kind)
        emit(
            "error",
            ok=False,
            stage="shape",
            error_kind=error_kind,
            error=f"{type(exc).__name__}: {exc}",
            cache_hit=cache_hit,
            cache_kind="shape",
            model_load_ms=round(model_load_ms, 3),
            inference_ms=round(inference_ms, 3),
            export_ms=round(export_ms, 3),
        )
        return 1


def run_texture(args: argparse.Namespace, cache: PipelineCache | None = None) -> int:
    mesh_path = Path(args.mesh).expanduser().resolve()
    image_path = Path(args.image).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()

    if not mesh_path.is_file():
        emit("error", ok=False, stage="texture", error=f"Input mesh does not exist: {mesh_path}")
        return 2
    if not image_path.is_file():
        emit("error", ok=False, stage="texture", error=f"Input image does not exist: {image_path}")
        return 2
    if output_path.suffix.lower() not in {".glb", ".obj"}:
        emit("error", ok=False, stage="texture", error="Texture output must use .glb or .obj extension")
        return 2
    if args.max_faces is not None and args.max_faces <= 0:
        emit("error", ok=False, stage="texture", error="--max-faces must be greater than zero")
        return 2

    capability = texture_health_payload()
    if not capability["ok"]:
        emit(
            "error",
            ok=False,
            stage="texture",
            error_kind="runtime_unavailable",
            error=(
                "Hunyuan texture runtime is unavailable: "
                f"{capability['error']}. Run scripts/setup/windows-hunyuan-texture.ps1 first."
            ),
            requested_profile=args.profile,
        )
        return 3

    requested_profile = args.profile
    resolved_profile: str | None = None
    max_faces: int | None = None
    faces_before: int | None = None
    faces_after: int | None = None
    cache_hit = False
    model_load_ms = 0.0
    preprocess_ms = 0.0
    inference_ms = 0.0
    export_ms = 0.0

    try:
        emit("progress", ok=True, stage="starting_backend", progress=0.05)

        import torch  # type: ignore
        import trimesh  # type: ignore
        from PIL import Image  # type: ignore
        from hy3dgen.shapegen import DegenerateFaceRemover, FaceReducer, FloaterRemover  # type: ignore

        if not torch.cuda.is_available():
            raise RuntimeError("ROCm PyTorch does not expose an available GPU for texture generation")
        total_vram_gib = torch.cuda.get_device_properties(0).total_memory / (1024**3)
        profile = resolve_texture_profile(requested_profile, total_vram_gib)
        resolved_profile = str(profile["name"])
        max_faces = int(args.max_faces if args.max_faces is not None else profile["max_faces"])
        cpu_offload = bool(profile["cpu_offload"] if args.cpu_offload is None else args.cpu_offload)
        attention_slicing = str(
            profile["attention_slicing"] if args.attention_slicing is None else args.attention_slicing
        )

        preprocess_started = time.perf_counter()
        emit("progress", ok=True, stage="preparing_input", progress=0.10)
        mesh = trimesh.load(str(mesh_path), force="mesh", process=False)
        image = Image.open(image_path).convert("RGBA")
        if args.remove_background:
            from hy3dgen.rembg import BackgroundRemover  # type: ignore

            image = BackgroundRemover()(image)

        faces_before = int(len(mesh.faces))
        emit(
            "progress",
            ok=True,
            stage="preparing_mesh",
            progress=0.14,
            requested_profile=requested_profile,
            resolved_profile=resolved_profile,
            faces_before=faces_before,
            max_faces=max_faces,
        )
        mesh = prepare_texture_mesh(
            mesh,
            max_faces=max_faces,
            floater_remover_cls=FloaterRemover,
            degenerate_face_remover_cls=DegenerateFaceRemover,
            face_reducer_cls=FaceReducer,
        )
        faces_after = int(len(mesh.faces))
        preprocess_ms = (time.perf_counter() - preprocess_started) * 1000.0
        emit(
            "progress",
            ok=True,
            stage="mesh_ready",
            progress=0.18,
            requested_profile=requested_profile,
            resolved_profile=resolved_profile,
            faces_before=faces_before,
            faces_after=faces_after,
            max_faces=max_faces,
        )

        torch.cuda.empty_cache()

        emit("progress", ok=True, stage="loading_model", progress=0.22)
        load_started = time.perf_counter()
        texture_key = (args.model, args.subfolder, cpu_offload, attention_slicing)
        if cache is None:
            pipeline = build_texture_pipeline(
                args,
                cpu_offload=cpu_offload,
                attention_slicing=attention_slicing,
            )
        else:
            pipeline, cache_hit = cache.get_texture_pipeline(
                lambda: build_texture_pipeline(
                    args,
                    cpu_offload=cpu_offload,
                    attention_slicing=attention_slicing,
                ),
                texture_key,
            )
        model_load_ms = (time.perf_counter() - load_started) * 1000.0

        torch.cuda.empty_cache()

        emit(
            "progress",
            ok=True,
            stage="running_texture",
            progress=0.35,
            requested_profile=requested_profile,
            resolved_profile=resolved_profile,
            max_faces=max_faces,
            cpu_offload=cpu_offload,
            attention_slicing=attention_slicing,
            cache_hit=cache_hit,
            cache_kind="texture",
        )
        inference_started = time.perf_counter()
        textured_mesh = pipeline(mesh, image=image)
        inference_ms = (time.perf_counter() - inference_started) * 1000.0

        output_path.parent.mkdir(parents=True, exist_ok=True)
        emit("progress", ok=True, stage="postprocessing", progress=0.92)
        export_started = time.perf_counter()
        textured_mesh.export(str(output_path))
        export_ms = (time.perf_counter() - export_started) * 1000.0
        emit(
            "completed",
            ok=True,
            stage="completed",
            progress=1.0,
            output=str(output_path),
            model=args.model,
            subfolder=args.subfolder,
            requested_profile=requested_profile,
            resolved_profile=resolved_profile,
            max_faces=max_faces,
            faces_before=faces_before,
            faces_after=faces_after,
            cpu_offload=cpu_offload,
            attention_slicing=attention_slicing,
            cache_hit=cache_hit,
            cache_kind="texture",
            model_load_ms=round(model_load_ms, 3),
            preprocess_ms=round(preprocess_ms, 3),
            inference_ms=round(inference_ms, 3),
            export_ms=round(export_ms, 3),
        )
        return 0
    except Exception as exc:
        error_kind = classify_texture_error(exc)
        recover_pipeline_cache_after_error(cache, "texture", error_kind)
        emit(
            "error",
            ok=False,
            stage="texture",
            error_kind=error_kind,
            error=f"{type(exc).__name__}: {exc}",
            requested_profile=requested_profile,
            resolved_profile=resolved_profile,
            max_faces=max_faces,
            faces_before=faces_before,
            faces_after=faces_after,
            cache_hit=cache_hit,
            cache_kind="texture",
            model_load_ms=round(model_load_ms, 3),
            preprocess_ms=round(preprocess_ms, 3),
            inference_ms=round(inference_ms, 3),
            export_ms=round(export_ms, 3),
        )
        return 1


def _shape_namespace(request: dict[str, Any]) -> argparse.Namespace:
    return argparse.Namespace(
        input=request["input"],
        output=request["output"],
        model=request.get("model") or "tencent/Hunyuan3D-2mini",
        subfolder=request.get("subfolder") or "hunyuan3d-dit-v2-mini",
        variant=request.get("variant") or "fp16",
        steps=int(request.get("steps", 30)),
        seed=int(request.get("seed", 1234)),
        remove_background=bool(request.get("removeBackground", request.get("remove_background", False))),
    )


def _texture_namespace(request: dict[str, Any]) -> argparse.Namespace:
    engine = request.get("engine", "hunyuan-paint")
    if engine != "hunyuan-paint":
        raise ValueError(f"Texture engine '{engine}' is not implemented")
    profile = str(request.get("profile", "auto"))
    if profile not in {"auto", "safe", "balanced", "quality"}:
        raise ValueError(f"Texture profile '{profile}' is not implemented")
    return argparse.Namespace(
        mesh=request["mesh"],
        image=request["image"],
        output=request["output"],
        model=request.get("model") or "tencent/Hunyuan3D-2",
        subfolder=request.get("subfolder") or "hunyuan3d-paint-v2-0-turbo",
        profile=profile,
        max_faces=request.get("maxFaces", request.get("max_faces")),
        cpu_offload=request.get("cpuOffload", request.get("cpu_offload")),
        attention_slicing=request.get("attentionSlicing", request.get("attention_slicing")),
        remove_background=bool(request.get("removeBackground", request.get("remove_background", False))),
    )


def dispatch_serve_command(
    message: dict[str, Any],
    *,
    cache: PipelineCache,
    emit_fn: Callable[[dict[str, Any]], None] | None = None,
) -> bool:
    global _CURRENT_JOB_ID, _EVENT_SINK

    command = message.get("command")
    job_id = message.get("job_id")
    if not isinstance(job_id, str) or not job_id.strip():
        sink = emit_fn or (lambda payload: print(json.dumps(payload, ensure_ascii=False), flush=True))
        sink({"event": "error", "ok": False, "error_kind": "protocol_error", "error": "Missing non-empty job_id"})
        return True

    previous_job_id = _CURRENT_JOB_ID
    previous_sink = _EVENT_SINK
    _CURRENT_JOB_ID = job_id
    _EVENT_SINK = emit_fn
    try:
        if command == "ping":
            emit("pong", ok=True, protocol_version=PROTOCOL_VERSION)
            return True
        if command == "clear_cache":
            cache.clear()
            emit("completed", ok=True, stage="cache_cleared", progress=1.0)
            return True
        if command == "shutdown":
            cache.clear()
            emit("completed", ok=True, stage="shutdown", progress=1.0)
            return False
        if command == "shape":
            request = message.get("request")
            if not isinstance(request, dict):
                raise ValueError("shape command requires a request object")
            run_generate(_shape_namespace(request), cache=cache)
            return True
        if command == "texture":
            request = message.get("request")
            if not isinstance(request, dict):
                raise ValueError("texture command requires a request object")
            run_texture(_texture_namespace(request), cache=cache)
            return True
        raise ValueError(f"Unsupported serve command: {command}")
    except Exception as exc:
        emit(
            "error",
            ok=False,
            stage="worker",
            error_kind="protocol_error",
            error=f"{type(exc).__name__}: {exc}",
        )
        return True
    finally:
        _CURRENT_JOB_ID = previous_job_id
        _EVENT_SINK = previous_sink


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
            print(
                json.dumps(
                    {
                        "event": "error",
                        "ok": False,
                        "error_kind": "protocol_error",
                        "error": f"{type(exc).__name__}: {exc}",
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
            continue
        if not dispatch_serve_command(message, cache=cache):
            return 0
    cache.clear()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Img2Model AMD Hunyuan worker")
    subparsers = parser.add_subparsers(dest="command", required=True)

    health = subparsers.add_parser("health", help="Probe the Python/ROCm/Hunyuan runtime")
    health.add_argument("--json", action="store_true", help="Kept for CLI compatibility; output is always JSON")
    health.set_defaults(func=run_health)

    texture_health = subparsers.add_parser(
        "texture-health",
        help="Probe Hunyuan texture pipeline and native rasterizer capability",
    )
    texture_health.add_argument("--json", action="store_true", help="Kept for CLI compatibility; output is always JSON")
    texture_health.set_defaults(func=run_texture_health)

    probe = subparsers.add_parser("probe", help="Run a real ROCm tensor operation on the selected GPU")
    probe.add_argument("--json", action="store_true", help="Kept for CLI compatibility; output is always JSON")
    probe.set_defaults(func=run_probe)

    generate = subparsers.add_parser("generate", help="Generate a shape from one image")
    generate.add_argument("--input", required=True)
    generate.add_argument("--output", required=True)
    generate.add_argument("--model", default="tencent/Hunyuan3D-2mini")
    generate.add_argument("--subfolder", default="hunyuan3d-dit-v2-mini")
    generate.add_argument("--variant", default="fp16")
    generate.add_argument("--steps", type=int, default=30)
    generate.add_argument("--seed", type=int, default=1234)
    generate.add_argument("--remove-background", action="store_true")
    generate.set_defaults(func=run_generate)

    texture = subparsers.add_parser("texture", help="Texture an existing mesh from the source image")
    texture.add_argument("--mesh", required=True)
    texture.add_argument("--image", required=True)
    texture.add_argument("--output", required=True)
    texture.add_argument("--model", default="tencent/Hunyuan3D-2")
    texture.add_argument("--subfolder", default="hunyuan3d-paint-v2-0-turbo")
    texture.add_argument(
        "--profile",
        choices=["auto", "safe", "balanced", "quality"],
        default="auto",
    )
    texture.add_argument(
        "--max-faces",
        type=int,
        default=None,
        help="Expert override for the profile working triangle budget",
    )
    texture.add_argument(
        "--cpu-offload",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Expert override for profile CPU model offload",
    )
    texture.add_argument(
        "--attention-slicing",
        choices=("max", "off"),
        default=None,
        help="Expert override for Diffusers multiview attention slicing",
    )
    texture.add_argument("--remove-background", action="store_true")
    texture.set_defaults(func=run_texture)

    serve = subparsers.add_parser("serve", help="Run the persistent JSONL desktop worker")
    serve.set_defaults(func=run_serve)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
