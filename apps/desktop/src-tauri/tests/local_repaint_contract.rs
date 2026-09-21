use img2model_amd_lib::worker::LocalRepaintWorkerRequest;
use img2model_amd_lib::worker_session::local_repaint_command;
use serde_json::json;

fn fixture_local_repaint_request() -> LocalRepaintWorkerRequest {
    LocalRepaintWorkerRequest {
        source: "source.png".to_string(),
        mask: "mask.png".to_string(),
        output: "edited.png".to_string(),
        prompt: Some("red leather".to_string()),
        reference_image: Some("reference.png".to_string()),
        feather_px: 8,
    }
}

#[test]
fn local_repaint_worker_request_serializes_camel_case() {
    let value = serde_json::to_value(fixture_local_repaint_request()).unwrap();
    assert_eq!(value["source"], "source.png");
    assert_eq!(value["mask"], "mask.png");
    assert_eq!(value["output"], "edited.png");
    assert_eq!(value["prompt"], "red leather");
    assert_eq!(value["referenceImage"], "reference.png");
    assert_eq!(value["featherPx"], 8);
    assert!(value.get("reference_image").is_none());
    assert!(value.get("feather_px").is_none());
}

#[test]
fn local_repaint_worker_request_deserializes_camel_case() {
    let request: LocalRepaintWorkerRequest = serde_json::from_value(json!({
        "source": "source.png",
        "mask": "mask.png",
        "output": "edited.png",
        "prompt": null,
        "referenceImage": "reference.png",
        "featherPx": 4
    }))
    .unwrap();

    assert_eq!(request.reference_image.as_deref(), Some("reference.png"));
    assert_eq!(request.feather_px, 4);
}

#[test]
fn local_repaint_command_has_request_and_job_id() {
    let value = local_repaint_command("job-11", &fixture_local_repaint_request());
    assert_eq!(value["command"], "local_repaint");
    assert_eq!(value["job_id"], "job-11");
    assert_eq!(value["request"]["source"], "source.png");
    assert_eq!(value["request"]["mask"], "mask.png");
    assert_eq!(value["request"]["output"], "edited.png");
    assert_eq!(value["request"]["referenceImage"], "reference.png");
    assert_eq!(value["request"]["featherPx"], 8);
}
