from __future__ import annotations

from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}: {old[:100]!r}")
    file.write_text(text.replace(old, new), encoding="utf-8")


STYLIZER = r'''from __future__ import annotations

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
'''

Path("backends/hunyuan/texture_stylizer.py").write_text(STYLIZER, encoding="utf-8")

# Frontend domain contract.
replace(
    "apps/desktop/src/domain/types.ts",
    "  stylePreset?: TextureStylePreset;\n  maxFaces?: number;",
    "  stylePreset?: TextureStylePreset;\n  styleStrength?: number;\n  preserveSourceColors?: boolean;\n  styleReference?: string | null;\n  maxFaces?: number;",
)
replace(
    "apps/desktop/src/domain/textureStyles.ts",
    "  { id: 'realistic', label: 'Realistic', description: 'Style contract for a natural material/detail atlas pass.' },\n  { id: 'stylized', label: 'Stylized', description: 'Style contract for simplified game-art treatment.' },\n  { id: 'hand-painted', label: 'Hand-painted', description: 'Style contract for painterly color and reduced photographic detail.' },\n  { id: 'cartoon', label: 'Cartoon', description: 'Style contract for broad color regions and graphic separation.' },\n  { id: 'pixel-art', label: 'Pixel-art', description: 'Uses crisp nearest sampling for direct UV textures; atlas stylization comes next.' },",
    "  { id: 'realistic', label: 'Realistic', description: 'Adds contrast, color and detail to the generated atlas.' },\n  { id: 'stylized', label: 'Stylized', description: 'Simplifies tones and colors for game-art readability.' },\n  { id: 'hand-painted', label: 'Hand-painted', description: 'Smooths photographic detail into broader painted color regions.' },\n  { id: 'cartoon', label: 'Cartoon', description: 'Posterizes color regions and adds graphic edge separation.' },\n  { id: 'pixel-art', label: 'Pixel-art', description: 'Pixelates and palette-reduces the atlas, with nearest-neighbor sampling in the viewer.' },",
)

# Tauri TypeScript request + picker.
replace(
    "apps/desktop/src/lib/tauri.ts",
    "  stylePreset?: TextureStylePreset;\n  maxFaces?: number;",
    "  stylePreset?: TextureStylePreset;\n  styleStrength?: number;\n  preserveSourceColors?: boolean;\n  styleReference?: string | null;\n  maxFaces?: number;",
)
replace(
    "apps/desktop/src/lib/tauri.ts",
    "export async function chooseInputMesh(): Promise<string | null> {",
    "export async function chooseStyleReferenceImage(): Promise<string | null> {\n  return chooseInputImage();\n}\n\nexport async function chooseInputMesh(): Promise<string | null> {",
)

# Hook contract and propagation.
replace(
    "apps/desktop/src/lib/useGenerationJob.ts",
    "  textureStylePreset?: TextureStylePreset;\n  textureMaxFaces?: number;",
    "  textureStylePreset?: TextureStylePreset;\n  textureStyleStrength?: number;\n  preserveSourceColors?: boolean;\n  styleReference?: string | null;\n  textureMaxFaces?: number;",
)
replace(
    "apps/desktop/src/lib/useGenerationJob.ts",
    "  running_texture: 'Generating Hunyuan Paint texture…',\n  postprocessing: 'Exporting model…',",
    "  running_texture: 'Generating Hunyuan Paint texture…',\n  stylizing_texture: 'Applying texture style…',\n  postprocessing: 'Exporting model…',",
)
replace(
    "apps/desktop/src/lib/useGenerationJob.ts",
    "          stylePreset,\n          maxFaces: request.maxFaces,",
    "          stylePreset,\n          styleStrength: request.styleStrength ?? 1.0,\n          preserveSourceColors: request.preserveSourceColors ?? true,\n          styleReference: request.styleReference ?? null,\n          maxFaces: request.maxFaces,",
)
replace(
    "apps/desktop/src/lib/useGenerationJob.ts",
    "        stylePreset: request.textureStylePreset ?? 'match-source',\n        maxFaces: request.textureMaxFaces,",
    "        stylePreset: request.textureStylePreset ?? 'match-source',\n        styleStrength: request.textureStyleStrength ?? 1.0,\n        preserveSourceColors: request.preserveSourceColors ?? true,\n        styleReference: request.styleReference ?? null,\n        maxFaces: request.textureMaxFaces,",
)

