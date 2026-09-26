//! Storage: Steam's storage manager, for Kryoto's library folders.
//!
//! A library folder is somewhere games get installed, one folder each. The
//! first one in Settings is where new downloads go; more can be added on other
//! drives. For each folder this reports the drive (size, free), what every game
//! in it takes, and it moves a game from one folder to another - a rename on
//! the same drive, a copy-then-delete with progress across drives.

use crate::library::{self, LibraryGame};
use crate::settings::{self, same_path};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Runtime, State};

/// Total and free bytes on the drive holding `path` (or its nearest existing
/// parent, for a folder that is not made yet).
pub fn disk_space(path: &Path) -> Option<(u64, u64)> {
    let mut p = path.to_path_buf();
    while !p.exists() {
        p = p.parent()?.to_path_buf();
    }
    disk_space_of(&p)
}

#[cfg(windows)]
fn disk_space_of(path: &Path) -> Option<(u64, u64)> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let (mut free_to_us, mut total, mut free) = (0u64, 0u64, 0u64);
    // SAFETY: a NUL-terminated path and three out-pointers to live u64s.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free_to_us, &mut total, &mut free) };
    (ok != 0).then_some((total, free_to_us))
}

#[cfg(unix)]
fn disk_space_of(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: a NUL-terminated path and an out-pointer to a zeroed statvfs.
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    let block = s.f_frsize as u64;
    Some((s.f_blocks as u64 * block, s.f_bavail as u64 * block))
}

/// The drive a path is on, as the player knows it: `C:` on Windows, the
/// mount point it lives under elsewhere (`/`, `/home`, `/mnt/games`).
fn drive_of(path: &Path) -> String {
    if let Some(Component::Prefix(p)) = path.components().next() {
        return p.as_os_str().to_string_lossy().trim_end_matches('\\').to_uppercase();
    }
    let full = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mounts = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
    mounts
        .lines()
        .filter_map(|l| l.split_whitespace().nth(1))
        // /proc/mounts writes a space in a path as \040.
        .map(|m| m.replace("\\040", " "))
        .filter(|m| full.starts_with(m))
        .max_by_key(|m| m.len())
        .unwrap_or_else(|| "/".into())
}

