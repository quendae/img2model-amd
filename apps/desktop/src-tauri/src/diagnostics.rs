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
    use super::parse_gpu_names;

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
}
