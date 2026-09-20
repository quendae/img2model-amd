from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def write(rel: str, text: str) -> None:
    (ROOT / rel).write_text(text, encoding="utf-8", newline="\n")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


# Domain contract.
path = "apps/desktop/src/domain/types.ts"
s = read(path)
s = replace_once(
    s,
    "export type TextureProfile = 'auto' | 'safe' | 'balanced' | 'quality';\n",
    "export type TextureProfile = 'auto' | 'safe' | 'balanced' | 'quality';\n"
    "export type TextureStylePreset = 'match-source' | 'realistic' | 'stylized' | 'hand-painted' | 'cartoon' | 'pixel-art';\n",
    "types TextureStylePreset",
)
s = replace_once(
    s,
    "  profile: TextureProfile;\n  maxFaces?: number;\n  removeBackground: boolean;\n}",
    "  profile: TextureProfile;\n  stylePreset?: TextureStylePreset;\n  maxFaces?: number;\n  removeBackground: boolean;\n}",
    "types retry style",
)
write(path, s)

write(
    "apps/desktop/src/domain/textureStyles.ts",
    """import type { TextureStylePreset } from './types';

export const DEFAULT_TEXTURE_STYLE_PRESET: TextureStylePreset = 'match-source';

export const TEXTURE_STYLE_OPTIONS: ReadonlyArray<{
  id: TextureStylePreset;
  label: string;
  description: string;
}> = [
  { id: 'match-source', label: 'Match source', description: 'Current Hunyuan Paint behavior; preserve the source image character.' },
  { id: 'realistic', label: 'Realistic', description: 'Style contract for a natural material/detail atlas pass.' },
  { id: 'stylized', label: 'Stylized', description: 'Style contract for simplified game-art treatment.' },
  { id: 'hand-painted', label: 'Hand-painted', description: 'Style contract for painterly color and reduced photographic detail.' },
  { id: 'cartoon', label: 'Cartoon', description: 'Style contract for broad color regions and graphic separation.' },
  { id: 'pixel-art', label: 'Pixel-art', description: 'Uses crisp nearest sampling for direct UV textures; atlas stylization comes next.' },
];

export function textureStyleDescription(style: TextureStylePreset): string {
  return TEXTURE_STYLE_OPTIONS.find((option) => option.id === style)?.description
    ?? TEXTURE_STYLE_OPTIONS[0].description;
}
""",
)

# Generation panel.
path = "apps/desktop/src/components/GenerationPanel.tsx"
s = read(path)
s = replace_once(
    s,
    "import { textureProfileDescriptions, textureProfileLabels } from '../domain/textureProfiles';\n",
    "import { textureProfileDescriptions, textureProfileLabels } from '../domain/textureProfiles';\n"
    "import { TEXTURE_STYLE_OPTIONS, textureStyleDescription } from '../domain/textureStyles';\n",
    "panel style import",
)
s = replace_once(s, "  TextureProfile,\n  WorkflowMode,", "  TextureProfile,\n  TextureStylePreset,\n  WorkflowMode,", "panel style type")
s = replace_once(s, "  textureProfile: TextureProfile;\n  textureEngine: TextureEngineId;", "  textureProfile: TextureProfile;\n  textureStylePreset: TextureStylePreset;\n  textureEngine: TextureEngineId;", "panel style prop")
s = replace_once(s, "  onTextureProfileChange: (profile: TextureProfile) => void;\n", "  onTextureProfileChange: (profile: TextureProfile) => void;\n  onTextureStylePresetChange: (style: TextureStylePreset) => void;\n", "panel style handler")
s = replace_once(s, "  textureProfile,\n  textureEngine,", "  textureProfile,\n  textureStylePreset,\n  textureEngine,", "panel destructure style")
s = replace_once(s, "  onTextureProfileChange,\n  onTextureTargetTrianglesChange", "  onTextureProfileChange,\n  onTextureStylePresetChange,\n  onTextureTargetTrianglesChange", "panel destructure handler")
needle = """          <div className=\"field compact-field\">
            <span>Texture profile</span>
"""
block = """          <label className=\"field compact-field\">
            <span>Texture style</span>
            <select
              aria-label=\"Texture style\"
              value={textureStylePreset}
              disabled={busy}
              onChange={(event) => onTextureStylePresetChange(event.target.value as TextureStylePreset)}
            >
              {TEXTURE_STYLE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
            <small className=\"profile-description\">{textureStyleDescription(textureStylePreset)}</small>
          </label>

""" + needle
s = replace_once(s, needle, block, "panel style UI")
write(path, s)

