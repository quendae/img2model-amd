pub mod diagnostics;
pub mod worker;

#[cfg(feature = "desktop")]
use tauri::ipc::Channel;

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
    request: worker::GenerateRequest,
    on_event: Channel<worker::WorkerProgressEvent>,
) -> Result<worker::GenerateResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        worker::generate_shape_with_progress(request, |event| {
            let _ = on_event.send(event);
        })
    })
    .await
    .map_err(|error| format!("Generation task failed: {error}"))?
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn texture_mesh(
    request: worker::TextureRequest,
    on_event: Channel<worker::WorkerProgressEvent>,
) -> Result<worker::GenerateResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        worker::texture_mesh_with_progress(request, |event| {
            let _ = on_event.send(event);
        })
    })
    .await
    .map_err(|error| format!("Texture task failed: {error}"))?
}

#[cfg(feature = "desktop")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_system_diagnostics,
            hunyuan_health,
            hunyuan_texture_health,
            generate_shape,
            texture_mesh
        ])
        .run(tauri::generate_context!())
        .expect("error while running Img2Model AMD");
}
