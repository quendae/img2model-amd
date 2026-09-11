use std::collections::HashSet;

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