# App state, picker, retry restoration and request propagation.
replace(
    "apps/desktop/src/App.tsx",
    "  chooseInputMesh,\n  chooseOutputModel,",
    "  chooseInputMesh,\n  chooseOutputModel,\n  chooseStyleReferenceImage,",
)
replace(
    "apps/desktop/src/App.tsx",
    "  const [textureStylePreset, setTextureStylePreset] = useState<TextureStylePreset>(DEFAULT_TEXTURE_STYLE_PRESET);\n  const [textureTargetTriangles, setTextureTargetTriangles] = useState(DEFAULT_TEXTURE_TARGET_TRIANGLES);",
    "  const [textureStylePreset, setTextureStylePreset] = useState<TextureStylePreset>(DEFAULT_TEXTURE_STYLE_PRESET);\n  const [textureStyleStrength, setTextureStyleStrength] = useState(1.0);\n  const [preserveSourceColors, setPreserveSourceColors] = useState(true);\n  const [styleReferencePath, setStyleReferencePath] = useState<string | null>(null);\n  const [textureTargetTriangles, setTextureTargetTriangles] = useState(DEFAULT_TEXTURE_TARGET_TRIANGLES);",
)
replace(
    "apps/desktop/src/App.tsx",
    "  const changeProfile = (nextProfile: GenerationOptions['profile']) => {",
    "  const chooseStyleReference = async () => {\n    const path = await chooseStyleReferenceImage();\n    if (path) setStyleReferencePath(path);\n  };\n\n  const changeProfile = (nextProfile: GenerationOptions['profile']) => {",
)
replace(
    "apps/desktop/src/App.tsx",
    "        textureStylePreset,\n        textureMaxFaces: textureTargetTriangles,",
    "        textureStylePreset,\n        textureStyleStrength,\n        preserveSourceColors,\n        styleReference: styleReferencePath,\n        textureMaxFaces: textureTargetTriangles,",
)
replace(
    "apps/desktop/src/App.tsx",
    "      stylePreset: textureStylePreset,\n      maxFaces: textureTargetTriangles,",
    "      stylePreset: textureStylePreset,\n      styleStrength: textureStyleStrength,\n      preserveSourceColors,\n      styleReference: styleReferencePath,\n      maxFaces: textureTargetTriangles,",
)
replace(
    "apps/desktop/src/App.tsx",
    "    setTextureStylePreset(context.stylePreset ?? DEFAULT_TEXTURE_STYLE_PRESET);\n    if (context.maxFaces !== undefined) setTextureTargetTriangles(context.maxFaces);",
    "    setTextureStylePreset(context.stylePreset ?? DEFAULT_TEXTURE_STYLE_PRESET);\n    setTextureStyleStrength(context.styleStrength ?? 1.0);\n    setPreserveSourceColors(context.preserveSourceColors ?? true);\n    setStyleReferencePath(context.styleReference ?? null);\n    if (context.maxFaces !== undefined) setTextureTargetTriangles(context.maxFaces);",
)
replace(
    "apps/desktop/src/App.tsx",
    "              textureStylePreset={textureStylePreset}\n              textureEngine={textureEngine}",
    "              textureStylePreset={textureStylePreset}\n              textureStyleStrength={textureStyleStrength}\n              preserveSourceColors={preserveSourceColors}\n              styleReferencePath={styleReferencePath}\n              textureEngine={textureEngine}",
)
replace(
    "apps/desktop/src/App.tsx",
    "              onTextureStylePresetChange={setTextureStylePreset}\n              onTextureTargetTrianglesChange={setTextureTargetTriangles}",
    "              onTextureStylePresetChange={setTextureStylePreset}\n              onTextureStyleStrengthChange={setTextureStyleStrength}\n              onPreserveSourceColorsChange={setPreserveSourceColors}\n              onChooseStyleReference={() => void chooseStyleReference()}\n              onClearStyleReference={() => setStyleReferencePath(null)}\n              onTextureTargetTrianglesChange={setTextureTargetTriangles}",
)