# App state and wiring.
path = "apps/desktop/src/App.tsx"
s = read(path)
s = replace_once(s, "import { DEFAULT_TEXTURE_TARGET_TRIANGLES } from './domain/texturePolycount';\n", "import { DEFAULT_TEXTURE_TARGET_TRIANGLES } from './domain/texturePolycount';\nimport { DEFAULT_TEXTURE_STYLE_PRESET } from './domain/textureStyles';\n", "app style import")
s = replace_once(s, "  TextureProfile,\n  WorkflowMode,", "  TextureProfile,\n  TextureStylePreset,\n  WorkflowMode,", "app style type")
s = replace_once(s, "  const [textureProfile, setTextureProfile] = useState<TextureProfile>('auto');\n", "  const [textureProfile, setTextureProfile] = useState<TextureProfile>('auto');\n  const [textureStylePreset, setTextureStylePreset] = useState<TextureStylePreset>(DEFAULT_TEXTURE_STYLE_PRESET);\n", "app style state")
s = replace_once(s, "        textureProfile,\n        textureMaxFaces: textureTargetTriangles,", "        textureProfile,\n        textureStylePreset,\n        textureMaxFaces: textureTargetTriangles,", "app shape style")
s = replace_once(s, "      profile: textureProfile,\n      maxFaces: textureTargetTriangles,", "      profile: textureProfile,\n      stylePreset: textureStylePreset,\n      maxFaces: textureTargetTriangles,", "app texture style")
s = replace_once(s, "    setTextureProfile(context.profile);\n    if (context.maxFaces", "    setTextureProfile(context.profile);\n    setTextureStylePreset(context.stylePreset ?? DEFAULT_TEXTURE_STYLE_PRESET);\n    if (context.maxFaces", "app retry style")
s = replace_once(s, "              textureProfile={textureProfile}\n              textureEngine={textureEngine}", "              textureProfile={textureProfile}\n              textureStylePreset={textureStylePreset}\n              textureEngine={textureEngine}", "app panel style prop")
s = replace_once(s, "              onTextureProfileChange={setTextureProfile}\n              onTextureTargetTrianglesChange", "              onTextureProfileChange={setTextureProfile}\n              onTextureStylePresetChange={setTextureStylePreset}\n              onTextureTargetTrianglesChange", "app panel style handler")
s = replace_once(s, "          progressLabel={progressLabelText}\n        />", "          progressLabel={progressLabelText}\n          textureStylePreset={textureStylePreset}\n        />", "app viewer style")
write(path, s)

# Job orchestration.
path = "apps/desktop/src/lib/useGenerationJob.ts"
s = read(path)
s = replace_once(s, "  TextureProfile,\n  TextureRetryContext,", "  TextureProfile,\n  TextureRetryContext,\n  TextureStylePreset,", "job style type")
s = replace_once(s, "  textureProfile: TextureProfile;\n  textureMaxFaces?: number;", "  textureProfile: TextureProfile;\n  textureStylePreset?: TextureStylePreset;\n  textureMaxFaces?: number;", "job shape style")
s = replace_once(s, "    const includesShape = Boolean(options?.includesShape);\n", "    const includesShape = Boolean(options?.includesShape);\n    const stylePreset = request.stylePreset ?? 'match-source';\n", "job resolved style")
s = replace_once(s, "          profile: request.profile,\n          maxFaces: request.maxFaces,", "          profile: request.profile,\n          stylePreset,\n          maxFaces: request.maxFaces,", "job tauri style")
s = s.replace("setRetryContext(request);", "setRetryContext({ ...request, stylePreset });")
s = replace_once(s, "        profile: request.textureProfile,\n        maxFaces: request.textureMaxFaces,", "        profile: request.textureProfile,\n        stylePreset: request.textureStylePreset ?? 'match-source',\n        maxFaces: request.textureMaxFaces,", "job shape texture style")
write(path, s)

# Tauri frontend request.
path = "apps/desktop/src/lib/tauri.ts"
s = read(path)
s = replace_once(s, "  TextureProfile,\n  WorkerHealth,", "  TextureProfile,\n  TextureStylePreset,\n  WorkerHealth,", "tauri style type")
s = replace_once(s, "  profile: TextureProfile;\n  maxFaces?: number;", "  profile: TextureProfile;\n  stylePreset?: TextureStylePreset;\n  maxFaces?: number;", "tauri style field")
write(path, s)

# Direct UV sampling policy.
path = "apps/desktop/src/components/uvTextureTransform.ts"
s = read(path)
s = replace_once(s, "import * as THREE from 'three';\n", "import * as THREE from 'three';\nimport type { TextureStylePreset } from '../domain/types';\n", "uv style import")
s = replace_once(
    s,
    "export function applyUvTextureTransform(texture: THREE.Texture, transform: UvTextureTransform): UvTextureTransform {",
    "export function applyUvTextureTransform(\n  texture: THREE.Texture,\n  transform: UvTextureTransform,\n  stylePreset: TextureStylePreset = 'match-source',\n): UvTextureTransform {",
    "uv style signature",
)
s = replace_once(
    s,
    "  texture.rotation = rotation;\n  texture.updateMatrix();\n  texture.needsUpdate = true;",
    "  texture.rotation = rotation;\n  if (stylePreset === 'pixel-art') {\n    texture.magFilter = THREE.NearestFilter;\n    texture.minFilter = THREE.NearestFilter;\n    texture.generateMipmaps = false;\n  } else {\n    texture.magFilter = THREE.LinearFilter;\n    texture.minFilter = THREE.LinearMipmapLinearFilter;\n    texture.generateMipmaps = true;\n  }\n  texture.updateMatrix();\n  texture.needsUpdate = true;",
    "uv pixel sampling",
)
write(path, s)

