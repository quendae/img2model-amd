use img2model_amd_lib::worker::GenerateResult;

#[test]
fn cleanup_v2_report_preserves_topology_and_reduction_fields() {
    let result: GenerateResult = serde_json::from_str(
        r#"{
          "event":"completed",
          "ok":true,
          "cleanup_report":{
            "preset":"game-ready",
            "config_label":"Game-ready",
            "algorithm_version":"mesh-cleanup-v2",
            "triangles_before":534364,
            "triangles_after":5000,
            "vertices_before":267184,
            "vertices_after":2502,
            "components_before":1,
            "components_after":1,
            "components_removed":0,
            "vertices_welded":0,
            "spikes_adjusted":0,
            "cleanup_ms":12000.0,
            "watertight_before":false,
            "watertight_after":true,
            "manifold_before":false,
            "manifold_after":true,
            "boundary_edges_before":42,
            "boundary_edges_after":0,
            "holes_closed":2,
            "non_manifold_edges_fixed":5,
            "reduction_ratio":0.99064,
            "remeshed":true,
            "repair_backend":"pymeshlab+manifold3d",
            "normalized_error":0.0042,
            "target_triangles":5000,
            "warnings":[]
          }
        }"#,
    )
    .unwrap();

    let report = result.cleanup_report.expect("cleanup report");
    assert_eq!(report.watertight_before, Some(false));
    assert_eq!(report.watertight_after, Some(true));
    assert_eq!(report.manifold_after, Some(true));
    assert_eq!(report.boundary_edges_after, Some(0));
    assert_eq!(report.holes_closed, Some(2));
    assert_eq!(report.non_manifold_edges_fixed, Some(5));
    assert_eq!(report.remeshed, Some(true));
    assert_eq!(report.repair_backend.as_deref(), Some("pymeshlab+manifold3d"));
    assert_eq!(report.normalized_error, Some(0.0042));
    assert_eq!(report.target_triangles, Some(5000));
}
