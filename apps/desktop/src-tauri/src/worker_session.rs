use crate::diagnostics::configured_python;
use crate::worker::{
    backend_is_implemented, configured_worker_path, texture_arguments, GenerateRequest, GenerateResult,
    MeshCleanupRequest, TextureRequest, WorkerProgressEvent,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

const PROTOCOL_VERSION: u64 = 2;
const LOG_TAIL_LINES: usize = 200;

#[derive(Debug)]
struct SessionError {
    kind: &'static str,
    message: String,
}

impl SessionError {
    fn crashed(message: impl Into<String>) -> Self {
        Self { kind: "worker_crashed", message: message.into() }
    }

    fn protocol(message: impl Into<String>) -> Self {
        Self { kind: "protocol_error", message: message.into() }
    }
}

pub fn parse_worker_stdout_line(line: &str) -> Result<Option<Value>, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(value) => Ok(Some(value)),
        Err(error) if trimmed.starts_with('{') || trimmed.starts_with('[') => Err(format!(
            "Persistent worker emitted malformed JSON stdout: {error}; line={trimmed:?}"
        )),
        Err(_) => Ok(None),
    }
}

pub fn preload_shape_command(job_id: &str) -> Value {
    json!({
        "command": "preload_shape",
        "job_id": job_id,
        "request": {},
    })
}

fn shape_command(job_id: &str, request: &GenerateRequest) -> Value {
    json!({ "command": "shape", "job_id": job_id, "request": request })
}

fn texture_command(job_id: &str, request: &TextureRequest) -> Value {
    json!({ "command": "texture", "job_id": job_id, "request": request })
}

fn mesh_cleanup_command(job_id: &str, request: &MeshCleanupRequest) -> Value {
    json!({ "command": "mesh_cleanup", "job_id": job_id, "request": request })
}

fn control_command(job_id: &str, command: &str) -> Value {
    json!({ "command": command, "job_id": job_id })
}

fn event_job_id(value: &Value) -> Option<&str> {
    value.get("job_id").and_then(Value::as_str)
}

fn validate_event_job_id(value: &Value, expected_job_id: &str) -> Result<(), SessionError> {
    match event_job_id(value) {
        Some(job_id) if job_id == expected_job_id => Ok(()),
        Some(job_id) => Err(SessionError::protocol(format!(
            "Worker returned event for job '{job_id}' while waiting for '{expected_job_id}'."
        ))),
        None => Err(SessionError::protocol(format!(
            "Worker returned an event without job_id while waiting for '{expected_job_id}'."
        ))),
    }
}

fn failure_result(kind: &str, message: String) -> GenerateResult {
    GenerateResult {
        ok: false,
        event: "error".to_string(),
        output: None,
        error: Some(message),
        error_kind: Some(kind.to_string()),
        stage: Some("worker".to_string()),
        requested_profile: None,
        resolved_profile: None,
        faces_before: None,
        faces_after: None,
        max_faces: None,
        model: None,
        subfolder: None,
        job_id: None,
        cache_hit: None,
        cache_kind: None,
        image_cache_hit: None,
        mesh_cache_hit: None,
        cleanup_cache_hit: None,
        cleanup_report: None,
        mesh_cleanup_ms: None,
        model_load_ms: None,
        image_preprocess_ms: None,
        mesh_preprocess_ms: None,
        inference_ms: None,
        preprocess_ms: None,
        export_ms: None,
        output_size_bytes: None,
    }
}

fn attach_output_size(mut result: GenerateResult, fallback_output: &str) -> GenerateResult {
    if result.ok && result.output_size_bytes.is_none() {
        let output = result.output.as_deref().unwrap_or(fallback_output);
        result.output_size_bytes = std::fs::metadata(output).ok().map(|metadata| metadata.len());
    }
    result
}

