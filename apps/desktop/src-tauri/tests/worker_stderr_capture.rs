use img2model_amd_lib::worker_session::capture_worker_stderr;
use std::collections::VecDeque;
use std::io::Cursor;
use std::sync::{Arc, Mutex};

#[test]
fn stderr_capture_survives_non_utf8_output_and_keeps_reading() {
    let tail = Arc::new(Mutex::new(VecDeque::new()));
    let input = Cursor::new(b"before\xff\nafter-invalid-byte\n".to_vec());

    capture_worker_stderr(input, Arc::clone(&tail));

    let lines = tail.lock().expect("stderr tail lock");
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0], "before\u{fffd}");
    assert_eq!(lines[1], "after-invalid-byte");
}
