#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .setup(|_| {
            // ponytail: a second instance fails to bind and its window talks to the first one's server.
            tauri::async_runtime::spawn(async {
                if let Err(e) = capture_core::serve(capture_core::data_dir(), None).await {
                    eprintln!("core server stopped: {e}");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run tauri app");
}
