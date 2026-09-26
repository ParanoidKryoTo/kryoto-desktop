//! The client's life on the desktop: one copy running at a time, the tray icon,
//! closing to the tray, starting with the computer, and the pop-up window that
//! menus open in.

use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    webview::WebviewBuilder, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl, WindowEvent,
};

/* ── One copy at a time ───────────────────────────────────── */

/// Debug builds use their own port, so a development copy runs beside an
/// installed one instead of handing over to it.
const INSTANCE_PORT: u16 = if cfg!(debug_assertions) { 47_632 } else { 47_631 };
const HELLO: &str = "kryoto-desktop show";
const ANSWER: &str = "kryoto-desktop ok";

/// Take the instance port, or - when a Kryoto is already running - ask it to
/// come to the front and say so. Anything else on the port that does not
/// answer like a Kryoto is ignored, and this copy runs without the guard.
pub enum Instance {
    First(TcpListener),
    AlreadyRunning,
    Unguarded,
}

pub fn claim_instance() -> Instance {
    match TcpListener::bind(("127.0.0.1", INSTANCE_PORT)) {
        Ok(l) => Instance::First(l),
        Err(_) => {
            let Ok(mut s) = TcpStream::connect_timeout(&([127, 0, 0, 1], INSTANCE_PORT).into(), Duration::from_millis(600))
            else {
                return Instance::Unguarded;
            };
            let _ = s.set_read_timeout(Some(Duration::from_millis(1200)));
            if writeln!(s, "{HELLO}").is_err() {
                return Instance::Unguarded;
            }
            let mut line = String::new();
            let _ = BufReader::new(&s).read_line(&mut line);
            if line.trim() == ANSWER { Instance::AlreadyRunning } else { Instance::Unguarded }
        }
    }
}

/// Answer later copies: bring the window back.
pub fn serve_instance<R: Runtime>(app: AppHandle<R>, listener: TcpListener) {
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
            let mut line = String::new();
            let mut reader = BufReader::new(&stream);
            if reader.read_line(&mut line).is_ok() && line.trim() == HELLO {
                let mut w = &stream;
                let _ = writeln!(w, "{ANSWER}");
                show_main(&app);
            }
        }
    });
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/* ── Tray, and closing to it ──────────────────────────────── */

/// Set once the shell is past sign-in. Before that, closing the window quits:
/// hiding a sign-in screen in the tray would only look like it failed to close.
pub static SHELL_READY: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn shell_ready(ready: bool) {
    SHELL_READY.store(ready, Ordering::SeqCst);
}

#[tauri::command]
pub fn app_exit(app: AppHandle) {
    crate::logging::info("app", "exit");
    app.exit(0);
}

pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let store = MenuItem::with_id(app, "tray-store", "Store", true, None::<&str>)?;
    let library = MenuItem::with_id(app, "tray-library", "Library", true, None::<&str>)?;
    let downloads = MenuItem::with_id(app, "tray-downloads", "Downloads", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "tray-settings", "Settings", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "tray-exit", "Exit Kryoto", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&store, &library, &downloads, &settings, &sep, &quit])?;
    let mut builder = TrayIconBuilder::with_id("kryoto")
        .tooltip("Kryoto Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "tray-exit" {
                app.exit(0);
                return;
            }
            show_main(app);
            let _ = app.emit_to("main", "tray-go", id.trim_start_matches("tray-"));
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// The main window's close button: to the tray once signed in (Steam's
/// default), unless Settings says quit.
pub fn on_main_window_event<R: Runtime>(window: &tauri::Window<R>, event: &WindowEvent) {
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            let app = window.app_handle();
            if SHELL_READY.load(Ordering::SeqCst) && crate::settings::load(app).close_to_tray {
                api.prevent_close();
                hide_popup(app);
                let _ = window.hide();
            } else {
                app.exit(0);
            }
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => hide_popup(window.app_handle()),
        WindowEvent::Focused(false) => {}
        _ => {}
    }
}

/* ── Starting with the computer ───────────────────────────── */

