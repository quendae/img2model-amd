use img2model_amd_lib::worker::{GenerateResult, MeshCleanupRequest};

#[test]
fn mesh_cleanup_request_serializes_expected_fields() {
    let request = MeshCleanupRequest {
        input: "source.glb".into(),
        output: "source-clean.glb".into(),
        preset: "game-ready".into(),
        overrides: Some(serde_json::json!({"smoothing_iterations": 1})),
    };
    let value = serde_json::to_value(request).unwrap();
    assert_eq!(value["input"], "source.glb");
    assert_eq!(value["output"], "source-clean.glb");
    assert_eq!(value["preset"], "game-ready");
    assert_eq!(value["overrides"]["smoothing_iterations"], 1);
}

#[test]
fn cleanup_result_decodes_report_timing_and_cache_hit() {
    let payload = serde_json::json!({
        "ok": true,
        "event": "completed",
        "output": "source-clean.glb",
        "cleanup_cache_hit": true,
        "mesh_cleanup_ms": 12.5,
        "cleanup_report": {
            "preset": "game-ready",
            "config_label": "Game-ready",
            "algorithm_version": "mesh-cleanup-v1",
            "triangles_before": 100,
            "triangles_after": 90,
            "vertices_before": 60,
            "vertices_after": 55,
            "components_before": 3,
            "components_after": 1,
            "components_removed": 2,
            "vertices_welded": 5,
            "spikes_adjusted": 1,
            "cleanup_ms": 12.5,
            "warnings": []
        }
    });
    let result: GenerateResult = serde_json::from_value(payload).unwrap();
    assert_eq!(result.cleanup_cache_hit, Some(true));
    assert_eq!(result.mesh_cleanup_ms, Some(12.5));
    let report = result.cleanup_report.expect("cleanup report");
    assert_eq!(report.triangles_before, 100);
    assert_eq!(report.triangles_after, 90);
    assert_eq!(report.components_removed, Some(2));
}