# ModelViewer consumes current style for imported atlas sampling/export.
path = "apps/desktop/src/components/ModelViewer.tsx"
s = read(path)
s = replace_once(s, "import { exportUvTemplate } from '../lib/uvExport';\n", "import { exportUvTemplate } from '../lib/uvExport';\nimport type { TextureStylePreset } from '../domain/types';\n", "viewer style import")
s = replace_once(s, "  progressLabel?: string | null;\n}", "  progressLabel?: string | null;\n  textureStylePreset?: TextureStylePreset;\n}", "viewer style prop")
s = replace_once(s, "export function ModelViewer({ modelUrl, comparison, busy, progress, progressLabel }: ModelViewerProps) {", "export function ModelViewer({ modelUrl, comparison, busy, progress, progressLabel, textureStylePreset = 'match-source' }: ModelViewerProps) {", "viewer style destructure")
s = replace_once(s, "    if (texture) applyUvTextureTransform(texture, uvTextureTransform);\n  }, [uvTextureTransform]);", "    if (texture) applyUvTextureTransform(texture, uvTextureTransform, textureStylePreset);\n  }, [uvTextureTransform, textureStylePreset]);", "viewer style effect")
s = replace_once(s, "      applyUvTextureTransform(texture, resetTransform);", "      applyUvTextureTransform(texture, resetTransform, textureStylePreset);", "viewer import style")
write(path, s)

# Rust bridge / CLI contract.
path = "apps/desktop/src-tauri/src/worker.rs"
s = read(path)
s = replace_once(s, "    pub profile: String,\n    #[serde(default)]\n    pub max_faces", "    pub profile: String,\n    #[serde(default)]\n    pub style_preset: Option<String>,\n    #[serde(default)]\n    pub max_faces", "rust style field")
s = replace_once(
    s,
    "    if !matches!(request.profile.as_str(), \"auto\" | \"safe\" | \"balanced\" | \"quality\") {\n        return Err(format!(\"Texture profile '{}' is not implemented.\", request.profile));\n    }\n",
    "    if !matches!(request.profile.as_str(), \"auto\" | \"safe\" | \"balanced\" | \"quality\") {\n        return Err(format!(\"Texture profile '{}' is not implemented.\", request.profile));\n    }\n    let style_preset = request.style_preset.as_deref().unwrap_or(\"match-source\");\n    if !matches!(style_preset, \"match-source\" | \"realistic\" | \"stylized\" | \"hand-painted\" | \"cartoon\" | \"pixel-art\") {\n        return Err(format!(\"Texture style preset '{}' is not implemented.\", style_preset));\n    }\n",
    "rust style validation",
)
s = replace_once(s, "        \"--profile\".to_string(),\n        request.profile.clone(),\n    ];", "        \"--profile\".to_string(),\n        request.profile.clone(),\n        \"--style-preset\".to_string(),\n        style_preset.to_string(),\n    ];", "rust style args")
write(path, s)

# Python persistent/CLI contract without changing visual generation yet.
path = "backends/hunyuan/worker.py"
s = read(path)
s = replace_once(s, "_original_run_generate = _base.run_generate\n_original_emit = _base.emit\n", "_original_run_generate = _base.run_generate\n_original_texture_namespace = _base._texture_namespace\n_original_emit = _base.emit\n", "python original namespace")
anchor = "_base.run_generate = run_generate\n\n\nclass PipelineCache"
insert = """_base.run_generate = run_generate

_TEXTURE_STYLE_PRESETS = {
    "match-source",
    "realistic",
    "stylized",
    "hand-painted",
    "cartoon",
    "pixel-art",
}


def _texture_namespace(request: dict[str, Any]) -> argparse.Namespace:
    style_preset = str(request.get("stylePreset") or request.get("style_preset") or "match-source")
    if style_preset not in _TEXTURE_STYLE_PRESETS:
        choices = ", ".join(sorted(_TEXTURE_STYLE_PRESETS))
        raise ValueError(f"Texture style preset must be one of: {choices}")
    args = _original_texture_namespace(request)
    args.style_preset = style_preset
    return args


_base._texture_namespace = _texture_namespace


class PipelineCache"""
s = replace_once(s, anchor, insert, "python namespace override")
s = replace_once(
    s,
    "    subparsers_action.choices[\"serve\"].set_defaults(func=run_serve)\n\n    mesh_cleanup =",
    "    subparsers_action.choices[\"serve\"].set_defaults(func=run_serve)\n    texture_parser = subparsers_action.choices[\"texture\"]\n    texture_parser.add_argument(\n        \"--style-preset\",\n        choices=sorted(_TEXTURE_STYLE_PRESETS),\n        default=\"match-source\",\n    )\n\n    mesh_cleanup =",
    "python cli style",
)
write(path, s)

print("texture style green patch applied")
