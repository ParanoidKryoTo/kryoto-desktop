//! Client settings: where games go, what happens to archives, what opens first.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Where downloaded games are installed, one folder each.
    pub library_dir: String,
    /// Delete the archive once a game is installed from it.
    pub delete_archives: bool,
    /// `store` or `library`.
    pub start_page: String,
    /// Wine or Proton for games that have not picked their own (not Windows).
    pub default_compat_tool: Option<String>,
    /// Minimize the client while a game runs.
    pub minimize_on_play: bool,
    /// Show a notification when a download finishes.
    pub notify_downloads: bool,
    /// kryo.to's palette: `monochrome`, `oled`, `amber`, `emerald`, `nord`, `sepia`, `blossom`.
    pub palette: String,
    /// kryo.to's corner setting: `sharp`, `soft`, `rounded`, `round`, `pill`.
    pub radius: String,
    /// `teletext` (the house face) or `mono`.
    pub font: String,
    /// Show adult games' art unblurred. Off by default, as on kryo.to.
    pub show_adult: bool,
    /// Take palette, corners, typeface and the adult blur from the signed-in
    /// kryo.to account instead of the four settings above.
    pub follow_account: bool,
    /// More library folders besides `library_dir` (which is where new games
    /// go). Settings > Storage adds and removes them.
    pub library_folders: Vec<String>,
    /// Send errors and crashes to kryo.to so they get fixed.
    pub send_reports: bool,
    /// The close button hides the window to the tray instead of quitting.
    pub close_to_tray: bool,
    /// Start (to the tray) when you sign in to Windows.
    pub start_with_system: bool,
    /// Buttons press in under the pointer, as on kryo.to.
    pub press_effect: bool,
    /// Add play time to the account on kryo.to (community statistics).
    pub share_playtime: bool,
    /// Parallel connections per download (1 = one stream).
    pub connections: u32,
    /// Download speed cap in MB/s; 0 is no cap.
    pub speed_limit_mb: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            library_dir: String::new(),
            delete_archives: true,
            start_page: "library".into(),
            default_compat_tool: None,
            minimize_on_play: false,
            notify_downloads: true,
            palette: "monochrome".into(),
            radius: "pill".into(),
            font: "teletext".into(),
            show_adult: false,
            follow_account: true,
            library_folders: Vec::new(),
            send_reports: true,
            close_to_tray: true,
            start_with_system: false,
            press_effect: true,
            share_playtime: true,
            connections: 8,
            speed_limit_mb: 0,
        }
    }
}

fn file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

/// Every library folder, the default (where new games go) first.
pub fn all_folders(s: &Settings) -> Vec<String> {
    let mut out = vec![s.library_dir.clone()];
    for f in &s.library_folders {
        if !out.iter().any(|o| same_path(o, f)) {
            out.push(f.clone());
        }
    }
    out
}

pub fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        let p = p.trim().trim_end_matches(['\\', '/']).replace('\\', "/");
        if cfg!(windows) { p.to_lowercase() } else { p }
    };
    norm(a) == norm(b)
}

pub fn write<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let target = file(app)?;
    let tmp = target.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, target).map_err(|e| e.to_string())
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> Settings {
    let mut s: Settings = file(app)
        .ok()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    if s.library_dir.trim().is_empty() {
        let home = app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."));
        s.library_dir = home.join("Kryoto Games").to_string_lossy().into_owned();
    }
    s
}

#[tauri::command]
pub fn settings_get(app: AppHandle) -> Settings {
    load(&app)
}

#[tauri::command]
pub fn settings_save(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    if settings.library_dir.trim().is_empty() {
        return Err("Pick a folder for the library.".into());
    }
    std::fs::create_dir_all(&settings.library_dir)
        .map_err(|e| format!("Cannot use {}: {e}", settings.library_dir))?;
    let before = load(&app);
    write(&app, &settings)?;
    if before.start_with_system != settings.start_with_system {
        if let Err(e) = crate::system::set_autostart(settings.start_with_system) {
            crate::logging::error("settings", &format!("start with Windows: {e}"));
            return Err(format!("Saved, but starting with Windows could not be turned {}: {e}", if settings.start_with_system { "on" } else { "off" }));
        }
    }
    Ok(settings)
}
