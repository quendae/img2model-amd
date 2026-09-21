use crate::diagnostics::{configured_python, native_rocm_runtime_dir};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
pub(crate) const WINDOWS_CREATE_NO_WINDOW: u32 = 0x08000000;

pub(crate) fn configure_background_process(command: &mut Command) {
    #[cfg(windows)]
    {
        command.creation_flags(WINDOWS_CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerHealth {
    pub ok: bool,
    pub python: String,
    pub torch_available: bool,
    pub hunyuan_available: bool,
    pub torch_version: Option<String>,
    pub hip_version: Option<String>,
    pub device_name: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextureHealth {
    pub ok: bool,
    pub texgen_available: bool,
    pub custom_rasterizer_available: bool,
    pub mesh_processor_available: bool,
    pub texture_import_ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshCleanupReport {
    pub preset: String,
    pub config_label: String,
    pub algorithm_version: String,
    pub triangles_before: u64,
    pub triangles_after: u64,
    pub vertices_before: u64,
    pub vertices_after: u64,
    pub components_before: u64,
    pub components_after: u64,
    pub components_removed: Option<u64>,
    pub vertices_welded: Option<u64>,
    pub spikes_adjusted: Option<u64>,
    pub cleanup_ms: f64,
    pub watertight_before: Option<bool>,
    pub watertight_after: Option<bool>,
    pub manifold_before: Option<bool>,
    pub manifold_after: Option<bool>,
    pub boundary_edges_before: Option<u64>,
    pub boundary_edges_after: Option<u64>,
    pub pre_repair_watertight: Option<bool>,
    pub pre_repair_manifold: Option<bool>,
    pub pre_repair_boundary_edges: Option<u64>,
    pub holes_closed: Option<u64>,
    pub non_manifold_edges_fixed: Option<u64>,
    pub reduction_ratio: Option<f64>,
    pub remeshed: Option<bool>,
    pub repair_backend: Option<String>,
    pub normalized_error: Option<f64>,
    pub target_triangles: Option<u64>,
    pub stage_ms: Option<std::collections::BTreeMap<String, f64>>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerProgressEvent {
    pub event: String,
    pub job_id: Option<String>,
    pub stage: Option<String>,
    pub progress: Option<f64>,
    pub error_kind: Option<String>,
    pub requested_profile: Option<String>,
    pub resolved_profile: Option<String>,
    pub faces_before: Option<u64>,
    pub faces_after: Option<u64>,
    pub max_faces: Option<u64>,
    pub cpu_offload: Option<bool>,
    pub attention_slicing: Option<String>,
    pub cache_hit: Option<bool>,
    pub cache_kind: Option<String>,
    pub image_cache_hit: Option<bool>,
    pub mesh_cache_hit: Option<bool>,
    pub cleanup_cache_hit: Option<bool>,
    pub cleanup_report: Option<MeshCleanupReport>,
    pub mesh_cleanup_ms: Option<f64>,
    pub model_load_ms: Option<f64>,
    pub image_preprocess_ms: Option<f64>,
    pub mesh_preprocess_ms: Option<f64>,
    pub inference_ms: Option<f64>,
    pub preprocess_ms: Option<f64>,
    pub export_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    pub backend: String,
    pub input: String,
    pub output: String,
    pub model: Option<String>,
    pub subfolder: Option<String>,
    pub steps: u32,
    pub seed: u64,
    pub remove_background: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureRequest {
    pub backend: String,
    pub engine: String,
    pub profile: String,
    #[serde(default)]
    pub style_preset: Option<String>,
    #[serde(default)]
    pub style_strength: Option<f64>,
    #[serde(default)]
    pub preserve_source_colors: Option<bool>,
    #[serde(default)]
    pub style_reference: Option<String>,
    #[serde(default)]
    pub max_faces: Option<u64>,
    pub mesh: String,
    pub image: String,
    pub output: String,
    pub model: Option<String>,
    pub subfolder: Option<String>,
    pub remove_background: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshCleanupRequest {
    pub input: String,
    pub output: String,
    pub preset: String,
    pub overrides: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRepaintRequest {
    pub source_png: Vec<u8>,
    pub mask_png: Vec<u8>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub reference_image: Option<String>,
    pub feather_px: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRepaintWorkerRequest {
    pub source: String,
    pub mask: String,
    pub output: String,
    pub prompt: Option<String>,
    pub reference_image: Option<String>,
    pub feather_px: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRepaintResponse {
    pub ok: bool,
    pub edited_png: Option<Vec<u8>>,
    pub error: Option<String>,
    pub error_kind: Option<String>,
    pub model: Option<String>,
    pub cache_hit: Option<bool>,
    pub model_load_ms: Option<f64>,
    pub inference_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateResult {
    pub ok: bool,
    pub event: String,
    pub output: Option<String>,
    pub error: Option<String>,
    pub error_kind: Option<String>,
    pub stage: Option<String>,
    pub requested_profile: Option<String>,
    pub resolved_profile: Option<String>,
    pub faces_before: Option<u64>,
    pub faces_after: Option<u64>,
    pub max_faces: Option<u64>,
    pub model: Option<String>,
    pub subfolder: Option<String>,
    pub job_id: Option<String>,
    pub cache_hit: Option<bool>,
    pub cache_kind: Option<String>,
    pub image_cache_hit: Option<bool>,
    pub mesh_cache_hit: Option<bool>,
    pub cleanup_cache_hit: Option<bool>,
    pub cleanup_report: Option<MeshCleanupReport>,
    pub mesh_cleanup_ms: Option<f64>,
    pub model_load_ms: Option<f64>,
    pub image_preprocess_ms: Option<f64>,
    pub mesh_preprocess_ms: Option<f64>,
    pub inference_ms: Option<f64>,
    pub preprocess_ms: Option<f64>,
    pub export_ms: Option<f64>,
    pub output_size_bytes: Option<u64>,
}

pub fn resolve_worker_path(start: &Path) -> Option<PathBuf> {
    for ancestor in start.ancestors() {
        let candidate = ancestor.join("backends").join("hunyuan").join("worker.py");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn runtime_worker_path(runtime_dir: Option<&Path>) -> Option<PathBuf> {
    let worker = runtime_dir?.join("worker.py");
    worker.is_file().then_some(worker)
}

fn repository_worker_path() -> Option<PathBuf> {
    if let Ok(current_dir) = std::env::current_dir() {
        if let Some(path) = resolve_worker_path(&current_dir) {
            return Some(path);
        }
    }

    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            if let Some(path) = resolve_worker_path(parent) {
                return Some(path);
            }
        }
    }

    None
}

fn configured_worker_override() -> Result<Option<PathBuf>, String> {
    if let Ok(value) = std::env::var("IMG2MODEL_WORKER") {
        let value = value.trim();
        if !value.is_empty() {
            let path = PathBuf::from(value);
            if path.is_file() {
                return Ok(Some(path));
            }
            return Err(format!("IMG2MODEL_WORKER does not point to a file: {}", path.display()));
        }
    }
    Ok(None)
}

pub fn configured_worker_path() -> Result<PathBuf, String> {
    // Development runs must execute the worker from the checked-out source tree.
    // The setup script intentionally persists IMG2MODEL_WORKER for packaged runs,
    // but preferring that copied file during `tauri dev` makes Python backend
    // changes appear to be ignored until the runtime is reinstalled.
    if cfg!(debug_assertions) {
        if let Some(path) = repository_worker_path() {
            return Ok(path);
        }
    }

    if let Some(path) = configured_worker_override()? {
        return Ok(path);
    }

    if let Some(path) = runtime_worker_path(native_rocm_runtime_dir().as_deref()) {
        return Ok(path);
    }

    if let Some(path) = repository_worker_path() {
        return Ok(path);
    }

    Err("Could not locate the installed runtime worker or backends/hunyuan/worker.py. Set IMG2MODEL_WORKER explicitly.".to_string())
}

pub fn parse_last_json_line<T: DeserializeOwned>(stdout: &str) -> Result<T, String> {
    let line = stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| "Worker returned no JSON output.".to_string())?;

    serde_json::from_str(line)
        .map_err(|error| format!("Worker did not end with valid JSON: {error}"))
}

pub fn backend_is_implemented(backend: &str) -> bool {
    backend == "native-rocm"
}

fn run_worker(arguments: &[String]) -> Result<Output, String> {
    let python = configured_python();
    let worker = configured_worker_path()?;
    let mut command = Command::new(&python);
    configure_background_process(&mut command);

    command
        .arg(worker)
        .args(arguments)
        .output()
        .map_err(|error| format!("Failed to start Python worker with {python}: {error}"))
}

fn run_worker_streamed<F>(arguments: &[String], mut on_event: F) -> Result<(std::process::ExitStatus, String, String), String>
where
    F: FnMut(WorkerProgressEvent),
{
    let python = configured_python();
    let worker = configured_worker_path()?;
    let allocator = std::env::var("PYTORCH_CUDA_ALLOC_CONF")
        .unwrap_or_else(|_| "expandable_segments:True".to_string());
    let mut command = Command::new(&python);
    configure_background_process(&mut command);

    let mut child = command
        .arg(worker)
        .args(arguments)
        .env("PYTORCH_CUDA_ALLOC_CONF", allocator)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to start Python worker with {python}: {error}"))?;

    let stdout = child.stdout.take().ok_or_else(|| "Worker stdout was not captured.".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "Worker stderr was not captured.".to_string())?;

    let stderr_reader = thread::spawn(move || {
        let mut text = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut text);
        text
    });

    let mut captured_stdout = String::new();
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|error| format!("Failed reading worker output: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }

        captured_stdout.push_str(&line);
        captured_stdout.push('\n');

        if let Ok(event) = serde_json::from_str::<WorkerProgressEvent>(&line) {
            if matches!(event.event.as_str(), "progress" | "cache" | "completed" | "error") {
                on_event(event);
            }
        }
    }

    let status = child
        .wait()
        .map_err(|error| format!("Failed waiting for Python worker: {error}"))?;
    let captured_stderr = stderr_reader.join().unwrap_or_else(|_| "Worker stderr reader panicked.".to_string());

    Ok((status, captured_stdout, captured_stderr))
}

pub fn worker_health() -> Result<WorkerHealth, String> {
    let output = run_worker(&["health".to_string(), "--json".to_string()])?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let health: WorkerHealth = parse_last_json_line(&stdout)?;

    if output.status.success() {
        Ok(health)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Worker health command failed: {}", stderr.trim()))
    }
}

pub fn worker_texture_health() -> Result<TextureHealth, String> {
    let output = run_worker(&["texture-health".to_string(), "--json".to_string()])?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let health: TextureHealth = parse_last_json_line(&stdout)?;

    if output.status.success() {
        Ok(health)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Texture health command failed: {}", stderr.trim()))
    }
}

pub fn generate_shape(request: GenerateRequest) -> Result<GenerateResult, String> {
    generate_shape_with_progress(request, |_| {})
}

pub fn generate_shape_with_progress<F>(request: GenerateRequest, on_event: F) -> Result<GenerateResult, String>
where
    F: FnMut(WorkerProgressEvent),
{
    if !backend_is_implemented(&request.backend) {
        return Err(format!(
            "Backend '{}' is not implemented in this MVP. Select native-rocm; no silent fallback was applied.",
            request.backend
        ));
    }

    let model = request
        .model
        .unwrap_or_else(|| "tencent/Hunyuan3D-2mini".to_string());
    let subfolder = request
        .subfolder
        .unwrap_or_else(|| "hunyuan3d-dit-v2-mini".to_string());

    let mut arguments = vec![
        "generate".to_string(),
        "--input".to_string(),
        request.input,
        "--output".to_string(),
        request.output,
        "--model".to_string(),
        model,
        "--subfolder".to_string(),
        subfolder,
        "--steps".to_string(),
        request.steps.to_string(),
        "--seed".to_string(),
        request.seed.to_string(),
    ];

    if request.remove_background {
        arguments.push("--remove-background".to_string());
    }

    let (status, stdout, stderr) = run_worker_streamed(&arguments, on_event)?;
    let result: GenerateResult = parse_last_json_line(&stdout)?;

    if status.success() || !result.ok {
        Ok(result)
    } else {
        Err(format!("Generation worker failed: {}", stderr.trim()))
    }
}

pub fn texture_arguments(request: &TextureRequest) -> Result<Vec<String>, String> {
    if !backend_is_implemented(&request.backend) {
        return Err(format!(
            "Backend '{}' is not implemented for texture generation. Select native-rocm; no silent fallback was applied.",
            request.backend
        ));
    }
    if request.engine != "hunyuan-paint" {
        return Err(format!("Texture engine '{}' is not implemented.", request.engine));
    }
    if !matches!(request.profile.as_str(), "auto" | "safe" | "balanced" | "quality") {
        return Err(format!("Texture profile '{}' is not implemented.", request.profile));
    }
    let style_preset = request.style_preset.as_deref().unwrap_or("match-source");
    if !matches!(style_preset, "match-source" | "realistic" | "stylized" | "hand-painted" | "cartoon" | "pixel-art") {
        return Err(format!("Texture style preset '{}' is not implemented.", style_preset));
    }
    if let Some(style_strength) = request.style_strength {
        if !(0.0..=1.0).contains(&style_strength) {
            return Err(format!("Texture styleStrength must be between 0.0 and 1.0; got {style_strength}."));
        }
    }
    if let Some(max_faces) = request.max_faces {
        if !(300..=40_000).contains(&max_faces) {
            return Err(format!(
                "Texture maxFaces must be between 300 and 40000 triangles; got {max_faces}."
            ));
        }
    }

    let model = request
        .model
        .clone()
        .unwrap_or_else(|| "tencent/Hunyuan3D-2".to_string());
    let subfolder = request
        .subfolder
        .clone()
        .unwrap_or_else(|| "hunyuan3d-paint-v2-0-turbo".to_string());

    let mut arguments = vec![
        "texture".to_string(),
        "--mesh".to_string(),
        request.mesh.clone(),
        "--image".to_string(),
        request.image.clone(),
        "--output".to_string(),
        request.output.clone(),
        "--model".to_string(),
        model,
        "--subfolder".to_string(),
        subfolder,
        "--profile".to_string(),
        request.profile.clone(),
        "--style-preset".to_string(),
        style_preset.to_string(),
    ];

    if let Some(style_strength) = request.style_strength {
        arguments.push("--style-strength".to_string());
        arguments.push(style_strength.to_string());
    }
    if request.preserve_source_colors == Some(false) {
        arguments.push("--no-preserve-source-colors".to_string());
    }
    if let Some(style_reference) = request.style_reference.as_deref().filter(|value| !value.trim().is_empty()) {
        arguments.push("--style-reference".to_string());
        arguments.push(style_reference.to_string());
    }

    if let Some(max_faces) = request.max_faces {
        arguments.push("--max-faces".to_string());
        arguments.push(max_faces.to_string());
    }

    if request.remove_background {
        arguments.push("--remove-background".to_string());
    }

    Ok(arguments)
}

pub fn texture_mesh(request: TextureRequest) -> Result<GenerateResult, String> {
    texture_mesh_with_progress(request, |_| {})
}

pub fn texture_mesh_with_progress<F>(request: TextureRequest, on_event: F) -> Result<GenerateResult, String>
where
    F: FnMut(WorkerProgressEvent),
{
    let arguments = texture_arguments(&request)?;
    let (status, stdout, stderr) = run_worker_streamed(&arguments, on_event)?;
    let mut result: GenerateResult = parse_last_json_line(&stdout)?;

    if result.ok && result.output_size_bytes.is_none() {
        if let Some(output) = result.output.as_deref() {
            result.output_size_bytes = std::fs::metadata(output).ok().map(|metadata| metadata.len());
        }
    }

    if status.success() || !result.ok {
        Ok(result)
    } else {
        Err(format!("Texture worker failed: {}", stderr.trim()))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        backend_is_implemented, parse_last_json_line, resolve_worker_path, runtime_worker_path,
        texture_arguments, GenerateResult, TextureRequest, WorkerProgressEvent,
    };
    use serde_json::Value;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn finds_worker_by_walking_up_to_repository_root() {
        let root = std::env::temp_dir().join(format!("img2model-worker-test-{}", std::process::id()));
        let nested = root.join("apps/desktop/src-tauri");
        let worker = root.join("backends/hunyuan/worker.py");
        fs::create_dir_all(worker.parent().unwrap()).unwrap();
        fs::create_dir_all(&nested).unwrap();
        fs::write(&worker, "print('ok')").unwrap();

        let resolved = resolve_worker_path(&nested);
        assert_eq!(resolved, Some(worker.clone()));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn finds_worker_inside_persisted_runtime() {
        let root = std::env::temp_dir().join(format!("img2model-persisted-worker-test-{}", std::process::id()));
        let worker = root.join("worker.py");
        fs::create_dir_all(&root).unwrap();
        fs::write(&worker, "print('ok')").unwrap();

        assert_eq!(runtime_worker_path(Some(&root)), Some(worker.clone()));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn returns_none_when_worker_is_not_present() {
        let start = PathBuf::from("/definitely/not/a/repository");
        assert_eq!(resolve_worker_path(&start), None);
    }

    #[test]
    fn parses_final_json_event_after_progress_lines() {
        let stdout = "{\"event\":\"progress\",\"progress\":0.5}\n{\"event\":\"completed\",\"ok\":true,\"output\":\"mesh.glb\"}\n";
        let value: Value = parse_last_json_line(stdout).unwrap();
        assert_eq!(value["event"], "completed");
        assert_eq!(value["output"], "mesh.glb");
    }

    #[test]
    fn parses_worker_progress_payload() {
        let event: WorkerProgressEvent = serde_json::from_str(
            "{\"event\":\"progress\",\"stage\":\"running_shape\",\"progress\":0.3}",
        )
        .unwrap();
        assert_eq!(event.event, "progress");
        assert_eq!(event.stage.as_deref(), Some("running_shape"));
        assert_eq!(event.progress, Some(0.3));
    }

    #[test]
    fn parses_texture_profile_progress_payload() {
        let event: WorkerProgressEvent = serde_json::from_str(
            r#"{"event":"progress","stage":"mesh_ready","progress":0.18,"requested_profile":"auto","resolved_profile":"balanced","faces_before":40000,"faces_after":20000,"max_faces":20000,"mesh_cache_hit":true}"#,
        )
        .unwrap();
        assert_eq!(event.requested_profile.as_deref(), Some("auto"));
        assert_eq!(event.resolved_profile.as_deref(), Some("balanced"));
        assert_eq!(event.faces_after, Some(20_000));
        assert_eq!(event.max_faces, Some(20_000));
        assert_eq!(event.mesh_cache_hit, Some(true));
    }

    #[test]
    fn parses_cache_and_timing_payload() {
        let event: WorkerProgressEvent = serde_json::from_str(
            r#"{"event":"cache","job_id":"job-2","stage":"cache_hit","cache_hit":true,"cache_kind":"texture","model_load_ms":0.1}"#,
        )
        .unwrap();
        assert_eq!(event.job_id.as_deref(), Some("job-2"));
        assert_eq!(event.cache_hit, Some(true));
        assert_eq!(event.cache_kind.as_deref(), Some("texture"));
    }

    #[test]
    fn parses_structured_texture_oom_result() {
        let result: GenerateResult = serde_json::from_str(
            r#"{"event":"error","ok":false,"stage":"texture","error_kind":"out_of_memory","error":"CUDA out of memory"}"#,
        )
        .unwrap();
        assert_eq!(result.error_kind.as_deref(), Some("out_of_memory"));
        assert_eq!(result.stage.as_deref(), Some("texture"));
    }

    #[test]
    fn malformed_final_worker_line_is_an_error() {
        let error = parse_last_json_line::<Value>("progress\nnot-json\n").unwrap_err();
        assert!(error.contains("valid JSON"));
    }

    #[test]
    fn only_native_rocm_is_executable_in_first_vertical_slice() {
        assert!(backend_is_implemented("native-rocm"));
        assert!(!backend_is_implemented("wsl-rocm"));
        assert!(!backend_is_implemented("vulkan"));
    }

    #[test]
    fn texture_arguments_keep_paths_as_separate_process_arguments() {
        let request = TextureRequest {
            backend: "native-rocm".to_string(),
            engine: "hunyuan-paint".to_string(),
            profile: "safe".to_string(),
            style_preset: None,
            style_strength: None,
            preserve_source_colors: None,
            style_reference: None,
            max_faces: None,
            mesh: "C:\\input folder\\shape.glb".to_string(),
            image: "C:\\input folder\\source.png".to_string(),
            output: "C:\\output folder\\textured.glb".to_string(),
            model: None,
            subfolder: None,
            remove_background: true,
        };

        let arguments = texture_arguments(&request).unwrap();
        assert_eq!(arguments[0], "texture");
        assert!(arguments.windows(2).any(|pair| pair == ["--mesh", "C:\\input folder\\shape.glb"]));
        assert!(arguments.windows(2).any(|pair| pair == ["--image", "C:\\input folder\\source.png"]));
        assert!(arguments.windows(2).any(|pair| pair == ["--output", "C:\\output folder\\textured.glb"]));
        assert!(arguments.windows(2).any(|pair| pair == ["--profile", "safe"]));
        assert!(!arguments.iter().any(|arg| arg == "--cpu-offload"));
        assert!(arguments.contains(&"--remove-background".to_string()));
    }

    #[test]
    fn texture_arguments_reject_unknown_engine() {
        let request = TextureRequest {
            backend: "native-rocm".to_string(),
            engine: "future-engine".to_string(),
            profile: "auto".to_string(),
            style_preset: None,
            style_strength: None,
            preserve_source_colors: None,
            style_reference: None,
            max_faces: None,
            mesh: "shape.glb".to_string(),
            image: "source.png".to_string(),
            output: "textured.glb".to_string(),
            model: None,
            subfolder: None,
            remove_background: false,
        };
        let error = texture_arguments(&request).unwrap_err();
        assert!(error.contains("not implemented"));
    }
}
