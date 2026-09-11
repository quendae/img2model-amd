#[cfg(test)]
mod tests {
    use super::resolve_worker_path;
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
}
