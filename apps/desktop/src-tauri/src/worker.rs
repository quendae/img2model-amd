use crate::diagnostics::configured_python;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

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
pub struct GenerateResult {
    pub ok: bool,
    pub event: String,
    pub output: Option<String>,
    pub error: Option<String>,
    pub model: Option<String>,
    pub subfolder: Option<String>,
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

pub fn configured_worker_path() -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("IMG2MODEL_WORKER") {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!("IMG2MODEL_WORKER does not point to a file: {}", path.display()));
    }

    if let Ok(current_dir) = std::env::current_dir() {
        if let Some(path) = resolve_worker_path(&current_dir) {
            return Ok(path);
        }
    }

    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            if let Some(path) = resolve_worker_path(parent) {
                return Ok(path);
            }
        }
    }

    Err("Could not locate backends/hunyuan/worker.py. Set IMG2MODEL_WORKER explicitly.".to_string())
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

    Command::new(&python)
        .arg(worker)
        .args(arguments)
        .output()
        .map_err(|error| format!("Failed to start Python worker with {python}: {error}"))
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

pub fn generate_shape(request: GenerateRequest) -> Result<GenerateResult, String> {
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

    let output = run_worker(&arguments)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let result: GenerateResult = parse_last_json_line(&stdout)?;

    if output.status.success() || !result.ok {
        Ok(result)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Generation worker failed: {}", stderr.trim()))
    }
}

#[cfg(test)]
mod tests {
    use super::{backend_is_implemented, parse_last_json_line, resolve_worker_path};
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
}