# GenerationPanel controls.
replace(
    "apps/desktop/src/components/GenerationPanel.tsx",
    "  textureStylePreset?: TextureStylePreset;\n  textureEngine: TextureEngineId;",
    "  textureStylePreset?: TextureStylePreset;\n  textureStyleStrength?: number;\n  preserveSourceColors?: boolean;\n  styleReferencePath?: string | null;\n  textureEngine: TextureEngineId;",
)
replace(
    "apps/desktop/src/components/GenerationPanel.tsx",
    "  onTextureStylePresetChange?: (style: TextureStylePreset) => void;\n  onTextureTargetTrianglesChange?: (triangles: number) => void;",
    "  onTextureStylePresetChange?: (style: TextureStylePreset) => void;\n  onTextureStyleStrengthChange?: (strength: number) => void;\n  onPreserveSourceColorsChange?: (enabled: boolean) => void;\n  onChooseStyleReference?: () => void;\n  onClearStyleReference?: () => void;\n  onTextureTargetTrianglesChange?: (triangles: number) => void;",
)
replace(
    "apps/desktop/src/components/GenerationPanel.tsx",
    "  textureStylePreset = 'match-source',\n  textureEngine,",
    "  textureStylePreset = 'match-source',\n  textureStyleStrength = 1.0,\n  preserveSourceColors = true,\n  styleReferencePath = null,\n  textureEngine,",
)
replace(
    "apps/desktop/src/components/GenerationPanel.tsx",
    "  onTextureStylePresetChange = () => {},\n  onTextureTargetTrianglesChange = () => {},",
    "  onTextureStylePresetChange = () => {},\n  onTextureStyleStrengthChange = () => {},\n  onPreserveSourceColorsChange = () => {},\n  onChooseStyleReference = () => {},\n  onClearStyleReference = () => {},\n  onTextureTargetTrianglesChange = () => {},",
)
old_style_block = '''          <label className="field compact-field">
            <span>Texture style</span>
            <select
              aria-label="Texture style"
              value={textureStylePreset}
              disabled={busy}
              onChange={(event) => onTextureStylePresetChange(event.target.value as TextureStylePreset)}
            >
              {TEXTURE_STYLE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
            <small className="profile-description">{textureStyleDescription(textureStylePreset)}</small>
          </label>
'''
new_style_block = old_style_block + '''
          {textureStylePreset !== 'match-source' && (
            <div className="texture-style-controls">
              <label className="field compact-field">
                <span>Style strength</span>
                <input
                  aria-label="Style strength"
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(Math.min(1, Math.max(0, textureStyleStrength)) * 100)}
                  disabled={busy}
                  onChange={(event) => onTextureStyleStrengthChange(Number(event.target.value) / 100)}
                />
                <small className="profile-description">
                  {Math.round(Math.min(1, Math.max(0, textureStyleStrength)) * 100)}% · blends the styled atlas with the original Hunyuan Paint atlas.
                </small>
              </label>

              <label className="toggle-row compact-toggle-row">
                <input
                  aria-label="Preserve source colors"
                  type="checkbox"
                  checked={preserveSourceColors}
                  disabled={busy}
                  onChange={(event) => onPreserveSourceColorsChange(event.target.checked)}
                />
                <span>
                  <strong>Preserve source colors</strong>
                  <small>Keeps the generated atlas hue/saturation while applying the selected style's tonal treatment.</small>
                </span>
              </label>

              <div className="field compact-field">
                <span>Style reference</span>
                <div className="mesh-picker">
                  <div title={styleReferencePath ?? undefined}>{styleReferencePath ?? 'No style reference selected'}</div>
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label="Choose style reference"
                    disabled={busy}
                    onClick={onChooseStyleReference}
                  >
                    Choose
                  </button>
                  {styleReferencePath && (
                    <button
                      type="button"
                      className="ghost-button"
                      aria-label="Clear style reference"
                      disabled={busy}
                      onClick={onClearStyleReference}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <small className="profile-description">
                  Optional palette/color guide. Disable Preserve source colors when you want the reference palette to dominate.
                </small>
              </div>
            </div>
          )}
'''
replace("apps/desktop/src/components/GenerationPanel.tsx", old_style_block, new_style_block)

