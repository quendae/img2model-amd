use std::path::{Path, PathBuf};

pub fn resolve_worker_path(start: &Path) -> Option<PathBuf> {
    for ancestor in start.ancestors() {
        let candidate = ancestor.join("backends").join("hunyuan").join("worker.py");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
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
        let error = parse_last_json_line("progress\nnot-json\n").unwrap_err();
        assert!(error.contains("valid JSON"));
    }

    #[test]
    fn only_native_rocm_is_executable_in_first_vertical_slice() {
        assert!(backend_is_implemented("native-rocm"));
        assert!(!backend_is_implemented("wsl-rocm"));
        assert!(!backend_is_implemented("vulkan"));
    }
}
