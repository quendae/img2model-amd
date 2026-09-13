use img2model_amd_lib::worker_session::parse_worker_stdout_line;

#[test]
fn plain_worker_stdout_is_log_noise_not_protocol_error() {
    let parsed = parse_worker_stdout_line(
        "PointCrossAttentionEncoder INFO: pc_sharpedge_size is given",
    )
    .expect("plain worker log should not be a protocol error");
    assert!(parsed.is_none());
}

#[test]
fn json_worker_stdout_is_protocol_event() {
    let value = parse_worker_stdout_line(r#"{"event":"progress","job_id":"job-1"}"#)
        .expect("valid JSON should parse")
        .expect("valid JSON should return a protocol value");
    assert_eq!(value["event"], "progress");
    assert_eq!(value["job_id"], "job-1");
}

#[test]
fn malformed_json_looking_stdout_is_protocol_error() {
    let error = parse_worker_stdout_line("{not-json")
        .expect_err("JSON-looking malformed stdout must remain a protocol error");
    assert!(error.contains("malformed JSON"), "unexpected error: {error}");
}
