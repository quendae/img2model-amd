use img2model_amd_lib::worker::{texture_arguments, TextureRequest};
use serde_json::json;

#[test]
fn texture_style_preset_reaches_worker_cli_arguments() {
    let request: TextureRequest = serde_json::from_value(json!({
        "backend": "native-rocm",
        "engine": "hunyuan-paint",
        "profile": "balanced",
        "stylePreset": "pixel-art",
        "mesh": "shape.glb",
        "image": "source.png",
        "output": "textured.glb",
        "removeBackground": false
    }))
    .expect("texture request should deserialize");

    let arguments = texture_arguments(&request).expect("texture arguments should build");
    assert!(
        arguments.windows(2).any(|pair| pair == ["--style-preset", "pixel-art"]),
        "style preset was not forwarded: {arguments:?}"
    );
}
