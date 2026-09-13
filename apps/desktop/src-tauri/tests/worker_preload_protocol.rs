use img2model_amd_lib::worker_session::preload_shape_command;

#[test]
fn preload_shape_command_has_job_id_and_empty_request() {
    let value = preload_shape_command("job-preload");
    assert_eq!(value["command"], "preload_shape");
    assert_eq!(value["job_id"], "job-preload");
    assert!(value["request"].as_object().is_some());
    assert!(value["request"].as_object().unwrap().is_empty());
}
