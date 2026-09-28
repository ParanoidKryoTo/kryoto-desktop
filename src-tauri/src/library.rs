//! The Library: games on this PC, how each one starts, and how long it ran.
//!
//! Kept in one JSON file in the app's data folder, written whole through a
//! temporary file so a crash mid-save leaves the previous library rather than
//! half of one. Every command reloads it before changing it, so a playtime
//! written by a game that just closed is never overwritten by a stale copy.

use crate::launch::{self, LaunchEntry, LaunchPlan};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibraryGame {
    pub id: String,
    pub title: String,
    /// The kryo.to page this is linked to, if any.
    pub slug: Option<String>,
    pub cover: Option<String>,
    pub hero: Option<String>,
    /// Absolute folder the game lives in.
    pub install_dir: String,
    /// Exe to start when no Steam entry is picked, relative to `install_dir`.
    pub executable: String,
    /// The release's chosen arguments on kryo.to, used with `executable`.
    pub default_args: String,
    /// Steam's launch entries (Windows ones), from kryo.to.
    pub entries: Vec<LaunchEntry>,
    /// Release source label, e.g. "Steam + Kryoto Online".
    pub source: Option<String>,
    /// Which entry Play starts. `None` with several entries means: ask.
    pub preferred_entry: Option<usize>,
    /// The Steam-style LAUNCH OPTIONS line.
    pub launch_options: String,
    /// Wine or Proton, for a non-Windows host.
    pub compat_tool: Option<String>,
    /// Add the release's WINEDLLOVERRIDES automatically under Wine/Proton.
    pub apply_overrides: bool,
    pub playtime_seconds: u64,
    pub last_played: Option<u64>,
    pub added_at: u64,
    /// The kryo.to release version installed, when it came from a download -
    /// what "Update available" compares against.
    pub version: Option<String>,
    /// A few words from kryo.to for the game page.
    pub short: Option<String>,
    pub developer: Option<String>,
    /// kryo.to marks it an adult game: its art is blurred unless Settings
    /// says to show adult art, as on the site.
    pub nsfw: bool,
    /// Add-ons put into it (language packs, the Online add-on), with the files
    /// each wrote, for Undo.
    pub addons: Vec<crate::addons::InstalledAddon>,
    /// Kryoto Online set up on this PC (not from a kryo.to add-on), for Undo.
    pub online: Option<crate::online::LocalOnline>,
}