# Python worker request contract and actual stylization wrapper.
replace(
    "backends/hunyuan/worker.py",
    "_original_run_generate = _base.run_generate\n_original_texture_namespace = _base._texture_namespace",
    "_original_run_generate = _base.run_generate\n_original_run_texture = _base.run_texture\n_original_build_texture_pipeline = _base.build_texture_pipeline\n_original_texture_namespace = _base._texture_namespace",
)
replace(
    "backends/hunyuan/worker.py",
    "_texture_debug_stage: str | None = None\n",
    "_texture_debug_stage: str | None = None\n_texture_style_context: dict[str, Any] = {\n    'preset': 'match-source',\n    'strength': 1.0,\n    'preserve_source_colors': True,\n    'style_reference': None,\n}\n",
)
replace(
    "backends/hunyuan/worker.py",
    "    args = _original_texture_namespace(request)\n    args.style_preset = style_preset\n    return args",
    "    style_strength = float(request.get('styleStrength', request.get('style_strength', 1.0)))\n    if not 0.0 <= style_strength <= 1.0:\n        raise ValueError('Texture style strength must be between 0.0 and 1.0')\n    preserve_source_colors = bool(request.get('preserveSourceColors', request.get('preserve_source_colors', True)))\n    style_reference = request.get('styleReference', request.get('style_reference'))\n\n    args = _original_texture_namespace(request)\n    args.style_preset = style_preset\n    args.style_strength = style_strength\n    args.preserve_source_colors = preserve_source_colors\n    args.style_reference = str(style_reference) if style_reference else None\n    return args",
)
replace(
    "backends/hunyuan/worker.py",
    "_base._texture_namespace = _texture_namespace\n\n\nclass PipelineCache",
    '''_base._texture_namespace = _texture_namespace


class _TextureStylePipeline:
    def __init__(self, pipeline: Any) -> None:
        self._pipeline = pipeline

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        textured_mesh = self._pipeline(*args, **kwargs)
        preset = str(_texture_style_context["preset"])
        strength = float(_texture_style_context["strength"])
        if preset == "match-source" or strength <= 0.0:
            return textured_mesh

        try:
            from .texture_stylizer import apply_texture_style_to_mesh
        except ImportError:
            from texture_stylizer import apply_texture_style_to_mesh  # type: ignore
        from PIL import Image  # type: ignore

        emit("progress", ok=True, stage="stylizing_texture", progress=0.88, style_preset=preset, style_strength=strength)
        reference_image = None
        style_reference = _texture_style_context.get("style_reference")
        if style_reference:
            reference_path = Path(str(style_reference)).expanduser().resolve()
            if not reference_path.is_file():
                raise FileNotFoundError(f"Style reference does not exist: {reference_path}")
            with Image.open(reference_path) as source:
                reference_image = source.convert("RGBA")

        return apply_texture_style_to_mesh(
            textured_mesh,
            preset=preset,
            strength=strength,
            preserve_source_colors=bool(_texture_style_context["preserve_source_colors"]),
            reference_image=reference_image,
        )

    def __getattr__(self, name: str) -> Any:
        return getattr(self._pipeline, name)


def build_texture_pipeline(args: argparse.Namespace, *, cpu_offload: bool, attention_slicing: str) -> Any:
    return _TextureStylePipeline(
        _original_build_texture_pipeline(
            args,
            cpu_offload=cpu_offload,
            attention_slicing=attention_slicing,
        )
    )


def run_texture(args: argparse.Namespace, cache: Any | None = None) -> int:
    previous = dict(_texture_style_context)
    _texture_style_context.update(
        preset=str(getattr(args, "style_preset", "match-source")),
        strength=float(getattr(args, "style_strength", 1.0)),
        preserve_source_colors=bool(getattr(args, "preserve_source_colors", True)),
        style_reference=getattr(args, "style_reference", None),
    )
    try:
        return _original_run_texture(args, cache=cache)
    finally:
        _texture_style_context.clear()
        _texture_style_context.update(previous)


_base.build_texture_pipeline = build_texture_pipeline
_base.run_texture = run_texture


class PipelineCache''',
)
replace(
    "backends/hunyuan/worker.py",
    "    texture_parser.add_argument(\n        \"--style-preset\",\n        choices=sorted(_TEXTURE_STYLE_PRESETS),\n        default=\"match-source\",\n    )",
    "    texture_parser.add_argument(\n        \"--style-preset\",\n        choices=sorted(_TEXTURE_STYLE_PRESETS),\n        default=\"match-source\",\n    )\n    texture_parser.add_argument(\"--style-strength\", type=float, default=1.0)\n    texture_parser.add_argument(\"--style-reference\")\n    texture_parser.add_argument(\"--preserve-source-colors\", dest=\"preserve_source_colors\", action=\"store_true\", default=True)\n    texture_parser.add_argument(\"--no-preserve-source-colors\", dest=\"preserve_source_colors\", action=\"store_false\")",
)

