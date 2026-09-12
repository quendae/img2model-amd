pub mod diagnostics;
pub mod worker;
pub mod worker_session;

#[cfg(feature = "desktop")]
use tauri::{ipc::Channel, Manager};

#[cfg(feature = "desktop")]
#[tauri::command]
fn get_system_diagnostics() -> diagnostics::SystemDiagnostics {
    diagnostics::collect_system_diagnostics()
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn hunyuan_health() -> Result<worker::WorkerHealth, String> {
    worker::worker_health()
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn hunyuan_texture_health() -> Result<worker::TextureHealth, String> {
    worker::worker_texture_health()
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
        let manager = app_handle.state::<worker_session::WorkerSessionManager>();
        manager.run_shape(request, |event| {
            let _ = on_event.send(event);
        })
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
        let manager = app_handle.state::<worker_session::WorkerSessionManager>();
        manager.run_texture(request, |event| {
            let _ = on_event.send(event);
        })
    })
    .await
    .map_err(|error| format!("Texture task failed: {error}"))?
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn restart_hunyuan_worker(app: tauri::AppHandle) -> Result<(), String> {
    app.state::<worker_session::WorkerSessionManager>().restart()
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn clear_hunyuan_worker_cache(app: tauri::AppHandle) -> Result<(), String> {
    app.state::<worker_session::WorkerSessionManager>().clear_cache()
}

#[cfg(feature = "desktop")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(worker_session::WorkerSessionManager::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_system_diagnostics,
            hunyuan_health,
            hunyuan_texture_health,
            generate_shape,
            texture_mesh,
            restart_hunyuan_worker,
            clear_hunyuan_worker_cache
        ])
        .run(tauri::generate_context!())
        .expect("error while running Img2Model AMD");
}