#[derive(Default)]
pub struct Running(pub Mutex<HashMap<String, u32>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameEvent {
    id: String,
    running: bool,
    /// How long that session lasted, on exit.
    seconds: Option<u64>,
    /// Exit code, when there is one.
    code: Option<i32>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub(crate) fn load<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<LibraryGame>, String> {
    let file = data_dir(app)?.join("library.json");
    match std::fs::read_to_string(&file) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("library.json is damaged: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

fn save<R: Runtime>(app: &AppHandle<R>, games: &[LibraryGame]) -> Result<(), String> {
    let dir = data_dir(app)?;
    let tmp = dir.join("library.json.tmp");
    let json = serde_json::to_string_pretty(games).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join("library.json")).map_err(|e| e.to_string())
}

/// Library writes are serialised: a game closing while Properties saves must
/// not lose either change.
static WRITE: Mutex<()> = Mutex::new(());

pub(crate) fn update<R: Runtime, T>(
    app: &AppHandle<R>,
    f: impl FnOnce(&mut Vec<LibraryGame>) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = WRITE.lock().map_err(|_| "library lock poisoned")?;
    let mut games = load(app)?;
    let out = f(&mut games)?;
    save(app, &games)?;
    Ok(out)
}

fn slugify(title: &str) -> String {
    let s: String = title
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let s = s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    if s.is_empty() { "game".into() } else { s }
}

#[tauri::command]
pub fn library_list(app: AppHandle) -> Result<Vec<LibraryGame>, String> {
    load(&app)
}

/// Add a game from an exe on disk. `game` carries whatever the caller already
/// knows (title, kryo.to link, Steam entries); the folder is worked out here.
#[tauri::command]
pub fn library_add(app: AppHandle, exe_path: String, mut game: LibraryGame) -> Result<LibraryGame, String> {
    let exe = PathBuf::from(&exe_path);
    if !exe.is_file() {
        return Err(format!("{exe_path} is not a file."));
    }
    // A linked release names its exe relative to the game's root, e.g.
    // `bin/win64/Game.exe`. When the picked file ends with that path, the root
    // is the folder above it, so Steam's entries resolve; otherwise the exe's
    // own folder is the root.
    let wanted = game.executable.replace('\\', "/").to_ascii_lowercase();
    let picked = exe.to_string_lossy().replace('\\', "/");
    let (root, rel) = if !wanted.is_empty() && picked.to_ascii_lowercase().ends_with(&format!("/{wanted}")) {
        let cut = picked.len() - wanted.len() - 1;
        (PathBuf::from(&picked[..cut]), game.executable.replace('\\', "/"))
    } else {
        let name = exe.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        (exe.parent().map(Path::to_path_buf).unwrap_or_default(), name)
    };
    game.install_dir = root.to_string_lossy().into_owned();
    game.executable = rel;
    if game.title.trim().is_empty() {
        game.title = exe.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Game".into());
    }
    game.entries.retain(LaunchEntry::is_windows);
    game.apply_overrides = true;
    game.added_at = now();
    update(&app, |games| {
        let base = game.slug.clone().unwrap_or_else(|| slugify(&game.title));
        let mut id = base.clone();
        let mut n = 2;
        while games.iter().any(|g| g.id == id) {
            id = format!("{base}-{n}");
            n += 1;
        }
        game.id = id;
        games.push(game.clone());
        Ok(game)
    })
}

/// Put a game that a download just installed into the library: a new entry,
/// or the existing one for the same kryo.to page with its folder and version
/// moved on (an update), keeping playtime and the player's own settings.
pub fn upsert_installed<R: Runtime>(app: &AppHandle<R>, mut game: LibraryGame) -> Result<LibraryGame, String> {
    game.entries.retain(LaunchEntry::is_windows);
    update(app, |games| {
        if let Some(slug) = game.slug.clone() {
            if let Some(slot) = games.iter_mut().find(|g| g.slug.as_deref() == Some(slug.as_str())) {
                slot.install_dir = game.install_dir.clone();
                slot.executable = game.executable.clone();
                slot.default_args = game.default_args.clone();
                slot.entries = game.entries.clone();
                slot.source = game.source.clone();
                slot.version = game.version.clone();
                slot.cover = game.cover.clone().or(slot.cover.take());
                slot.hero = game.hero.clone().or(slot.hero.take());
                slot.short = game.short.clone().or(slot.short.take());
                slot.developer = game.developer.clone().or(slot.developer.take());
                slot.nsfw = game.nsfw;
                if slot.preferred_entry.is_some_and(|i| i >= slot.entries.len()) {
                    slot.preferred_entry = None;
                }
                return Ok(slot.clone());
            }
        }
        let base = game.slug.clone().unwrap_or_else(|| slugify(&game.title));
        let mut id = base.clone();
        let mut n = 2;
        while games.iter().any(|g| g.id == id) {
            id = format!("{base}-{n}");
            n += 1;
        }
        game.id = id;
        game.apply_overrides = true;
        game.added_at = now();
        games.push(game.clone());
        Ok(game)
    })
}

pub(crate) fn dir_size(path: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        for entry in read.flatten() {
            match entry.file_type() {
                Ok(t) if t.is_dir() => stack.push(entry.path()),
                Ok(t) if t.is_file() => total += entry.metadata().map(|m| m.len()).unwrap_or(0),
                _ => {}
            }
        }
    }
    total
}

/// Bytes the game's folder takes, for Installed Files.
#[tauri::command]
pub async fn game_disk_size(install_dir: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || dir_size(Path::new(&install_dir)))
        .await
        .map_err(|e| e.to_string())
}

/// Save the settings the Properties window edits. Playtime is the app's own
/// record and is kept from disk, never taken from the window.
#[tauri::command]
pub fn library_save(app: AppHandle, game: LibraryGame) -> Result<LibraryGame, String> {
    update(&app, |games| {
        let slot = games.iter_mut().find(|g| g.id == game.id).ok_or("That game is no longer in the library.")?;
        launch::inside(Path::new(&game.install_dir), &game.executable)?;
        let mut next = game;
        next.entries.retain(LaunchEntry::is_windows);
        next.playtime_seconds = slot.playtime_seconds;
        next.last_played = slot.last_played;
        next.added_at = slot.added_at;
        // Only applying and undoing change these, never the Properties window.
        next.addons = slot.addons.clone();
        next.online = slot.online.clone();
        if next.preferred_entry.is_some_and(|i| i >= next.entries.len()) {
            next.preferred_entry = None;
        }
        *slot = next.clone();
        Ok(next)
    })
}

/// Take it off the list, and with `delete_files` uninstall it too.
///
/// Files are only ever deleted from inside one of the library folders in
/// Settings > Storage - folders this client installs into - and then the
/// game's whole folder there goes, not just the one holding the exe. A game
/// added from elsewhere on the PC is the player's folder, not ours, and
/// removing it only unlists it.
#[tauri::command]
pub async fn library_remove(app: AppHandle, id: String, delete_files: bool) -> Result<bool, String> {
    let game = load(&app)?.into_iter().find(|g| g.id == id);
    let mut deleted = false;
    if let (Some(game), true) = (&game, delete_files) {
        let folders = crate::settings::all_folders(&crate::settings::load(&app));
        if let Some(dir) = crate::storage::game_folder(&folders, &game.install_dir) {
            crate::logging::info("library", &format!("uninstalling {} from {}", game.title, dir.display()));
            tauri::async_runtime::spawn_blocking(move || std::fs::remove_dir_all(dir))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| format!("Could not delete the game's files: {e}"))?;
            deleted = true;
        }
    }
    update(&app, |games| {
        games.retain(|g| g.id != id);
        Ok(())
    })?;
    Ok(deleted)
}

