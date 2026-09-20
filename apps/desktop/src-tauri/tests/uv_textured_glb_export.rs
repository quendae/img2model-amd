use img2model_amd_lib::save_textured_glb_file;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn unique_path(extension: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "img2model-uv-texture-export-{}-{stamp}.{extension}",
        std::process::id()
    ))
}

fn minimal_glb() -> Vec<u8> {
    let json = b"{}  ";
    let total_len = 12 + 8 + json.len();
    let mut bytes = Vec::with_capacity(total_len);
    bytes.extend_from_slice(b"glTF");
    bytes.extend_from_slice(&2u32.to_le_bytes());
    bytes.extend_from_slice(&(total_len as u32).to_le_bytes());
    bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
    bytes.extend_from_slice(b"JSON");
    bytes.extend_from_slice(json);
    bytes
}

#[test]
fn saves_a_valid_glb_payload_without_reencoding_it() {
    let path = unique_path("glb");
    let payload = minimal_glb();

    let saved = save_textured_glb_file(&path, &payload).expect("save textured GLB");

    assert_eq!(saved, path.to_string_lossy());
    assert_eq!(fs::read(&path).expect("read saved GLB"), payload);
    let _ = fs::remove_file(path);
}

#[test]
fn rejects_invalid_destination_and_payload() {
    let wrong_extension = unique_path("obj");
    let error = save_textured_glb_file(&wrong_extension, &minimal_glb()).expect_err("reject wrong extension");
    assert!(error.contains(".glb"));

    let path = unique_path("glb");
    let error = save_textured_glb_file(&path, b"not a glb").expect_err("reject invalid payload");
    assert!(error.to_ascii_lowercase().contains("glb"));
}