#[cfg(windows)]
pub fn set_autostart(on: bool) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::{RegDeleteKeyValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let key = wide(r"Software\Microsoft\Windows\CurrentVersion\Run");
    let name = wide(if cfg!(debug_assertions) { "Kryoto Desktop Dev" } else { "Kryoto Desktop" });
    if on {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let value = wide(&format!("\"{}\" --tray", exe.display()));
        // SAFETY: NUL-terminated UTF-16 strings; the size is the value's bytes.
        let rc = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                REG_SZ,
                value.as_ptr().cast(),
                (value.len() * 2) as u32,
            )
        };
        if rc != 0 {
            return Err(format!("Windows refused (error {rc})"));
        }
    } else {
        // SAFETY: NUL-terminated UTF-16 strings.
        let rc = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr()) };
        // 2 = it was not there, which is the state we wanted.
        if rc != 0 && rc != 2 {
            return Err(format!("Windows refused (error {rc})"));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn set_autostart(on: bool) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|_| "No home folder.".to_string())?;
    let dir = std::path::Path::new(&home).join(".config/autostart");
    let file = dir.join("kryoto-desktop.desktop");
    if on {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(
            &file,
            format!("[Desktop Entry]\nType=Application\nName=Kryoto Desktop\nExec=\"{}\" --tray\nX-GNOME-Autostart-enabled=true\n", exe.display()),
        )
        .map_err(|e| e.to_string())
    } else {
        match std::fs::remove_file(file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}

/* ── The pop-up menu window ───────────────────────────────── */

// The Store is a native web view laid over the shell, so nothing the shell
// draws can appear on top of it. Menus that open over it (the title bar's, the
// nav tabs', the bell's) are drawn in a small borderless window of their own
// instead, owned by the main window so it always sits above it. The shell
// sends what to draw; the pop-up draws it, says how big it came out, and
// reports what was picked. The Store keeps working the whole time.

/// The pop-up's window, and the web view inside it that draws the menu. The
/// main window holds more than one web view, so windows are looked up with
/// `get_window` - `get_webview_window` only finds single-view windows.
const POPUP_WINDOW: &str = "popup-host";
const POPUP: &str = "popup";

#[derive(Default)]
pub struct Popup {
    payload: Mutex<Option<serde_json::Value>>,
    /// Where the shell asked for it, in screen logical pixels, and which edge
    /// of the anchor it hangs from (a menu near the right edge grows left).
    anchor: Mutex<(f64, f64, bool)>,
}

#[derive(Clone, Serialize)]
struct PopupClosed {
    menu: Option<String>,
}

fn menu_id(payload: &Option<serde_json::Value>) -> Option<String> {
    payload.as_ref().and_then(|p| p["menu"].as_str()).map(String::from)
}

pub fn hide_popup<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_window(POPUP_WINDOW) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            let menu = app.state::<Popup>().payload.lock().ok().and_then(|p| menu_id(&p));
            let _ = app.emit_to("main", "popup-closed", PopupClosed { menu });
        }
    }
}

/// Open a menu at `x`,`y` in the main window (logical pixels from its top-left
/// corner). `right` hangs it from that point's left instead (right-aligned).
#[tauri::command]
pub async fn popup_open(app: AppHandle, x: f64, y: f64, right: bool, payload: serde_json::Value) -> Result<(), String> {
    let main = app.get_window("main").ok_or("The main window is gone.")?;
    let scale = main.scale_factor().map_err(|e| e.to_string())?;
    let origin = main.inner_position().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
    let (sx, sy) = (origin.x + x, origin.y + y);
    let state = app.state::<Popup>();
    *state.payload.lock().map_err(|_| "popup lock")? = Some(payload.clone());
    *state.anchor.lock().map_err(|_| "popup lock")? = (sx, sy, right);

    if let Some(w) = app.get_window(POPUP_WINDOW) {
        let _ = w.hide();
        let _ = w.set_position(LogicalPosition::new(sx, sy));
        app.emit_to(POPUP, "popup-show", payload).map_err(|e| e.to_string())?;
        return Ok(());
    }
    // First menu of the session: make the window. It asks for its payload
    // when its page has loaded (`popup_payload`), so nothing is lost to an
    // event sent before anything was listening.
    let w = tauri::window::WindowBuilder::new(&app, POPUP_WINDOW)
        .title("Kryoto menu")
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .focused(true)
        .inner_size(220.0, 120.0)
        .position(sx, sy)
        .parent(&main)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    w.add_child(
        WebviewBuilder::new(POPUP, WebviewUrl::default()).transparent(true).auto_resize(),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(220.0, 120.0),
    )
    .map_err(|e| e.to_string())?;
    let app2 = app.clone();
    w.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            hide_popup(&app2);
        }
    });
    Ok(())
}

#[tauri::command]
pub fn popup_payload(popup: tauri::State<'_, Popup>) -> Option<serde_json::Value> {
    popup.payload.lock().ok().and_then(|p| p.clone())
}

/// The pop-up has drawn itself at this size: place it (kept on the monitor)
/// and show it.
#[tauri::command]
pub fn popup_ready(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let w = app.get_window(POPUP_WINDOW).ok_or("no popup")?;
    let (mut x, mut y, right) = *app.state::<Popup>().anchor.lock().map_err(|_| "popup lock")?;
    if right {
        x -= width;
    }
    if let Ok(Some(m)) = w.current_monitor().or_else(|_| w.primary_monitor()) {
        let scale = m.scale_factor();
        let pos = m.position().to_logical::<f64>(scale);
        let size = m.size().to_logical::<f64>(scale);
        x = x.min(pos.x + size.width - width - 4.0).max(pos.x + 4.0);
        if y + height > pos.y + size.height - 4.0 {
            y = (pos.y + size.height - height - 4.0).max(pos.y + 4.0);
        }
    }
    w.set_size(LogicalSize::new(width.max(40.0), height.max(20.0))).map_err(|e| e.to_string())?;
    w.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    w.show().map_err(|e| e.to_string())?;
    let _ = w.set_focus();
    Ok(())
}

/// Something in the menu was picked. The shell runs it.
#[tauri::command]
pub fn popup_select(app: AppHandle, id: String) {
    if let Some(w) = app.get_window(POPUP_WINDOW) {
        let _ = w.hide();
    }
    let _ = app.emit_to("main", "popup-select", id);
    let menu = app.state::<Popup>().payload.lock().ok().and_then(|p| menu_id(&p));
    let _ = app.emit_to("main", "popup-closed", PopupClosed { menu });
}

#[tauri::command]
pub fn popup_close(app: AppHandle) {
    hide_popup(&app);
}

/// The pointer went into (or left) the pop-up, for menus that open on hover.
#[tauri::command]
pub fn popup_hover(app: AppHandle, inside: bool) {
    let _ = app.emit_to("main", "popup-hover", inside);
}
