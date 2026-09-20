from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def patch(rel: str, replacements: list[tuple[str, str]]) -> None:
    path = ROOT / rel
    text = path.read_text(encoding="utf-8")
    for old, new in replacements:
        count = text.count(old)
        if count != 1:
            raise RuntimeError(f"{rel}: expected one match for {old!r}, found {count}")
        text = text.replace(old, new, 1)
    path.write_text(text, encoding="utf-8", newline="\n")


patch(
    "apps/desktop/src/components/GenerationPanel.tsx",
    [
        ("  textureStylePreset: TextureStylePreset;\n", "  textureStylePreset?: TextureStylePreset;\n"),
        ("  onTextureStylePresetChange: (style: TextureStylePreset) => void;\n", "  onTextureStylePresetChange?: (style: TextureStylePreset) => void;\n"),
        ("  textureStylePreset,\n  textureEngine,", "  textureStylePreset = 'match-source',\n  textureEngine,"),
        ("  onTextureStylePresetChange,\n  onTextureTargetTrianglesChange", "  onTextureStylePresetChange = () => {},\n  onTextureTargetTrianglesChange"),
    ],
)

patch(
    "apps/desktop/src-tauri/src/worker.rs",
    [
        ("            profile: \"safe\".to_string(),\n            max_faces: None,", "            profile: \"safe\".to_string(),\n            style_preset: None,\n            max_faces: None,"),
        ("            profile: \"auto\".to_string(),\n            max_faces: None,", "            profile: \"auto\".to_string(),\n            style_preset: None,\n            max_faces: None,"),
    ],
)

patch(
    "apps/desktop/src-tauri/src/worker_session.rs",
    [
        ("            backend: \"native-rocm\".to_string(), engine: \"hunyuan-paint\".to_string(), profile: \"balanced\".to_string(),\n            max_faces: None,", "            backend: \"native-rocm\".to_string(), engine: \"hunyuan-paint\".to_string(), profile: \"balanced\".to_string(),\n            style_preset: None, max_faces: None,"),
    ],
)

print("texture style compile follow-up applied")
