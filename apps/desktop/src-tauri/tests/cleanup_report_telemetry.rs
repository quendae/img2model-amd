use img2model_amd_lib::worker::GenerateResult;
use serde_json::{json, Value};

#[test]
fn rust_bridge_preserves_cleanup_stage_timings_and_pre_repair_topology() {
    let payload = json!({
        "event": "completed",
        "ok": true,
        "cleanup_report": {
            "preset": "light",
            "config_label": "Light",
            "algorithm_version": "mesh-cleanup-v4",
            "triangles_before": 1861972,
            "triangles_after": 1861966,
            "vertices_before": 930977,
            "vertices_after": 930977,
            "components_before": 1,
            "components_after": 1,
            "components_removed": 0,
            "vertices_welded": 0,
            "spikes_adjusted": 0,
            "cleanup_ms": 117000.0,
            "watertight_before": false,
            "watertight_after": true,
            "manifold_before": false,
            "manifold_after": true,
            "boundary_edges_before": 0,
            "boundary_edges_after": 0,
            "pre_repair_watertight": false,
            "pre_repair_manifold": true,
            "pre_repair_boundary_edges": 429,
            "holes_closed": 143,
            "non_manifold_edges_fixed": 0,
            "reduction_ratio": 0.0,
            "remeshed": false,
            "repair_backend": "native-small-hole-fill",
            "normalized_error": null,
            "target_triangles": null,
            "stage_ms": {
                "input_topology": 12000.0,
                "small_hole_fill": 45000.0,
                "repair_winding": 30000.0,
                "final_validation": 20000.0
            },
            "warnings": []
        }
    });

    let parsed: GenerateResult = serde_json::from_value(payload).unwrap();
    let serialized: Value = serde_json::to_value(parsed).unwrap();
    let report = &serialized["cleanup_report"];

    assert_eq!(report["pre_repair_watertight"], json!(false));
    assert_eq!(report["pre_repair_manifold"], json!(true));
    assert_eq!(report["pre_repair_boundary_edges"], json!(429));
    assert_eq!(report["stage_ms"]["small_hole_fill"], json!(45000.0));
    assert_eq!(report["stage_ms"]["repair_winding"], json!(30000.0));
}
