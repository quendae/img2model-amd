pub mod diagnostics;
pub mod uv_export;
pub mod worker;
pub mod worker_session;

pub use uv_export::{save_textured_glb_file, save_uv_template_file};

#[cfg(feature = "desktop")]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(feature = "desktop")]
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(feature = "desktop")]
use tauri::{ipc::Channel, Manager};

#[cfg(feature = "desktop")]
fn log_worker_event(operation: &str, event: &worker::WorkerProgressEvent) {
    let details = serde_json::to_string(event).ok();
    let stage = event.stage.as_deref().unwrap_or(event.event.as_str());
    let level = if event.event == "error" { "error" } else { "info" };
    let _ = diagnostics::append_diagnostic_log(
        level,
        "worker",
        &format!("{operation}: {stage}"),
        details.as_deref(),
    );
}

#[cfg(feature = "desktop")]
fn log_worker_result(operation: &str, result: &Result<worker::GenerateResult, String>) {
    match result {
        Ok(value) => {
            let details = serde_json::to_string(value).ok();
            let level = if value.ok { "info" } else { "error" };
            let _ = diagnostics::append_diagnostic_log(
                level,
                "worker",
                &format!("{operation}: terminal result ({})", value.event),
                details.as_deref(),
            );
        }
        Err(error) => {
            let _ = diagnostics::append_diagnostic_log(
                "error",
                "tauri",
                &format!("{operation}: command failed"),
                Some(error),
            );
        }
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn get_system_diagnostics() -> Result<diagnostics::SystemDiagnostics, String> {
    tauri::async_runtime::spawn_blocking(diagnostics::collect_system_diagnostics)
        .await
        .map_err(|error| format!("System diagnostics task failed: {error}"))
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn diagnostic_log_path() -> String {
    diagnostics::diagnostic_log_path().to_string_lossy().into_owned()
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn append_diagnostic_log(
    level: String,
    source: String,
    message: String,
    details: Option<String>,
) -> Result<String, String> {
    diagnostics::append_diagnostic_log(&level, &source, &message, details.as_deref())
        .map(|path| path.to_string_lossy().into_owned())
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn save_uv_template(path: String, contents: String) -> Result<String, String> {
    save_uv_template_file(std::path::Path::new(&path), &contents)
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn save_textured_glb(path: String, bytes: Vec<u8>) -> Result<String, String> {
    save_textured_glb_file(std::path::Path::new(&path), &bytes)
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn hunyuan_health() -> Result<worker::WorkerHealth, String> {
    tauri::async_runtime::spawn_blocking(worker::worker_health)
        .await
        .map_err(|error| format!("Runtime health task failed: {error}"))?
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn hunyuan_texture_health() -> Result<worker::TextureHealth, String> {
    tauri::async_runtime::spawn_blocking(worker::worker_texture_health)
        .await
        .map_err(|error| format!("Texture health task failed: {error}"))?
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn preload_hunyuan_shape(app: tauri::AppHandle) -> Result<worker::GenerateResult, String> {
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = app_handle
            .state::<worker_session::WorkerSessionManager>()
            .preload_shape();
        log_worker_result("preload_shape", &result);
        result
    })
    .await
    .map_err(|error| format!("Shape preload task failed: {error}"))?
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn generate_shape(
    app: tauri::AppHandle,
    request: worker::GenerateRequest,
    on_event: Channel<worker::WorkerProgressEvent>,
) -> Result<worker::GenerateResult, String> {
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let request_details = serde_json::to_string(&request).ok();
        let _ = diagnostics::append_diagnostic_log(
            "info",
            "tauri",
            "generate_shape: command started",
            request_details.as_deref(),
        );
        let manager = app_handle.state::<worker_session::WorkerSessionManager>();
        let mut last_stage: Option<String> = None;
        let result = manager.run_shape(request, |event| {
            let stage_changed = event.stage != last_stage;
            if stage_changed || event.event != "progress" {
                log_worker_event("generate_shape", &event);
            }
            last_stage = event.stage.clone();
            let _ = on_event.send(event);
        });
        log_worker_result("generate_shape", &result);
        result
    })
    .await
    .map_err(|error| format!("Generation task failed: {error}"))?
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn texture_mesh(
    app: tauri::AppHandle,
    request: worker::TextureRequest,
    on_event: Channel<worker::WorkerProgressEvent>,
) -> Result<worker::GenerateResult, String> {
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let request_details = serde_json::to_string(&request).ok();
        let _ = diagnostics::append_diagnostic_log(
            "info",
            "tauri",
            "texture_mesh: command started",
            request_details.as_deref(),
        );
        let manager = app_handle.state::<worker_session::WorkerSessionManager>();
        let mut last_stage: Option<String> = None;
        let result = manager.run_texture(request, |event| {
            let stage_changed = event.stage != last_stage;
            if stage_changed || event.event != "progress" {
                log_worker_event("texture_mesh", &event);
            }
            last_stage = event.stage.clone();
            let _ = on_event.send(event);
        });
        log_worker_result("texture_mesh", &result);
        result
    })
    .await
    .map_err(|error| format!("Texture task failed: {error}"))?
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn cleanup_mesh(
    app: tauri::AppHandle,
    request: worker::MeshCleanupRequest,
    on_event: Channel<worker::WorkerProgressEvent>,
) -> Result<worker::GenerateResult, String> {
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let request_details = serde_json::to_string(&request).ok();
        let _ = diagnostics::append_diagnostic_log(
            "info",
            "tauri",
            "cleanup_mesh: command started",
            request_details.as_deref(),
        );
        let manager = app_handle.state::<worker_session::WorkerSessionManager>();
        let mut last_stage: Option<String> = None;
        let result = manager.run_mesh_cleanup(request, |event| {
            let stage_changed = event.stage != last_stage;
            if stage_changed || event.event != "progress" {
                log_worker_event("cleanup_mesh", &event);
            }
            last_stage = event.stage.clone();
            let _ = on_event.send(event);
        });
        log_worker_result("cleanup_mesh", &result);
        result
    })
    .await
    .map_err(|error| format!("Mesh cleanup task failed: {error}"))?
}

#[cfg(feature = "desktop")]
fn create_local_repaint_temp_dir() -> Result<std::path::PathBuf, String> {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock error while preparing Local Repaint: {error}"))?
        .as_nanos();
    let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "img2model-local-repaint-{}-{timestamp}-{sequence}",
        std::process::id()
    ));
    std::fs::create_dir_all(&path)
        .map_err(|error| format!("Could not create Local Repaint temporary directory: {error}"))?;
    Ok(path)
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn local_repaint(
    app: tauri::AppHandle,
    request: worker::LocalRepaintRequest,
    on_event: Channel<worker::WorkerProgressEvent>,
) -> Result<worker::LocalRepaintResponse, String> {
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let temp = create_local_repaint_temp_dir()?;
        let operation = (|| -> Result<worker::LocalRepaintResponse, String> {
            let source = temp.join("source.png");
            let mask = temp.join("mask.png");
            let output = temp.join("edited.png");

            std::fs::write(&source, &request.source_png)
                .map_err(|error| format!("Could not write Local Repaint source PNG: {error}"))?;
            std::fs::write(&mask, &request.mask_png)
                .map_err(|error| format!("Could not write Local Repaint mask PNG: {error}"))?;

            let worker_request = worker::LocalRepaintWorkerRequest {
                source: source.to_string_lossy().into_owned(),
                mask: mask.to_string_lossy().into_owned(),
                output: output.to_string_lossy().into_owned(),
                prompt: request.prompt,
                reference_image: request.reference_image,
                feather_px: request.feather_px,
            };

            let manager = app_handle.state::<worker_session::WorkerSessionManager>();
            let mut last_stage: Option<String> = None;
            let result = manager.run_local_repaint(worker_request, |event| {
                let stage_changed = event.stage != last_stage;
                if stage_changed || event.event != "progress" {
                    log_worker_event("local_repaint", &event);
                }
                last_stage = event.stage.clone();
                let _ = on_event.send(event);
            });
            log_worker_result("local_repaint", &result);
            let result = result?;

            if !result.ok {
                return Ok(worker::LocalRepaintResponse {
                    ok: false,
                    edited_png: None,
                    error: result.error,
                    error_kind: result.error_kind,
                    model: result.model,
                    cache_hit: result.cache_hit,
                    model_load_ms: result.model_load_ms,
                    inference_ms: result.inference_ms,
                });
            }

            if !output.is_file() {
                return Err("Local Repaint worker completed without producing edited.png.".to_string());
            }
            let edited_png = std::fs::read(&output)
                .map_err(|error| format!("Could not read Local Repaint output PNG: {error}"))?;

            Ok(worker::LocalRepaintResponse {
                ok: true,
                edited_png: Some(edited_png),
                error: None,
                error_kind: None,
                model: result.model,
                cache_hit: result.cache_hit,
                model_load_ms: result.model_load_ms,
                inference_ms: result.inference_ms,
            })
        })();

        let _ = std::fs::remove_dir_all(&temp);
        operation
    })
    .await
    .map_err(|error| format!("Local Repaint task failed: {error}"))?
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn cancel_local_repaint(app: tauri::AppHandle) -> Result<(), String> {
    let result = app
        .state::<worker_session::WorkerSessionManager>()
        .cancel_local_repaint();
    let level = if result.is_ok() { "info" } else { "error" };
    let details = result.as_ref().err().map(String::as_str);
    let _ = diagnostics::append_diagnostic_log(level, "tauri", "cancel_local_repaint", details);
    result
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn restart_hunyuan_worker(app: tauri::AppHandle) -> Result<(), String> {
    let result = app
        .state::<worker_session::WorkerSessionManager>()
        .restart();
    let level = if result.is_ok() { "info" } else { "error" };
    let details = result.as_ref().err().map(String::as_str);
    let _ = diagnostics::append_diagnostic_log(level, "tauri", "restart_hunyuan_worker", details);
    result
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn clear_hunyuan_worker_cache(app: tauri::AppHandle) -> Result<(), String> {
    let result = app
        .state::<worker_session::WorkerSessionManager>()
        .clear_cache();
    let level = if result.is_ok() { "info" } else { "error" };
    let details = result.as_ref().err().map(String::as_str);
    let _ = diagnostics::append_diagnostic_log(level, "tauri", "clear_hunyuan_worker_cache", details);
    result
}

#[cfg(feature = "desktop")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let details = panic_info.to_string();
        let _ = diagnostics::append_diagnostic_log("error", "rust", "Rust panic", Some(&details));
        previous_hook(panic_info);
    }));
    let _ = diagnostics::append_diagnostic_log("info", "tauri", "Img2Model AMD process started.", None);

    tauri::Builder::default()
        .manage(worker_session::WorkerSessionManager::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_system_diagnostics,
            diagnostic_log_path,
            append_diagnostic_log,
            save_uv_template,
            save_textured_glb,
            hunyuan_health,
            hunyuan_texture_health,
            preload_hunyuan_shape,
            generate_shape,
            texture_mesh,
            cleanup_mesh,
            local_repaint,
            cancel_local_repaint,
            restart_hunyuan_worker,
            clear_hunyuan_worker_cache
        ])
        .run(tauri::generate_context!())
        .expect("error while running Img2Model AMD");
}