pub fn capture_worker_stderr<R: std::io::Read>(
    reader: R,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
) {
    let mut reader = BufReader::new(reader);
    let mut buffer = Vec::new();

    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer) {
            Ok(0) => break,
            Ok(_) => {
                while buffer
                    .last()
                    .is_some_and(|byte| matches!(*byte, b'\n' | b'\r'))
                {
                    buffer.pop();
                }
                let line = String::from_utf8_lossy(&buffer).into_owned();
                let Ok(mut tail) = stderr_tail.lock() else { break };
                if tail.len() >= LOG_TAIL_LINES { tail.pop_front(); }
                tail.push_back(line);
            }
            Err(error) => {
                let Ok(mut tail) = stderr_tail.lock() else { break };
                if tail.len() >= LOG_TAIL_LINES { tail.pop_front(); }
                tail.push_back(format!("[stderr capture error] {error}"));
                break;
            }
        }
    }
}

struct WorkerSession {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    stdout_log_tail: VecDeque<String>,
    next_job_id: u64,
}

impl WorkerSession {
    fn spawn() -> Result<Self, String> {
        let python = configured_python();
        let worker = configured_worker_path()?;
        let allocator = std::env::var("PYTORCH_CUDA_ALLOC_CONF")
            .unwrap_or_else(|_| "expandable_segments:True".to_string());

        let mut child = Command::new(&python)
            .arg(worker)
            .arg("serve")
            .env("PYTORCH_CUDA_ALLOC_CONF", allocator)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Failed to start persistent Python worker with {python}: {error}"))?;

        let stdin = child.stdin.take().ok_or_else(|| "Persistent worker stdin was not captured.".to_string())?;
        let stdout = child.stdout.take().ok_or_else(|| "Persistent worker stdout was not captured.".to_string())?;
        let stderr = child.stderr.take().ok_or_else(|| "Persistent worker stderr was not captured.".to_string())?;

        let stderr_tail = Arc::new(Mutex::new(VecDeque::with_capacity(LOG_TAIL_LINES)));
        let stderr_tail_for_thread = Arc::clone(&stderr_tail);
        thread::spawn(move || capture_worker_stderr(stderr, stderr_tail_for_thread));

        let mut session = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            stderr_tail,
            stdout_log_tail: VecDeque::with_capacity(LOG_TAIL_LINES),
            next_job_id: 1,
        };
        session.handshake()?;
        Ok(session)
    }

    fn next_job_id(&mut self) -> String {
        let job_id = format!("job-{}", self.next_job_id);
        self.next_job_id += 1;
        job_id
    }

    fn write_command<T: Serialize>(&mut self, command: &T) -> Result<(), SessionError> {
        serde_json::to_writer(&mut self.stdin, command)
            .map_err(|error| SessionError::protocol(format!("Could not serialize worker command: {error}")))?;
        self.stdin.write_all(b"\n").and_then(|_| self.stdin.flush())
            .map_err(|error| SessionError::crashed(format!("Could not write to worker stdin: {error}")))
    }

    fn stderr_summary(&self) -> String {
        let Ok(tail) = self.stderr_tail.lock() else { return String::new(); };
        tail.iter().cloned().collect::<Vec<_>>().join("\n")
    }

    fn stdout_log_summary(&self) -> String {
        self.stdout_log_tail.iter().cloned().collect::<Vec<_>>().join("\n")
    }

    fn push_stdout_log(&mut self, line: &str) {
        let trimmed = line.trim();
        if trimmed.is_empty() { return; }
        if self.stdout_log_tail.len() >= LOG_TAIL_LINES { self.stdout_log_tail.pop_front(); }
        self.stdout_log_tail.push_back(trimmed.to_string());
    }

    fn read_json_line(&mut self) -> Result<Value, SessionError> {
        loop {
            let mut line = String::new();
            let bytes = self.stdout.read_line(&mut line)
                .map_err(|error| SessionError::crashed(format!("Failed reading worker stdout: {error}")))?;
            if bytes == 0 {
                let status = self.child.try_wait().ok().flatten();
                let stderr = self.stderr_summary();
                let stdout_log = self.stdout_log_summary();
                let status_text = status.map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown exit status".to_string());
                let mut suffix = String::new();
                if !stdout_log.trim().is_empty() {
                    suffix.push_str(&format!("\nWorker stdout log:\n{stdout_log}"));
                }
                if !stderr.trim().is_empty() {
                    suffix.push_str(&format!("\nWorker stderr:\n{stderr}"));
                }
                return Err(SessionError::crashed(format!(
                    "Persistent worker closed stdout ({status_text}).{suffix}"
                )));
            }

            match parse_worker_stdout_line(&line) {
                Ok(Some(value)) => return Ok(value),
                Ok(None) => { self.push_stdout_log(&line); continue; }
                Err(message) => return Err(SessionError::protocol(message)),
            }
        }
    }

    fn handshake(&mut self) -> Result<(), String> {
        let job_id = self.next_job_id();
        let command = control_command(&job_id, "ping");
        self.write_command(&command).map_err(|error| error.message.clone())?;
        let value = self.read_json_line().map_err(|error| error.message.clone())?;
        validate_event_job_id(&value, &job_id).map_err(|error| error.message.clone())?;
        if value.get("event").and_then(Value::as_str) != Some("pong") {
            return Err("Persistent worker handshake did not return pong.".to_string());
        }
        if value.get("protocol_version").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
            return Err(format!(
                "Persistent worker protocol mismatch. Expected {PROTOCOL_VERSION}, got {:?}.",
                value.get("protocol_version")
            ));
        }
        Ok(())
    }

    fn run_generation<F>(&mut self, command: Value, job_id: String, mut on_event: F) -> Result<GenerateResult, SessionError>
    where F: FnMut(WorkerProgressEvent),
    {
        self.write_command(&command)?;
        loop {
            let value = self.read_json_line()?;
            validate_event_job_id(&value, &job_id)?;
            let event_name = value.get("event").and_then(Value::as_str)
                .ok_or_else(|| SessionError::protocol("Worker event is missing the event field."))?;

            if matches!(event_name, "progress" | "cache" | "completed" | "error") {
                let event: WorkerProgressEvent = serde_json::from_value(value.clone())
                    .map_err(|error| SessionError::protocol(format!("Could not decode worker event: {error}")))?;
                on_event(event);
            }
            if matches!(event_name, "completed" | "error") {
                return serde_json::from_value(value)
                    .map_err(|error| SessionError::protocol(format!("Could not decode terminal worker result: {error}")));
            }
            if !matches!(event_name, "progress" | "cache") {
                return Err(SessionError::protocol(format!(
                    "Unexpected event '{event_name}' during generation job."
                )));
            }
        }
    }

    fn preload_shape(&mut self) -> Result<GenerateResult, SessionError> {
        let job_id = self.next_job_id();
        let command = preload_shape_command(&job_id);
        self.run_generation(command, job_id, |_| {})
    }

    fn run_shape<F>(&mut self, request: GenerateRequest, on_event: F) -> Result<GenerateResult, SessionError>
    where F: FnMut(WorkerProgressEvent),
    {
        let job_id = self.next_job_id();
        let command = shape_command(&job_id, &request);
        self.run_generation(command, job_id, on_event)
    }

    fn run_texture<F>(&mut self, request: TextureRequest, on_event: F) -> Result<GenerateResult, SessionError>
    where F: FnMut(WorkerProgressEvent),
    {
        let job_id = self.next_job_id();
        let command = texture_command(&job_id, &request);
        self.run_generation(command, job_id, on_event)
    }

    fn run_mesh_cleanup<F>(&mut self, request: MeshCleanupRequest, on_event: F) -> Result<GenerateResult, SessionError>
    where F: FnMut(WorkerProgressEvent),
    {
        let job_id = self.next_job_id();
        let command = mesh_cleanup_command(&job_id, &request);
        self.run_generation(command, job_id, on_event)
    }

    fn control(&mut self, name: &str) -> Result<(), SessionError> {
        let job_id = self.next_job_id();
        let command = control_command(&job_id, name);
        self.write_command(&command)?;
        loop {
            let value = self.read_json_line()?;
            validate_event_job_id(&value, &job_id)?;
            let event_name = value.get("event").and_then(Value::as_str).unwrap_or_default();
            if event_name == "cache" { continue; }
            if event_name == "completed" { return Ok(()); }
            if event_name == "error" {
                return Err(SessionError::protocol(format!(
                    "Worker control command '{name}' returned an error: {}",
                    value.get("error").and_then(Value::as_str).unwrap_or("unknown worker error")
                )));
            }
            return Err(SessionError::protocol(format!(
                "Unexpected event '{event_name}' for control command '{name}'."
            )));
        }
    }

    fn shutdown(&mut self) { let _ = self.control("shutdown"); let _ = self.child.wait(); }
    fn kill(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); }
}

