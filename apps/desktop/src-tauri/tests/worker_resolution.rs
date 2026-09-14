use img2model_amd_lib::worker::configured_worker_path;
use std::fs;
use std::path::PathBuf;

struct ProcessStateGuard {
    cwd: PathBuf,
    worker_env: Option<String>,
}

impl Drop for ProcessStateGuard {
    fn drop(&mut self) {
        let _ = std::env::set_current_dir(&self.cwd);
        match &self.worker_env {
            Some(value) => std::env::set_var("IMG2MODEL_WORKER", value),
            None => std::env::remove_var("IMG2MODEL_WORKER"),
        }
    }
}

#[test]
fn debug_development_prefers_repository_worker_over_stale_persisted_worker() {
    assert!(cfg!(debug_assertions), "this regression test exercises debug worker selection");

    let original_cwd = std::env::current_dir().unwrap();
    let original_worker_env = std::env::var("IMG2MODEL_WORKER").ok();
    let _guard = ProcessStateGuard {
        cwd: original_cwd,
        worker_env: original_worker_env,
    };

    let root = std::env::temp_dir().join(format!(
        "img2model-worker-resolution-{}",
        std::process::id()
    ));
    let repo_cwd = root.join("repo/apps/desktop/src-tauri");
    let source_worker = root.join("repo/backends/hunyuan/worker.py");
    let persisted_worker = root.join("runtime/worker.py");

    fs::create_dir_all(&repo_cwd).unwrap();
    fs::create_dir_all(source_worker.parent().unwrap()).unwrap();
    fs::create_dir_all(persisted_worker.parent().unwrap()).unwrap();
    fs::write(&source_worker, "# source worker\n").unwrap();
    fs::write(&persisted_worker, "# stale persisted worker\n").unwrap();

    std::env::set_current_dir(&repo_cwd).unwrap();
    std::env::set_var("IMG2MODEL_WORKER", &persisted_worker);

    let resolved = configured_worker_path().unwrap();
    assert_eq!(resolved, source_worker);

    let _ = fs::remove_dir_all(root);
}
