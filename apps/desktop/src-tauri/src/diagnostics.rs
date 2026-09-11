use serde::Serialize;
use std::collections::HashSet;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemDiagnostics {
    pub os: String,
    pub arch: String,
    pub wsl_available: bool,
    pub python: Option<String>,
    pub amd_gpus: Vec<String>,
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

pub fn configured_python() -> String {
    let override_value = std::env::var("IMG2MODEL_PYTHON").ok();
    python_executable_from_override(override_value.as_deref())
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
    use super::{parse_gpu_names, python_executable_from_override};

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
    fn python_defaults_to_platform_launcher_name() {
        let value = python_executable_from_override(None);
        if cfg!(windows) {
            assert_eq!(value, "python.exe");
        } else {
            assert_eq!(value, "python3");
        }
    }
}
