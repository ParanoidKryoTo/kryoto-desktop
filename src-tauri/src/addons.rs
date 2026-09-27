//! Add-ons: a game's extra files from kryo.to - a language pack, the Online
//! add-on - put into the installed game, and taken out again.
//!
//! An add-on is downloaded like any release (from the game page's download
//! window). When the finished file turns out to be one of the game's add-ons
//! (`downloads::match_file`), it is unpacked into the game's own folder
//! instead of a new one, and every file it wrote is recorded. Undo deletes
//! exactly those files. Files an add-on replaced are not brought back: that is
//! what the game's own download is for.

use crate::downloads::{self, Status};
use crate::library::{self, LibraryGame};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InstalledAddon {
    /// Its name on kryo.to, e.g. "Japanese language pack".
    pub label: String,
    /// The archive it came from.
    pub file: String,
    /// Every file it wrote, relative to the game's folder.
    pub files: Vec<String>,
    pub installed_at: u64,
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Move `from` into `to`, overwriting, and note each file (relative to `root`).
fn move_recording(from: &Path, to: &Path, root: &Path, files: &mut Vec<String>) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            move_recording(&entry.path(), &target, root, files)?;
        } else {
            if target.exists() {
                std::fs::remove_file(&target)?;
            }
            std::fs::rename(entry.path(), &target)?;
            if let Ok(rel) = target.strip_prefix(root) {
                files.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    Ok(())
}

/// The game's own folder: the top folder in its library folder, or where it is.
fn game_root<R: Runtime>(app: &AppHandle<R>, game: &LibraryGame) -> PathBuf {
    let folders = crate::settings::all_folders(&crate::settings::load(app));
    crate::storage::game_folder(&folders, &game.install_dir).unwrap_or_else(|| PathBuf::from(&game.install_dir))
}

/// Unpack a downloaded add-on into its game (called by the download runner).
pub async fn install<R: Runtime>(app: &AppHandle<R>, id: &str, settings: &crate::settings::Settings) -> Result<(), String> {
    let item = downloads::snapshot(app, id).ok_or("The download is gone.")?;
    let label = item.addon.clone().unwrap_or_else(|| "Add-on".into());
    let game = item
        .slug
        .as_ref()
        .and_then(|slug| library::load(app).ok()?.into_iter().find(|g| g.slug.as_deref() == Some(slug.as_str())))
        .ok_or_else(|| format!("{label} is an add-on. Install {} first, then download it again.", item.meta.title))?;
    downloads::set_status_pub(app, id, Status::Extracting, None);

    let root = game_root(app, &game);
    let staging = root.with_file_name(format!(".{}.addon", downloads::safe_name(&game.title)));
    let archive = PathBuf::from(&item.archive_path);
    let (root_c, staging_c) = (root.clone(), staging.clone());
    let game_name = root.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let progress_app = app.clone();
    let pid = id.to_string();
    let files = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>, String> {
        let _ = std::fs::remove_dir_all(&staging_c);
        downloads::extract(&archive, &staging_c, &|done, total| downloads::extract_progress(&progress_app, &pid, done, total))?;
        // Only unwrap a single top folder when it is the game's own folder
        // name; an add-on made of one folder ("Binaries") keeps it.
        let top = downloads::single_child_dir(&staging_c)
            .filter(|d| d.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase() == game_name))
            .unwrap_or_else(|| staging_c.clone());
        let mut files = Vec::new();
        move_recording(&top, &root_c, &root_c, &mut files).map_err(|e| format!("Applying the add-on failed: {e}"))?;
        let _ = std::fs::remove_dir_all(&staging_c);
        Ok(files)
    })
    .await
    .map_err(|e| e.to_string())??;

    let file = item.file_name.clone();
    let count = files.len();
    library::update(app, |games| {
        if let Some(g) = games.iter_mut().find(|g| g.id == game.id) {
            g.addons.retain(|a| a.file != file);
            g.addons.push(InstalledAddon { label: label.clone(), file: file.clone(), files, installed_at: now() });
        }
        Ok(())
    })?;
    if settings.delete_archives {
        let _ = std::fs::remove_file(&item.archive_path);
    }
    downloads::finish_as(app, id, &game);
    crate::logging::info("addons", &format!("{label} applied to {} ({count} files)", game.title));
    let _ = app.emit("library-changed", ());
    let _ = app.emit(
        "notify",
        downloads::Notice::new(&format!("{label} applied"), &format!("Added to {}.", game.title), Some(game.id.clone())),
    );
    Ok(())
}

/// Take an add-on out again: delete every file it wrote, then any folders it
/// left empty. Deletes; nothing is restored.
#[tauri::command]
pub fn addon_undo(app: AppHandle, game_id: String, file: String) -> Result<LibraryGame, String> {
    let game = library::load(&app)?.into_iter().find(|g| g.id == game_id).ok_or("That game is no longer in the library.")?;
    let addon = game.addons.iter().find(|a| a.file == file).cloned().ok_or("That add-on is not applied.")?;
    let root = game_root(&app, &game);
    let mut dirs: Vec<PathBuf> = Vec::new();
    for rel in &addon.files {
        let path = crate::launch::inside(&root, rel)?;
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Could not delete {rel}: {e}")),
        }
        let mut parent = path.parent().map(Path::to_path_buf);
        while let Some(p) = parent {
            if p == root || !p.starts_with(&root) {
                break;
            }
            dirs.push(p.clone());
            parent = p.parent().map(Path::to_path_buf);
        }
    }
    // Deepest first; remove_dir only succeeds on an empty folder.
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    dirs.dedup();
    for d in dirs {
        let _ = std::fs::remove_dir(d);
    }
    crate::logging::info("addons", &format!("{} removed from {}", addon.label, game.title));
    let updated = library::update(&app, |games| {
        let g = games.iter_mut().find(|g| g.id == game_id).ok_or("That game is no longer in the library.")?;
        g.addons.retain(|a| a.file != file);
        Ok(g.clone())
    })?;
    let _ = app.emit("library-changed", ());
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applying_records_every_file_and_undo_deletes_them() {
        let base = std::env::temp_dir().join("kryoto-addon-test");
        let _ = std::fs::remove_dir_all(&base);
        let game = base.join("Game");
        let addon = base.join("addon");
        std::fs::create_dir_all(game.join("bin")).unwrap();
        std::fs::write(game.join("bin/steam_api64.dll"), "original").unwrap();
        std::fs::write(game.join("save.dat"), "save").unwrap();
        std::fs::create_dir_all(addon.join("bin")).unwrap();
        std::fs::create_dir_all(addon.join("lang/ja")).unwrap();
        std::fs::write(addon.join("bin/steam_api64.dll"), "online").unwrap();
        std::fs::write(addon.join("lang/ja/text.pak"), "ja").unwrap();

        let mut files = Vec::new();
        move_recording(&addon, &game, &game, &mut files).unwrap();
        files.sort();
        assert_eq!(files, ["bin/steam_api64.dll", "lang/ja/text.pak"]);
        assert_eq!(std::fs::read_to_string(game.join("bin/steam_api64.dll")).unwrap(), "online");

        // What undo does, on the recorded list.
        for rel in &files {
            std::fs::remove_file(crate::launch::inside(&game, rel).unwrap()).unwrap();
        }
        let _ = std::fs::remove_dir(game.join("lang/ja"));
        let _ = std::fs::remove_dir(game.join("lang"));
        assert!(!game.join("lang").exists());
        assert!(!game.join("bin/steam_api64.dll").exists());
        assert!(game.join("save.dat").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