impl Drop for WorkerSession {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() { self.kill(); }
    }
}

#[derive(Default)]
pub struct WorkerSessionManager { inner: Mutex<Option<WorkerSession>> }

impl WorkerSessionManager {
    fn get_or_spawn<'a>(&self, guard: &'a mut Option<WorkerSession>) -> Result<&'a mut WorkerSession, String> {
        if guard.is_none() { *guard = Some(WorkerSession::spawn()?); }
        guard.as_mut().ok_or_else(|| "Persistent worker session was not initialized.".to_string())
    }

    fn invalidate(guard: &mut Option<WorkerSession>) {
        if let Some(mut session) = guard.take() { session.kill(); }
    }

    pub fn preload_shape(&self) -> Result<GenerateResult, String> {
        let mut guard = self.inner.lock()
            .map_err(|_| "Persistent worker session lock is poisoned.".to_string())?;
        let result = self.get_or_spawn(&mut guard)?.preload_shape();
        match result {
            Ok(result) => Ok(result),
            Err(error) => {
                Self::invalidate(&mut guard);
                Ok(failure_result(error.kind, error.message))
            }
        }
    }

    pub fn run_shape<F>(&self, request: GenerateRequest, on_event: F) -> Result<GenerateResult, String>
    where F: FnMut(WorkerProgressEvent),
    {
        if !backend_is_implemented(&request.backend) {
            return Err(format!(
                "Backend '{}' is not implemented. Select native-rocm; no silent fallback was applied.", request.backend
            ));
        }
        let mut guard = self.inner.lock()
            .map_err(|_| "Persistent worker session lock is poisoned.".to_string())?;
        let result = self.get_or_spawn(&mut guard)?.run_shape(request, on_event);
        match result {
            Ok(result) => Ok(result),
            Err(error) => { Self::invalidate(&mut guard); Ok(failure_result(error.kind, error.message)) }
        }
    }

    pub fn run_texture<F>(&self, request: TextureRequest, on_event: F) -> Result<GenerateResult, String>
    where F: FnMut(WorkerProgressEvent),
    {
        texture_arguments(&request)?;
        let fallback_output = request.output.clone();
        let mut guard = self.inner.lock()
            .map_err(|_| "Persistent worker session lock is poisoned.".to_string())?;
        let result = self.get_or_spawn(&mut guard)?.run_texture(request, on_event);
        match result {
            Ok(result) => Ok(attach_output_size(result, &fallback_output)),
            Err(error) => { Self::invalidate(&mut guard); Ok(failure_result(error.kind, error.message)) }
        }
    }

    pub fn run_mesh_cleanup<F>(&self, request: MeshCleanupRequest, on_event: F) -> Result<GenerateResult, String>
    where F: FnMut(WorkerProgressEvent),
    {
        let mut guard = self.inner.lock()
            .map_err(|_| "Persistent worker session lock is poisoned.".to_string())?;
        let result = self.get_or_spawn(&mut guard)?.run_mesh_cleanup(request, on_event);
        match result {
            Ok(result) => Ok(result),
            Err(error) => { Self::invalidate(&mut guard); Ok(failure_result(error.kind, error.message)) }
        }
    }

    pub fn clear_cache(&self) -> Result<(), String> {
        let mut guard = self.inner.lock()
            .map_err(|_| "Persistent worker session lock is poisoned.".to_string())?;
        let Some(session) = guard.as_mut() else { return Ok(()); };
        if let Err(error) = session.control("clear_cache") {
            Self::invalidate(&mut guard);
            return Err(error.message);
        }
        Ok(())
    }

    pub fn restart(&self) -> Result<(), String> {
        let mut guard = self.inner.lock()
            .map_err(|_| "Persistent worker session lock is poisoned.".to_string())?;
        if let Some(mut session) = guard.take() { session.shutdown(); }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{attach_output_size, mesh_cleanup_command, preload_shape_command, shape_command, texture_command, validate_event_job_id};
    use crate::worker::{GenerateRequest, GenerateResult, MeshCleanupRequest, TextureRequest};
    use serde_json::json;
    use std::fs;

    fn fixture_shape_request() -> GenerateRequest {
        GenerateRequest {
            backend: "native-rocm".to_string(), input: "source.png".to_string(), output: "shape.glb".to_string(),
            model: None, subfolder: None, steps: 20, seed: 1234, remove_background: true,
        }
    }

    fn fixture_texture_request() -> TextureRequest {
        TextureRequest {
            backend: "native-rocm".to_string(), engine: "hunyuan-paint".to_string(), profile: "balanced".to_string(),
            style_preset: None, max_faces: None,
            mesh: "shape.glb".to_string(), image: "source.png".to_string(), output: "textured.glb".to_string(),
            model: None, subfolder: None, remove_background: true,
        }
    }

    fn fixture_mesh_cleanup_request() -> MeshCleanupRequest {
        MeshCleanupRequest {
            input: "source.glb".to_string(), output: "source-clean.glb".to_string(),
            preset: "game-ready".to_string(), overrides: None,
        }
    }

    #[test]
    fn preload_command_has_job_id() {
        let value = preload_shape_command("job-preload");
        assert_eq!(value["command"], "preload_shape");
        assert_eq!(value["job_id"], "job-preload");
    }

    #[test]
    fn shape_command_has_job_id_and_request() {
        let value = shape_command("job-7", &fixture_shape_request());
        assert_eq!(value["command"], "shape");
        assert_eq!(value["job_id"], "job-7");
        assert_eq!(value["request"]["steps"], 20);
        assert_eq!(value["request"]["removeBackground"], true);
    }

    #[test]
    fn texture_command_has_profile_and_engine() {
        let value = texture_command("job-8", &fixture_texture_request());
        assert_eq!(value["command"], "texture");
        assert_eq!(value["job_id"], "job-8");
        assert_eq!(value["request"]["profile"], "balanced");
        assert_eq!(value["request"]["engine"], "hunyuan-paint");
    }

    #[test]
    fn mesh_cleanup_command_has_request_and_job_id() {
        let value = mesh_cleanup_command("job-10", &fixture_mesh_cleanup_request());
        assert_eq!(value["command"], "mesh_cleanup");
        assert_eq!(value["job_id"], "job-10");
        assert_eq!(value["request"]["preset"], "game-ready");
    }

    #[test]
    fn matching_job_id_is_accepted() {
        let value = json!({"job_id":"job-9","event":"progress"});
        assert!(validate_event_job_id(&value, "job-9").is_ok());
    }

    #[test]
    fn mismatched_job_id_is_protocol_error() {
        let value = json!({"job_id":"job-other","event":"progress"});
        let error = validate_event_job_id(&value, "job-9").unwrap_err();
        assert_eq!(error.kind, "protocol_error");
    }

    #[test]
    fn texture_result_gets_exported_file_size() {
        let path = std::env::temp_dir().join(format!("img2model-output-size-{}.glb", std::process::id()));
        fs::write(&path, vec![0_u8; 321]).unwrap();
        let result: GenerateResult = serde_json::from_value(json!({
            "ok": true,
            "event": "completed",
            "output": path.to_string_lossy(),
        })).unwrap();

        let result = attach_output_size(result, "unused.glb");
        assert_eq!(result.output_size_bytes, Some(321));

        let _ = fs::remove_file(path);
    }
}
