from __future__ import annotations

from typing import Any

from PIL import Image, ImageEnhance, ImageFilter, ImageOps

TEXTURE_STYLE_PRESETS = {
    "match-source",
    "realistic",
    "stylized",
    "hand-painted",
    "cartoon",
    "pixel-art",
}


def _clamp_strength(value: float) -> float:
    return min(1.0, max(0.0, float(value)))


def _with_original_alpha(rgb: Image.Image, original: Image.Image) -> Image.Image:
    rgba = original.convert("RGBA")
    output = rgb.convert("RGBA")
    output.putalpha(rgba.getchannel("A"))
    return output


def _preserve_source_chroma(original: Image.Image, styled: Image.Image) -> Image.Image:
    source_hsv = original.convert("RGB").convert("HSV")
    styled_hsv = styled.convert("RGB").convert("HSV")
    source_h, source_s, _ = source_hsv.split()
    _, _, styled_v = styled_hsv.split()
    return Image.merge("HSV", (source_h, source_s, styled_v)).convert("RGB")


def _reference_palette(reference_image: Image.Image) -> Image.Image:
    reference = reference_image.convert("RGB")
    reference.thumbnail((160, 160), Image.Resampling.LANCZOS)
    return reference.quantize(
        colors=32,
        method=Image.Quantize.MEDIANCUT,
        dither=Image.Dither.NONE,
    )


def _apply_reference_palette(image: Image.Image, reference_image: Image.Image) -> Image.Image:
    palette = _reference_palette(reference_image)
    return image.convert("RGB").quantize(
        palette=palette,
        dither=Image.Dither.NONE,
    ).convert("RGB")


def _realistic(image: Image.Image) -> Image.Image:
    result = ImageEnhance.Contrast(image).enhance(1.10)
    result = ImageEnhance.Color(result).enhance(1.05)
    return ImageEnhance.Sharpness(result).enhance(1.30)


def _stylized(image: Image.Image) -> Image.Image:
    result = image.filter(ImageFilter.SMOOTH_MORE)
    result = ImageOps.posterize(result, 5)
    result = ImageEnhance.Color(result).enhance(1.18)
    return ImageEnhance.Contrast(result).enhance(1.08)


def _hand_painted(image: Image.Image) -> Image.Image:
    result = image.filter(ImageFilter.ModeFilter(size=3))
    result = result.filter(ImageFilter.SMOOTH_MORE)
    result = ImageOps.posterize(result, 5)
    result = ImageEnhance.Color(result).enhance(1.10)
    return ImageEnhance.Sharpness(result).enhance(0.75)


def _cartoon(image: Image.Image) -> Image.Image:
    base = image.filter(ImageFilter.SMOOTH_MORE)
    base = ImageOps.posterize(base, 4)
    base = ImageEnhance.Color(base).enhance(1.22)
    edges = image.convert("L").filter(ImageFilter.FIND_EDGES)
    edges = edges.filter(ImageFilter.GaussianBlur(radius=0.7))
    edges = ImageOps.autocontrast(edges).point(lambda value: 255 if value >= 44 else 0)
    ink = Image.new("RGB", image.size, (20, 20, 20))
    return Image.composite(ink, base, edges)


def _pixel_art(image: Image.Image) -> Image.Image:
    width, height = image.size
    short_side = max(1, min(width, height))
    target_short = max(16, min(256, short_side // 8))
    ratio = target_short / short_side
    small_size = (
        max(1, int(round(width * ratio))),
        max(1, int(round(height * ratio))),
    )
    small = image.resize(small_size, Image.Resampling.NEAREST)
    small = small.quantize(
        colors=24,
        method=Image.Quantize.MEDIANCUT,
        dither=Image.Dither.NONE,
    ).convert("RGB")
    return small.resize((width, height), Image.Resampling.NEAREST)


def stylize_texture_image(
    image: Image.Image,
    *,
    preset: str,
    strength: float = 1.0,
    preserve_source_colors: bool = True,
    reference_image: Image.Image | None = None,
) -> Image.Image:
    if preset not in TEXTURE_STYLE_PRESETS:
        raise ValueError(f"Unsupported texture style preset: {preset}")

    source_rgba = image.convert("RGBA")
    if preset == "match-source" or _clamp_strength(strength) <= 0.0:
        return source_rgba.copy()

    source_rgb = source_rgba.convert("RGB")
    stylizers = {
        "realistic": _realistic,
        "stylized": _stylized,
        "hand-painted": _hand_painted,
        "cartoon": _cartoon,
        "pixel-art": _pixel_art,
    }
    styled = stylizers[preset](source_rgb)

    if reference_image is not None:
        styled = _apply_reference_palette(styled, reference_image)

    if preserve_source_colors:
        styled = _preserve_source_chroma(source_rgb, styled)

    amount = _clamp_strength(strength)
    blended = Image.blend(source_rgb, styled.convert("RGB"), amount)
    return _with_original_alpha(blended, source_rgba)


def apply_texture_style_to_mesh(
    mesh: Any,
    *,
    preset: str,
    strength: float = 1.0,
    preserve_source_colors: bool = True,
    reference_image: Image.Image | None = None,
) -> Any:
    visual = getattr(mesh, "visual", None)
    material = getattr(visual, "material", None)
    if material is None:
        raise RuntimeError("Textured mesh does not expose a material for atlas stylization")

    slot: str | None = None
    source_image: Image.Image | None = None
    for candidate in ("image", "baseColorTexture"):
        value = getattr(material, candidate, None)
        if isinstance(value, Image.Image):
            slot = candidate
            source_image = value
            break

    if slot is None or source_image is None:
        raise RuntimeError("Textured mesh material does not expose a Pillow texture image")

    styled = stylize_texture_image(
        source_image,
        preset=preset,
        strength=strength,
        preserve_source_colors=preserve_source_colors,
        reference_image=reference_image,
    )
    setattr(material, slot, styled)
    return mesh
