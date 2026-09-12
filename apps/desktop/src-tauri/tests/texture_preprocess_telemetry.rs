use img2model_amd_lib::worker::{GenerateResult, WorkerProgressEvent};

#[test]
fn progress_event_preserves_image_and_mesh_preprocess_cache_flags() {
    let event: WorkerProgressEvent = serde_json::from_str(
        r#"{"event":"progress","stage":"mesh_ready","image_cache_hit":true,"mesh_cache_hit":false}"#,
    )
    .unwrap();

    assert_eq!(event.image_cache_hit, Some(true));
    assert_eq!(event.mesh_cache_hit, Some(false));
}

#[test]
fn terminal_result_preserves_split_preprocess_timings() {
    let result: GenerateResult = serde_json::from_str(
        r#"{"event":"completed","ok":true,"image_cache_hit":true,"mesh_cache_hit":true,"image_preprocess_ms":12.5,"mesh_preprocess_ms":4.25,"preprocess_ms":16.75}"#,
    )
    .unwrap();

    assert_eq!(result.image_cache_hit, Some(true));
    assert_eq!(result.mesh_cache_hit, Some(true));
    assert_eq!(result.image_preprocess_ms, Some(12.5));
    assert_eq!(result.mesh_preprocess_ms, Some(4.25));
    assert_eq!(result.preprocess_ms, Some(16.75));
}
