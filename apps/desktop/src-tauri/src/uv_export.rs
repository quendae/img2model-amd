use std::path::Path;

const MAX_UV_TEMPLATE_BYTES: usize = 32 * 1024 * 1024;

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

pub fn save_uv_template_file(path: &Path, contents: &str) -> Result<String, String> {
    validate_svg_destination(path)?;
    validate_svg_payload(contents)?;

    std::fs::write(path, contents.as_bytes())
        .map_err(|error| format!("Failed to save UV template '{}': {error}", path.display()))?;

    Ok(path.to_string_lossy().into_owned())
}
