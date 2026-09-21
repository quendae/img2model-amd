use img2model_amd_lib::worker_session::LocalRepaintCancellationState;

#[test]
fn cancellation_state_tracks_pid_request_and_terminal_reset() {
    let state = LocalRepaintCancellationState::default();
    assert_eq!(state.active_pid(), 0);
    assert!(!state.cancel_requested());

    state.begin(4242);
    assert_eq!(state.active_pid(), 4242);
    assert_eq!(state.request_cancel(), Some(4242));
    assert!(state.cancel_requested());

    assert!(state.finish());
    assert_eq!(state.active_pid(), 0);
    assert!(!state.cancel_requested());
}

#[test]
fn cancellation_without_active_repaint_has_no_pid() {
    let state = LocalRepaintCancellationState::default();
    assert_eq!(state.request_cancel(), None);
    assert!(state.cancel_requested());
    assert!(state.finish());
    assert_eq!(state.active_pid(), 0);
    assert!(!state.cancel_requested());
}
