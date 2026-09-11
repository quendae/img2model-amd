pub mod diagnostics;
pub mod worker;

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
fn generate_shape(request: worker::GenerateRequest) -> Result<worker::GenerateResult, String> {
    worker::generate_shape(request)
}

#[cfg(feature = "desktop")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_system_diagnostics,
            hunyuan_health,
            generate_shape
        ])
        .run(tauri::generate_context!())
        .expect("error while running Img2Model AMD");
}