fn plan_for<R: Runtime>(app: &AppHandle<R>, game: &LibraryGame, entry: Option<usize>) -> Result<LaunchPlan, String> {
    let entry = match entry {
        Some(i) => Some(game.entries.get(i).ok_or("That launch entry no longer exists.")?),
        None => None,
    };
    let prefix = data_dir(app)?.join("prefixes").join(&game.id);
    // The game's own pick, else the one in Settings, else the best one found
    // on this computer (newest Proton, then umu-run, then Wine).
    let settings = crate::settings::load(app);
    let managed = crate::compat::managed_dir(app);
    let own = game.compat_tool.clone().filter(|t| !t.trim().is_empty());
    let fallback = settings.default_compat_tool.clone().filter(|t| !t.trim().is_empty());
    let detected = if cfg!(windows) || own.is_some() || fallback.is_some() {
        None
    } else {
        crate::compat::detect_in(managed.as_deref()).into_iter().next().map(|t| t.path)
    };
    let umu = crate::compat::umu_run(managed.as_deref());
    // Settings > Compatibility's switches, only when the tool is really there.
    let mut wrappers = Vec::new();
    let mut env = Vec::new();
    if !cfg!(windows) {
        if settings.linux_gamemode {
            wrappers.extend(crate::compat::on_path("gamemoderun").map(|p| p.to_string_lossy().into_owned()));
        }
        if settings.linux_mangohud {
            wrappers.extend(crate::compat::on_path("mangohud").map(|p| p.to_string_lossy().into_owned()));
        }
        if settings.linux_fsr {
            env.push(("WINE_FULLSCREEN_FSR".to_string(), "1".to_string()));
        }
    }
    let tool = own.or(fallback).or(detected);
    let tool = tool.as_deref().map(Path::new);
    launch::plan(&launch::PlanInput {
        install_dir: Path::new(&game.install_dir),
        executable: &game.executable,
        default_args: &game.default_args,
        entry,
        launch_options: &game.launch_options,
        compat_tool: tool,
        prefix_dir: &prefix,
        source: game.source.as_deref(),
        apply_overrides: game.apply_overrides,
        windows_host: cfg!(windows),
        umu: umu.as_deref(),
        wrappers,
        env,
    })
}