# Rust request/CLI bridge.
replace(
    "apps/desktop/src-tauri/src/worker.rs",
    "    pub style_preset: Option<String>,\n    #[serde(default)]\n    pub max_faces: Option<u64>,",
    "    pub style_preset: Option<String>,\n    #[serde(default)]\n    pub style_strength: Option<f64>,\n    #[serde(default)]\n    pub preserve_source_colors: Option<bool>,\n    #[serde(default)]\n    pub style_reference: Option<String>,\n    #[serde(default)]\n    pub max_faces: Option<u64>,",
)
replace(
    "apps/desktop/src-tauri/src/worker.rs",
    "    if let Some(max_faces) = request.max_faces {\n        if !(300..=40_000).contains(&max_faces) {",
    "    if let Some(style_strength) = request.style_strength {\n        if !(0.0..=1.0).contains(&style_strength) {\n            return Err(format!(\"Texture styleStrength must be between 0.0 and 1.0; got {style_strength}.\"));\n        }\n    }\n    if let Some(max_faces) = request.max_faces {\n        if !(300..=40_000).contains(&max_faces) {",
)
replace(
    "apps/desktop/src-tauri/src/worker.rs",
    "    if let Some(max_faces) = request.max_faces {\n        arguments.push(\"--max-faces\".to_string());",
    "    if let Some(style_strength) = request.style_strength {\n        arguments.push(\"--style-strength\".to_string());\n        arguments.push(style_strength.to_string());\n    }\n    if request.preserve_source_colors == Some(false) {\n        arguments.push(\"--no-preserve-source-colors\".to_string());\n    }\n    if let Some(style_reference) = request.style_reference.as_deref().filter(|value| !value.trim().is_empty()) {\n        arguments.push(\"--style-reference\".to_string());\n        arguments.push(style_reference.to_string());\n    }\n\n    if let Some(max_faces) = request.max_faces {\n        arguments.push(\"--max-faces\".to_string());",
)
# First worker.rs fixture has Windows paths, second has simple shape.glb.
text = Path("apps/desktop/src-tauri/src/worker.rs").read_text(encoding="utf-8")
text = text.replace(
    "            style_preset: None,\n            max_faces: None,",
    "            style_preset: None,\n            style_strength: None,\n            preserve_source_colors: None,\n            style_reference: None,\n            max_faces: None,",
)
Path("apps/desktop/src-tauri/src/worker.rs").write_text(text, encoding="utf-8")
replace(
    "apps/desktop/src-tauri/src/worker_session.rs",
    "            style_preset: None, max_faces: None,",
    "            style_preset: None, style_strength: None, preserve_source_colors: None, style_reference: None, max_faces: None,",
)

# Extend propagation tests.
replace(
    "apps/desktop/src/lib/useGenerationJobTextureStyle.test.ts",
    "        stylePreset: 'stylized',\n        mesh: 'C:/shape.glb',",
    "        stylePreset: 'stylized',\n        styleStrength: 0.65,\n        preserveSourceColors: false,\n        styleReference: 'C:/reference.png',\n        mesh: 'C:/shape.glb',",
)
replace(
    "apps/desktop/src/lib/useGenerationJobTextureStyle.test.ts",
    "    expect(tauriMocks.textureMesh.mock.calls[0][0]).toMatchObject({ stylePreset: 'stylized' });",
    "    expect(tauriMocks.textureMesh.mock.calls[0][0]).toMatchObject({\n      stylePreset: 'stylized',\n      styleStrength: 0.65,\n      preserveSourceColors: false,\n      styleReference: 'C:/reference.png',\n    });",
)
replace(
    "apps/desktop/src/lib/useGenerationJobTextureStyle.test.ts",
    "        stylePreset: 'cartoon',\n        mesh: 'C:/shape.glb',",
    "        stylePreset: 'cartoon',\n        styleStrength: 0.8,\n        preserveSourceColors: true,\n        styleReference: 'C:/style.png',\n        mesh: 'C:/shape.glb',",
)
replace(
    "apps/desktop/src/lib/useGenerationJobTextureStyle.test.ts",
    "      stylePreset: 'cartoon',\n    });",
    "      stylePreset: 'cartoon',\n      styleStrength: 0.8,\n      preserveSourceColors: true,\n      styleReference: 'C:/style.png',\n    });",
)

# Remove temporary machinery from the production commit.
Path(".github/workflows/_apply-texture-stylization.yml").unlink(missing_ok=True)
Path(__file__).unlink(missing_ok=True)
