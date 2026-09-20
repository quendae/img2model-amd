use img2model_amd_lib::save_uv_template_file;
use std::{fs, time::{SystemTime, UNIX_EPOCH}};

fn temp_svg_path(suffix: &str) -> std::path::PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("img2model-uv-{stamp}-{suffix}"))
}

#[test]
fn writes_svg_template_and_returns_written_path() {
    let path = temp_svg_path("template.svg");
    let svg = r#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><metadata id="img2model-uv-metadata">ok</metadata></svg>"#;

    let written = save_uv_template_file(&path, svg).expect("valid SVG template should be written");

    assert_eq!(written, path.to_string_lossy());
    assert_eq!(fs::read_to_string(&path).expect("saved file should be readable"), svg);
    let _ = fs::remove_file(path);
}

#[test]
fn rejects_non_svg_destination() {
    let path = temp_svg_path("template.txt");
    let error = save_uv_template_file(&path, "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")
        .expect_err("UV template export must not write arbitrary extensions");

    assert!(error.to_lowercase().contains(".svg"));
    assert!(!path.exists());
}

#[test]
fn rejects_non_svg_payload() {
    let path = temp_svg_path("template.svg");
    let error = save_uv_template_file(&path, "not an svg")
        .expect_err("UV template export should validate the payload");

    assert!(error.to_lowercase().contains("svg"));
    assert!(!path.exists());
}