/// The game's own folder inside whichever library folder holds it: for
/// `D:\Kryoto Games\Hades\bin\Hades.exe`'s root `D:\Kryoto Games\Hades\bin`,
/// that is `D:\Kryoto Games\Hades`. `None` when the game is not in one of
/// them - it was added from somewhere else, and is not ours to move or delete.
pub fn game_folder(folders: &[String], install_dir: &str) -> Option<PathBuf> {
    let dir = PathBuf::from(install_dir).canonicalize().ok()?;
    for f in folders {
        let Ok(root) = PathBuf::from(f).canonicalize() else { continue };
        if let Ok(rest) = dir.strip_prefix(&root) {
            let first = rest.components().next()?;
            if let Component::Normal(name) = first {
                return Some(root.join(name));
            }
        }
    }
    None
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredGame {
    id: String,
    title: String,
    folder: String,
    bytes: u64,
    last_played: Option<u64>,
    cover: Option<String>,
    nsfw: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolder {
    path: String,
    drive: String,
    is_default: bool,
    exists: bool,
    total: u64,
    free: u64,
    games_bytes: u64,
    games: Vec<StoredGame>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageOverview {
    folders: Vec<LibraryFolder>,
    /// Games added from elsewhere on the PC.
    elsewhere: Vec<StoredGame>,
}

fn stored(g: &LibraryGame, folder: PathBuf) -> StoredGame {
    StoredGame {
        id: g.id.clone(),
        title: g.title.clone(),
        bytes: library::dir_size(&folder),
        folder: folder.to_string_lossy().into_owned(),
        last_played: g.last_played,
        cover: g.cover.clone(),
        nsfw: g.nsfw,
    }
}

fn overview<R: Runtime>(app: &AppHandle<R>) -> Result<StorageOverview, String> {
    let s = settings::load(app);
    let folders = settings::all_folders(&s);
    let games = library::load(app)?;
    let mut out: Vec<LibraryFolder> = folders
        .iter()
        .map(|f| {
            let path = PathBuf::from(f);
            let (total, free) = disk_space(&path).unwrap_or((0, 0));
            LibraryFolder {
                path: f.clone(),
                drive: drive_of(&path),
                is_default: same_path(f, &s.library_dir),
                exists: path.is_dir(),
                total,
                free,
                games_bytes: 0,
                games: Vec::new(),
            }
        })
        .collect();
    let mut elsewhere = Vec::new();
    for g in &games {
        match game_folder(&folders, &g.install_dir) {
            Some(dir) => {
                let at = out
                    .iter()
                    .position(|f| PathBuf::from(&f.path).canonicalize().is_ok_and(|r| dir.starts_with(r)))
                    .unwrap_or(0);
                let item = stored(g, dir);
                out[at].games_bytes += item.bytes;
                out[at].games.push(item);
            }
            None => elsewhere.push(stored(g, PathBuf::from(&g.install_dir))),
        }
    }
    for f in &mut out {
        f.games.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    }
    Ok(StorageOverview { folders: out, elsewhere })
}

#[tauri::command]
pub async fn storage_overview(app: AppHandle) -> Result<StorageOverview, String> {
    tauri::async_runtime::spawn_blocking(move || overview(&app)).await.map_err(|e| e.to_string())?
}

/// Add a library folder. Made if it does not exist yet.
#[tauri::command]
pub fn storage_add_folder(app: AppHandle, path: String) -> Result<(), String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("Pick a folder.".into());
    }
    std::fs::create_dir_all(&path).map_err(|e| format!("Cannot use {path}: {e}"))?;
    let mut s = settings::load(&app);
    if settings::all_folders(&s).iter().any(|f| same_path(f, &path)) {
        return Err("That folder is already a library folder.".into());
    }
    s.library_folders.push(path.clone());
    settings::write(&app, &s)?;
    crate::logging::info("storage", &format!("added library folder {path}"));
    Ok(())
}

/// Stop using a library folder. Refused while games are installed in it, and
/// for the default: those have to be moved or uninstalled first. The folder
/// itself stays on disk.
#[tauri::command]
pub fn storage_remove_folder(app: AppHandle, path: String) -> Result<(), String> {
    let mut s = settings::load(&app);
    if same_path(&path, &s.library_dir) {
        return Err("New games install here. Make another folder the default first.".into());
    }
    let folders = vec![path.clone()];
    let inside = library::load(&app)?.iter().filter(|g| game_folder(&folders, &g.install_dir).is_some()).count();
    if inside > 0 {
        return Err(format!(
            "{inside} game{} installed here. Move {} to another folder or uninstall {} first.",
            if inside == 1 { " is" } else { "s are" },
            if inside == 1 { "it" } else { "them" },
            if inside == 1 { "it" } else { "them" },
        ));
    }
    s.library_folders.retain(|f| !same_path(f, &path));
    settings::write(&app, &s)
}

/// Make a folder the one new games install into.
#[tauri::command]
pub fn storage_set_default(app: AppHandle, path: String) -> Result<(), String> {
    let mut s = settings::load(&app);
    if !settings::all_folders(&s).iter().any(|f| same_path(f, &path)) {
        return Err("That is not one of your library folders.".into());
    }
    let old = std::mem::replace(&mut s.library_dir, path.clone());
    s.library_folders.retain(|f| !same_path(f, &path));
    if !s.library_folders.iter().any(|f| same_path(f, &old)) {
        s.library_folders.insert(0, old);
    }
    settings::write(&app, &s)
}

/// One move at a time; a second waits for the answer "already moving".
#[derive(Default)]
pub struct Moving(AtomicBool);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveProgress {
    id: String,
    copied: u64,
    total: u64,
    done: bool,
    error: Option<String>,
}

fn copy_tree(from: &Path, to: &Path, progress: &mut dyn FnMut(u64)) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        let kind = entry.file_type()?;
        #[cfg(unix)]
        if kind.is_symlink() {
            // Linux games ship links (libraries, launch scripts); keep them links.
            std::os::unix::fs::symlink(std::fs::read_link(entry.path())?, &target)?;
            continue;
        }
        if kind.is_dir() {
            copy_tree(&entry.path(), &target, progress)?;
        } else if kind.is_file() {
            let n = std::fs::copy(entry.path(), &target)?;
            progress(n);
        }
    }
    Ok(())
}

/// Move a game to another library folder. Its launch settings, playtime and
/// everything else in the Library move with it; only the folder changes.
#[tauri::command]
pub async fn storage_move(
    app: AppHandle,
    moving: State<'_, Moving>,
    running: State<'_, library::Running>,
    id: String,
    to: String,
) -> Result<(), String> {
    if running.0.lock().map(|m| m.contains_key(&id)).unwrap_or(false) {
        return Err("Close the game first.".into());
    }
    if moving.0.swap(true, Ordering::SeqCst) {
        return Err("Another game is being moved. Wait for it to finish.".into());
    }
    let result = move_game(&app, &id, &to).await;
    moving.0.store(false, Ordering::SeqCst);
    if let Err(e) = &result {
        crate::logging::error("storage", &format!("moving {id}: {e}"));
        let _ = app.emit("storage-move", MoveProgress { id, copied: 0, total: 0, done: true, error: Some(e.clone()) });
    }
    result
}