/// The exact line Play would run, for the Properties window.
#[tauri::command]
pub fn game_launch_preview(app: AppHandle, game: LibraryGame, entry: Option<usize>) -> Result<String, String> {
    Ok(plan_for(&app, &game, entry)?.display())
}

#[tauri::command]
pub fn game_running(running: State<'_, Running>) -> Vec<String> {
    running.0.lock().map(|m| m.keys().cloned().collect()).unwrap_or_default()
}

/// Start a game. `entry` is the Steam launch entry picked, or `None` for the
/// release default.
#[tauri::command]
pub fn game_launch(app: AppHandle, running: State<'_, Running>, id: String, entry: Option<usize>) -> Result<(), String> {
    if running.0.lock().map(|m| m.contains_key(&id)).unwrap_or(false) {
        return Err("It is already running.".into());
    }
    let game = load(&app)?.into_iter().find(|g| g.id == id).ok_or("That game is no longer in the library.")?;
    let plan = plan_for(&app, &game, entry)?;
    if !plan.exe.is_file() {
        return Err(format!(
            "{} is not there any more. Point Properties at the game's .exe.",
            plan.exe.display()
        ));
    }
    if let Some(prefix) = plan.env.iter().find(|(k, _)| k == "WINEPREFIX" || k == "STEAM_COMPAT_DATA_PATH") {
        let _ = std::fs::create_dir_all(&prefix.1);
    }

    let mut cmd = launch::command(&plan);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group, so Stop takes Wine and everything it started.
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start {}: {e}", plan.program.display()))?;
    let pid = child.id();
    running.0.lock().map_err(|_| "state lock poisoned")?.insert(id.clone(), pid);
    let started = now();
    let _ = update(&app, |games| {
        if let Some(g) = games.iter_mut().find(|g| g.id == id) {
            g.last_played = Some(started);
        }
        Ok(())
    });
    let _ = app.emit("game-state", GameEvent { id: id.clone(), running: true, seconds: None, code: None });
    if crate::settings::load(&app).minimize_on_play {
        if let Some(w) = app.get_window("main") {
            let _ = w.minimize();
        }
    }

    std::thread::spawn(move || {
        let status = child.wait().ok();
        let seconds = now().saturating_sub(started);
        if let Some(state) = app.try_state::<Running>() {
            if let Ok(mut m) = state.0.lock() {
                m.remove(&id);
            }
        }
        let _ = update(&app, |games| {
            if let Some(g) = games.iter_mut().find(|g| g.id == id) {
                g.playtime_seconds += seconds;
            }
            Ok(())
        });
        let _ = app.emit(
            "game-state",
            GameEvent { id, running: false, seconds: Some(seconds), code: status.and_then(|s| s.code()) },
        );
    });
    Ok(())
}

/// Close a running game and everything it started.
#[tauri::command]
pub fn game_stop(running: State<'_, Running>, id: String) -> Result<(), String> {
    let pid = running
        .0
        .lock()
        .map_err(|_| "state lock poisoned")?
        .get(&id)
        .copied()
        .ok_or("It is not running.")?;
    #[cfg(windows)]
    let status = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .status()
    };
    #[cfg(not(windows))]
    let status = std::process::Command::new("kill").args(["-TERM", "--", &format!("-{pid}")]).status();
    status.map_err(|e| e.to_string())?;
    Ok(())
}

/// Show the game's folder in the file manager.
#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("{path} is not a folder."));
    }
    #[cfg(windows)]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";
    std::process::Command::new(program).arg(&dir).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::slugify;

    #[test]
    fn ids_are_readable() {
        assert_eq!(slugify("Captain Hardcore"), "captain-hardcore");
        assert_eq!(slugify("  ?? "), "game");
    }
}
