use img2model_amd_lib::worker::{texture_arguments, TextureRequest};
use serde_json::json;

fn request(max_faces: u64) -> TextureRequest {
    serde_json::from_value(json!({
        "backend": "native-rocm",
        "engine": "hunyuan-paint",
        "profile": "auto",
        "maxFaces": max_faces,
        "mesh": "C:/shape.glb",
        "image": "C:/source.png",
        "output": "C:/textured.glb",
        "model": null,
        "subfolder": null,
        "removeBackground": true
    }))
    .unwrap()
}

#[test]
fn texture_arguments_forward_exact_target_faces() {
    let arguments = texture_arguments(&request(5_000)).unwrap();
    assert!(
        arguments
            .windows(2)
            .any(|pair| pair == ["--max-faces", "5000"]),
        "expected --max-faces 5000 in {arguments:?}"
    );
}

#[test]
fn texture_arguments_accept_gui_boundaries() {
    let minimum = texture_arguments(&request(300)).unwrap();
    assert!(minimum.windows(2).any(|pair| pair == ["--max-faces", "300"]));

    let maximum = texture_arguments(&request(40_000)).unwrap();
    assert!(maximum.windows(2).any(|pair| pair == ["--max-faces", "40000"]));
}

#[test]
fn texture_arguments_reject_targets_outside_gui_contract() {
    assert!(texture_arguments(&request(299)).unwrap_err().contains("300"));
    assert!(texture_arguments(&request(40_001)).unwrap_err().contains("40000"));
}