async fn move_game<R: Runtime>(app: &AppHandle<R>, id: &str, to: &str) -> Result<(), String> {
    let s = settings::load(app);
    let folders = settings::all_folders(&s);
    if !folders.iter().any(|f| same_path(f, to)) {
        return Err("That is not one of your library folders.".into());
    }
    let game = library::load(app)?.into_iter().find(|g| g.id == id).ok_or("That game is no longer in the library.")?;
    let from = game_folder(&folders, &game.install_dir)
        .ok_or("This game was added from its own folder, so Kryoto does not move it. Move it yourself, then point Properties at the new place.")?;
    let name = from.file_name().ok_or("That game folder has no name.")?.to_owned();
    let target_root = PathBuf::from(to);
    let dest = target_root.join(&name);
    if target_root.canonicalize().ok().as_deref() == from.parent() {
        return Err("It is already in that folder.".into());
    }
    if dest.exists() {
        return Err(format!("{} already exists. Rename or remove it first.", dest.display()));
    }
    let total = library::dir_size(&from);
    if let Some((_, free)) = disk_space(&target_root) {
        if free < total && drive_of(&target_root) != drive_of(&from) {
            return Err(format!(
                "Not enough space: {} needs {}, {} has {} free.",
                game.title,
                human(total),
                drive_of(&target_root),
                human(free)
            ));
        }
    }
    crate::logging::info("storage", &format!("moving {} from {} to {}", game.title, from.display(), dest.display()));

    let progress_app = app.clone();
    let pid = id.to_string();
    let (from_c, dest_c) = (from.clone(), dest.clone());
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(dest_c.parent().unwrap_or(&dest_c)).map_err(|e| e.to_string())?;
        // Same drive: a rename, done at once.
        if std::fs::rename(&from_c, &dest_c).is_ok() {
            return Ok(());
        }
        let mut copied = 0u64;
        let mut last = std::time::Instant::now();
        let copy = copy_tree(&from_c, &dest_c, &mut |n| {
            copied += n;
            if last.elapsed().as_millis() > 200 {
                last = std::time::Instant::now();
                let _ = progress_app.emit(
                    "storage-move",
                    MoveProgress { id: pid.clone(), copied, total, done: false, error: None },
                );
            }
        });
        if let Err(e) = copy {
            // Leave the original exactly as it was.
            let _ = std::fs::remove_dir_all(&dest_c);
            return Err(format!("Copying failed, nothing was moved: {e}"));
        }
        std::fs::remove_dir_all(&from_c).map_err(|e| format!("Copied, but the old folder could not be removed: {e}"))
    })
    .await
    .map_err(|e| e.to_string())??;

    // The install dir may be a folder inside the game's folder; keep that part.
    let rest = PathBuf::from(&game.install_dir)
        .canonicalize()
        .ok()
        .and_then(|d| d.strip_prefix(&from).ok().map(Path::to_path_buf))
        .unwrap_or_default();
    let new_dir = if rest.as_os_str().is_empty() { dest.clone() } else { dest.join(rest) }.to_string_lossy().into_owned();
    library::update(app, |games| {
        if let Some(g) = games.iter_mut().find(|g| g.id == id) {
            g.install_dir = new_dir.clone();
        }
        Ok(())
    })?;
    let _ = app.emit("storage-move", MoveProgress { id: id.to_string(), copied: total, total, done: true, error: None });
    let _ = app.emit("library-changed", ());
    Ok(())
}

fn human(bytes: u64) -> String {
    let gb = bytes as f64 / 1_073_741_824.0;
    if gb >= 1.0 { format!("{gb:.1} GB") } else { format!("{:.0} MB", bytes as f64 / 1_048_576.0) }
}

/// Before a download lands: is there room for the archive and what it unpacks
/// to? `needed` is the caller's estimate. An error names both numbers.
pub fn check_room(folder: &Path, needed: u64, what: &str) -> Result<(), String> {
    let Some((_, free)) = disk_space(folder) else { return Ok(()) };
    if free >= needed {
        return Ok(());
    }
    Err(format!(
        "Not enough space on {} for {what}: it needs about {}, and {} is free. Free some up, or add a library folder on another drive in Settings > Storage.",
        drive_of(folder),
        human(needed),
        human(free),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_game_folder_is_the_first_folder_under_the_library() {
        let root = std::env::temp_dir().join("kryoto-storage-test");
        let deep = root.join("Hades").join("bin");
        std::fs::create_dir_all(&deep).unwrap();
        let folders = vec![root.to_string_lossy().into_owned()];
        let found = game_folder(&folders, &deep.to_string_lossy()).unwrap();
        assert_eq!(found, root.canonicalize().unwrap().join("Hades"));
        // The library folder itself is never a game's folder.
        assert!(game_folder(&folders, &root.to_string_lossy()).is_none());
        assert!(game_folder(&folders, &std::env::temp_dir().to_string_lossy()).is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_drive_has_a_size() {
        let (total, free) = disk_space(&std::env::temp_dir()).unwrap();
        assert!(total > 0 && free <= total);
    }
}
