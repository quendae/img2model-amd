use std::path::Path;

const MAX_UV_TEMPLATE_BYTES: usize = 32 * 1024 * 1024;
const MAX_TEXTURED_GLB_BYTES: usize = 512 * 1024 * 1024;

fn validate_svg_destination(path: &Path) -> Result<(), String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !extension.eq_ignore_ascii_case("svg") {
        return Err("UV template destination must use the .svg extension.".to_string());
    }
    Ok(())
}

fn validate_svg_payload(contents: &str) -> Result<(), String> {
    if contents.is_empty() {
        return Err("UV template SVG is empty.".to_string());
    }
    if contents.len() > MAX_UV_TEMPLATE_BYTES {
        return Err(format!(
            "UV template SVG is too large ({} bytes; maximum is {} bytes).",
            contents.len(),
            MAX_UV_TEMPLATE_BYTES
        ));
    }

    let trimmed = contents.trim_start_matches('\u{feff}').trim_start();
    let looks_like_svg = trimmed.starts_with("<svg")
        || (trimmed.starts_with("<?xml") && trimmed.contains("<svg"));
    if !looks_like_svg {
        return Err("UV template payload is not an SVG document.".to_string());
    }
    Ok(())
}

fn validate_glb_destination(path: &Path) -> Result<(), String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !extension.eq_ignore_ascii_case("glb") {
        return Err("Textured model destination must use the .glb extension.".to_string());
    }
    Ok(())
}

fn validate_glb_payload(contents: &[u8]) -> Result<(), String> {
    if contents.len() < 12 {
        return Err("Textured GLB payload is too short to contain a GLB header.".to_string());
    }
    if contents.len() > MAX_TEXTURED_GLB_BYTES {
        return Err(format!(
            "Textured GLB is too large ({} bytes; maximum is {} bytes).",
            contents.len(),
            MAX_TEXTURED_GLB_BYTES
        ));
    }
    if &contents[0..4] != b"glTF" {
        return Err("Textured GLB payload has an invalid GLB magic header.".to_string());
    }

    let version = u32::from_le_bytes(contents[4..8].try_into().expect("validated GLB header length"));
    if version != 2 {
        return Err(format!("Unsupported GLB version {version}; expected version 2."));
    }

    let declared_length =
        u32::from_le_bytes(contents[8..12].try_into().expect("validated GLB header length")) as usize;
    if declared_length != contents.len() {
        return Err(format!(
            "Textured GLB length mismatch: header declares {declared_length} bytes but received {} bytes.",
            contents.len()
        ));
    }

    Ok(())
}

pub fn save_uv_template_file(path: &Path, contents: &str) -> Result<String, String> {
    validate_svg_destination(path)?;
    validate_svg_payload(contents)?;

    std::fs::write(path, contents.as_bytes())
        .map_err(|error| format!("Failed to save UV template '{}': {error}", path.display()))?;

    Ok(path.to_string_lossy().into_owned())
}

pub fn save_textured_glb_file(path: &Path, contents: &[u8]) -> Result<String, String> {
    validate_glb_destination(path)?;
    validate_glb_payload(contents)?;

    std::fs::write(path, contents)
        .map_err(|error| format!("Failed to save textured GLB '{}': {error}", path.display()))?;

    Ok(path.to_string_lossy().into_owned())
}
