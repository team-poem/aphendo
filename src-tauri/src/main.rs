#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_updater::UpdaterExt;

/// One frozen frame per overlay window label (u32 LE width, height, then RGBA). `busy` spans
/// hide → grab → overlays, so a second hotkey press meanwhile is ignored.
#[derive(Default)]
struct Snip {
    busy: AtomicBool,
    frames: Mutex<HashMap<String, Vec<u8>>>,
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
    let result = open_overlays(&app).await;
    if result.is_err() {
        finish_snip(app.clone(), app.state::<Snip>());
    }
    result
}

/// Freezes every monitor and covers each with its own overlay. A selection stays within one monitor:
/// macOS won't draw one window across screens of different scale.
async fn open_overlays(app: &AppHandle) -> Result<(), String> {
    let monitors = app.available_monitors().map_err(err)?;
    let focus = monitor_under_cursor(app)?;
    let mac = cfg!(target_os = "macos");
    // xcap takes physical pixels on Windows and CoreGraphics points on macOS.
    let centers: Vec<(i32, i32)> = monitors
        .iter()
        .map(|m| {
            let (pos, size, k) = (m.position(), m.size(), if mac { m.scale_factor() } else { 1.0 });
            (((pos.x as f64 + size.width as f64 / 2.0) / k) as i32, ((pos.y as f64 + size.height as f64 / 2.0) / k) as i32)
        })
        .collect();

    if let Some(main) = app.get_webview_window("main") {
        main.hide().map_err(err)?;
    }
    let frames = tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(120));
        centers
            .into_iter()
            .map(|(cx, cy)| {
                let image = xcap::Monitor::from_point(cx, cy).and_then(|m| m.capture_image()).map_err(err)?;
                // Raw RGBA behind a width/height header: the frame never leaves the machine, so encoding is wasted time.
                let mut raw = Vec::with_capacity(8 + image.as_raw().len());
                raw.extend_from_slice(&image.width().to_le_bytes());
                raw.extend_from_slice(&image.height().to_le_bytes());
                raw.extend_from_slice(image.as_raw());
                Ok(raw)
            })
            .collect::<Result<Vec<_>, String>>()
    })
    .await
    .map_err(err)??;

    let mut focused = None;
    for (i, (monitor, frame)) in monitors.iter().zip(frames).enumerate() {
        let label = format!("overlay-{i}");
        app.state::<Snip>().frames.lock().unwrap().insert(label.clone(), frame);
        let overlay = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("overlay.html".into()))
            .title("화면 캡처")
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            // Otherwise macOS spends the first click on another monitor's overlay just activating it.
            .accept_first_mouse(true)
            .visible(false)
            .build()
            .map_err(err)?;
        let (pos, size) = (*monitor.position(), *monitor.size());
        // macOS converts physical coords with the window's *current* screen scale, which breaks on mixed-DPI
        // setups (the overlay landed on the Retina screen at 2x). Points are global there; Windows uses pixels.
        if mac {
            let k = monitor.scale_factor();
            overlay.set_position(LogicalPosition::new(pos.x as f64 / k, pos.y as f64 / k)).map_err(err)?;
            overlay.set_size(LogicalSize::new(size.width as f64 / k, size.height as f64 / k)).map_err(err)?;
        } else {
            overlay.set_position(PhysicalPosition::new(pos.x, pos.y)).map_err(err)?;
            overlay.set_size(PhysicalSize::new(size.width, size.height)).map_err(err)?;
        }
        overlay.show().map_err(err)?;
        // Covers the macOS menu bar without a new Space; elsewhere it is plain fullscreen on this monitor.
        overlay.set_simple_fullscreen(true).map_err(err)?;
        if monitor.position() == focus.position() {
            focused = Some(overlay);
        }
    }
    match focused {
        Some(w) => w.set_focus().map_err(err),
        None => Ok(()),
    }
}

/// `Monitor::position/size` are in each monitor's own pixels, so on macOS mixed-DPI setups they only
/// line up after dividing by that monitor's scale (points). The cursor there comes back in points ×
/// the primary screen's scale, which is why `monitor_from_point` picks the wrong screen.
fn monitor_under_cursor(app: &AppHandle) -> Result<tauri::Monitor, String> {
    let primary = app.primary_monitor().map_err(err)?.ok_or("모니터를 찾을 수 없음")?;
    let cursor = app.cursor_position().map_err(err)?;
    let mac = cfg!(target_os = "macos");
    let k0 = if mac { primary.scale_factor() } else { 1.0 };
    let (cx, cy) = (cursor.x / k0, cursor.y / k0);
    let hit = app.available_monitors().map_err(err)?.into_iter().find(|m| {
        let k = if mac { m.scale_factor() } else { 1.0 };
        let (x, y) = (m.position().x as f64 / k, m.position().y as f64 / k);
        let (w, h) = (m.size().width as f64 / k, m.size().height as f64 / k);
        cx >= x && cx < x + w && cy >= y && cy < y + h
    });
    Ok(hit.unwrap_or(primary))
}

#[tauri::command]
fn frozen_image(window: tauri::WebviewWindow, snip: State<Snip>) -> Result<tauri::ipc::Response, String> {
    snip.frames.lock().unwrap().get(window.label()).cloned().map(tauri::ipc::Response::new).ok_or_else(|| "캡처된 화면 없음".into())
}

/// Idempotent: closes every overlay, drops the frames, re-shows the widget.
#[tauri::command]
fn finish_snip(app: AppHandle, snip: State<Snip>) {
    snip.frames.lock().unwrap().clear();
    for (label, w) in app.webview_windows() {
        if label.starts_with("overlay-") {
            let _ = w.destroy();
        }
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
    }
    snip.busy.store(false, Ordering::SeqCst);
}

/// The newer version on the release feed, if any.
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<String>, String> {
    let update = app.updater().map_err(err)?.check().await.map_err(err)?;
    Ok(update.map(|u| u.version))
}

/// Downloads, verifies the signature, installs, restarts. On Windows the installer closes the app itself.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let Some(update) = app.updater().map_err(err)?.check().await.map_err(err)? else {
        return Err("이미 최신 버전입니다".into());
    };
    update.download_and_install(|_, _| {}, || {}).await.map_err(err)?;
    app.restart();
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![start_snip, frozen_image, finish_snip, check_update, install_update])
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
