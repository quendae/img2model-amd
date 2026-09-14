use serde::Serialize;
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_DIAGNOSTIC_LOG_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemDiagnostics {
    pub os: String,
    pub arch: String,
    pub wsl_available: bool,
    pub python: Option<String>,
    pub amd_gpus: Vec<String>,
}

#[derive(Serialize)]
struct DiagnosticLogRecord<'a> {
    timestamp_ms: u64,
    pid: u32,
    level: &'a str,
    source: &'a str,
    message: &'a str,
    details: Option<&'a str>,
}

fn diagnostic_log_path_from_base(base: &Path) -> PathBuf {
    base.join("Img2ModelAMD")
        .join("logs")
        .join("img2model-amd.log")
}

pub fn diagnostic_log_path() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    diagnostic_log_path_from_base(&base)
}

fn rotate_diagnostic_log(path: &Path) -> Result<(), String> {
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(());
    };
    if metadata.len() < MAX_DIAGNOSTIC_LOG_BYTES {
        return Ok(());
    }

    let rotated = path.with_file_name("img2model-amd.1.log");
    if rotated.exists() {
        fs::remove_file(&rotated)
            .map_err(|error| format!("Could not remove old diagnostic log {}: {error}", rotated.display()))?;
    }
    fs::rename(path, &rotated)
        .map_err(|error| format!("Could not rotate diagnostic log {}: {error}", path.display()))?;
    Ok(())
}

fn append_diagnostic_log_to_path(
    path: &Path,
    level: &str,
    source: &str,
    message: &str,
    details: Option<&str>,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create diagnostic log directory {}: {error}", parent.display()))?;
    }
    rotate_diagnostic_log(path)?;

    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let record = DiagnosticLogRecord {
        timestamp_ms,
        pid: std::process::id(),
        level,
        source,
        message,
        details,
    };
    let encoded = serde_json::to_string(&record)
        .map_err(|error| format!("Could not serialize diagnostic log record: {error}"))?;

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("Could not open diagnostic log {}: {error}", path.display()))?;
    writeln!(file, "{encoded}")
        .map_err(|error| format!("Could not write diagnostic log {}: {error}", path.display()))?;
    Ok(())
}

pub fn append_diagnostic_log(
    level: &str,
    source: &str,
    message: &str,
    details: Option<&str>,
) -> Result<PathBuf, String> {
    let path = diagnostic_log_path();
    append_diagnostic_log_to_path(&path, level, source, message, details)?;
    Ok(path)
}

pub fn parse_gpu_names(output: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut names = Vec::new();

    for line in output.lines() {
        let name = line.trim();
        if name.is_empty() {
            continue;
        }
        if seen.insert(name.to_string()) {
            names.push(name.to_string());
        }
    }

    names
}

pub fn python_executable_from_override(value: Option<&str>) -> String {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value.to_string(),
        None if cfg!(windows) => "python.exe".to_string(),
        None => "python3".to_string(),
    }
}

pub fn native_rocm_runtime_dir() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }

    let local_app_data = std::env::var("LOCALAPPDATA").ok()?;
    if local_app_data.trim().is_empty() {
        return None;
    }

    Some(
        PathBuf::from(local_app_data)
            .join("Img2ModelAMD")
            .join("runtime")
            .join("native-rocm"),
    )
}

fn python_from_runtime_dir(runtime_dir: Option<&Path>) -> Option<String> {
    let python = runtime_dir?.join("Scripts").join("python.exe");
    python
        .is_file()
        .then(|| python.to_string_lossy().into_owned())
}

pub fn configured_python() -> String {
    let override_value = std::env::var("IMG2MODEL_PYTHON").ok();
    if let Some(value) = override_value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return value.to_string();
    }

    if let Some(runtime_python) = python_from_runtime_dir(native_rocm_runtime_dir().as_deref()) {
        return runtime_python;
    }

    python_executable_from_override(None)
}

fn python_probe() -> Option<String> {
    let python = configured_python();
    Command::new(&python)
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|_| python)
}

#[cfg(windows)]
fn wsl_probe() -> bool {
    Command::new("wsl.exe")
        .arg("--status")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn wsl_probe() -> bool {
    false
}

#[cfg(windows)]
fn amd_gpu_probe() -> Vec<String> {
    const QUERY: &str = "Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'AMD|Radeon' } | Select-Object -ExpandProperty Name";
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", QUERY])
        .output();

    match output {
        Ok(output) if output.status.success() => {
            parse_gpu_names(&String::from_utf8_lossy(&output.stdout))
        }
        _ => Vec::new(),
    }
}

#[cfg(not(windows))]
fn amd_gpu_probe() -> Vec<String> {
    Vec::new()
}

pub fn collect_system_diagnostics() -> SystemDiagnostics {
    SystemDiagnostics {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        wsl_available: wsl_probe(),
        python: python_probe(),
        amd_gpus: amd_gpu_probe(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        append_diagnostic_log_to_path, diagnostic_log_path_from_base, parse_gpu_names,
        python_executable_from_override, python_from_runtime_dir,
    };
    use std::fs;

    #[test]
    fn diagnostic_log_uses_app_local_log_directory() {
        let base = std::path::Path::new("C:/Users/test/AppData/Local");
        assert_eq!(
            diagnostic_log_path_from_base(base),
            base.join("Img2ModelAMD").join("logs").join("img2model-amd.log")
        );
    }

    #[test]
    fn diagnostic_log_is_jsonl_and_keeps_details() {
        let root = std::env::temp_dir().join(format!("img2model-log-test-{}", std::process::id()));
        let path = root.join("diagnostic.log");
        append_diagnostic_log_to_path(
            &path,
            "error",
            "react",
            "preview render failed",
            Some("{\"component\":\"ModelViewer\"}"),
        )
        .unwrap();

        let content = fs::read_to_string(&path).unwrap();
        let line = content.lines().next().unwrap();
        let value: serde_json::Value = serde_json::from_str(line).unwrap();
        assert_eq!(value["level"], "error");
        assert_eq!(value["source"], "react");
        assert_eq!(value["message"], "preview render failed");
        assert_eq!(value["details"], "{\"component\":\"ModelViewer\"}");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parses_and_deduplicates_amd_gpu_names() {
        let output = "AMD Radeon RX 6950 XT\r\nAMD Radeon(TM) Graphics\r\nAMD Radeon RX 6950 XT\r\n";
        assert_eq!(
            parse_gpu_names(output),
            vec![
                "AMD Radeon RX 6950 XT".to_string(),
                "AMD Radeon(TM) Graphics".to_string(),
            ]
        );
    }

    #[test]
    fn ignores_empty_gpu_lines() {
        assert_eq!(parse_gpu_names("\r\n  \n"), Vec::<String>::new());
    }

    #[test]
    fn explicit_python_override_wins() {
        assert_eq!(
            python_executable_from_override(Some("C:\\amd-python\\python.exe")),
            "C:\\amd-python\\python.exe"
        );
    }

    #[test]
    fn discovers_python_inside_runtime_dir() {
        let root = std::env::temp_dir().join(format!("img2model-runtime-test-{}", std::process::id()));
        let python = root.join("Scripts").join("python.exe");
        fs::create_dir_all(python.parent().unwrap()).unwrap();
        fs::write(&python, b"").unwrap();

        assert_eq!(
            python_from_runtime_dir(Some(&root)),
            Some(python.to_string_lossy().into_owned())
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn python_defaults_to_platform_launcher_name() {
        let value = python_executable_from_override(None);
        if cfg!(windows) {
            assert_eq!(value, "python.exe");
        } else {
            assert_eq!(value, "python3");
        }
    }
}
