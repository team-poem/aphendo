#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::ShortcutState;

/// The frozen monitor frame (PNG) while the overlay is open. `busy` spans hide → grab → overlay,
/// so a second hotkey press during that window is ignored.
#[derive(Default)]
struct Snip {
    busy: AtomicBool,
    frame: Mutex<Option<Vec<u8>>>,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
async fn start_snip(app: AppHandle) -> Result<(), String> {
    let snip = app.state::<Snip>();
    if snip.busy.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let result = open_overlay(&app).await;
    if result.is_err() {
        finish_snip(app.clone(), app.state::<Snip>());
    }
    result
}

async fn open_overlay(app: &AppHandle) -> Result<(), String> {
    // ponytail: only the monitor under the cursor; a snip spanning monitors needs one overlay per monitor.
    let cursor = app.cursor_position().map_err(err)?;
    let monitor = match app.monitor_from_point(cursor.x, cursor.y).map_err(err)? {
        Some(m) => m,
        None => app.primary_monitor().map_err(err)?.ok_or("모니터를 찾을 수 없음")?,
    };
    let (pos, size) = (*monitor.position(), *monitor.size());
    // xcap takes physical pixels on Windows and CoreGraphics points on macOS.
    let unit = if cfg!(target_os = "macos") { monitor.scale_factor() } else { 1.0 };
    let cx = ((pos.x as f64 + size.width as f64 / 2.0) / unit) as i32;
    let cy = ((pos.y as f64 + size.height as f64 / 2.0) / unit) as i32;

    if let Some(main) = app.get_webview_window("main") {
        main.hide().map_err(err)?;
    }
    let png = tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(250));
        let image = xcap::Monitor::from_point(cx, cy).and_then(|m| m.capture_image()).map_err(err)?;
        let mut png = Vec::new();
        image.write_to(&mut std::io::Cursor::new(&mut png), xcap::image::ImageFormat::Png).map_err(err)?;
        #[cfg(debug_assertions)]
        eprintln!("snip: grabbed {}x{} ({} bytes png), monitor {}x{} at {:?}", image.width(), image.height(), png.len(), size.width, size.height, pos);
        Ok::<_, String>(png)
    })
    .await
    .map_err(err)??;
    *app.state::<Snip>().frame.lock().unwrap() = Some(png);

    let overlay = match app.get_webview_window("overlay") {
        Some(w) => w,
        None => WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
            .title("화면 캡처")
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .visible(false)
            .build()
            .map_err(err)?,
    };
    overlay.set_position(PhysicalPosition::new(pos.x, pos.y)).map_err(err)?;
    overlay.set_size(PhysicalSize::new(size.width, size.height)).map_err(err)?;
    overlay.show().map_err(err)?;
    // Covers the macOS menu bar without a new Space; elsewhere it is plain fullscreen on this monitor.
    overlay.set_simple_fullscreen(true).map_err(err)?;
    overlay.set_focus().map_err(err)
}

#[tauri::command]
fn frozen_image(snip: State<Snip>) -> Result<tauri::ipc::Response, String> {
    snip.frame.lock().unwrap().clone().map(tauri::ipc::Response::new).ok_or_else(|| "캡처된 화면 없음".into())
}

/// Idempotent: closes the overlay if open, drops the frame, re-shows the widget.
#[tauri::command]
fn finish_snip(app: AppHandle, snip: State<Snip>) {
    snip.frame.lock().unwrap().take();
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.destroy();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
    }
    snip.busy.store(false, Ordering::SeqCst);
}

fn main() {
    tauri::Builder::default()
        .manage(Snip::default())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["alt+shift+s"])
                .expect("valid shortcut")
                .with_handler(|app, _, event| {
                    if event.state == ShortcutState::Pressed {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = start_snip(app).await {
                                eprintln!("snip failed: {e}");
                            }
                        });
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![start_snip, frozen_image, finish_snip])
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
