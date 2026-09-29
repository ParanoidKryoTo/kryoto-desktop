//! On Linux, the Wine and Proton builds already on this computer, so a game
//! can be played without anyone typing a path.
//!
//! Looked for where Steam, Proton-GE and umu put them, newest Proton first:
//! Proton runs these games best, umu-run is Proton outside Steam, and plain
//! Wine is the last resort. Windows has none of this and gets an empty list.
//!
//! Like Steam, the client can also get them itself: `compat_install` puts the
//! newest Proton-GE and umu-launcher in the app's own `compat` folder, so a
//! Linux player never has to install Wine or Proton by hand. Those come first,
//! and a Proton then runs through umu, inside the Steam Linux Runtime.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompatTool {
    /// What to call it: the folder name for a Proton, else the program.
    pub name: String,
    pub path: String,
    /// `proton`, `umu` or `wine`.
    pub kind: String,
    /// Put there by Kryoto Desktop, so Settings > Compatibility can remove it.
    #[serde(default)]
    pub managed: bool,
}

/// Where the client keeps the Proton and umu it downloaded.
pub fn managed_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("compat"))
}

#[cfg(unix)]
pub fn on_path(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(program)).find(|p| p.is_file())
}

#[cfg(not(unix))]
pub fn on_path(_program: &str) -> Option<PathBuf> {
    None
}

/// umu-run: the client's own, else one on PATH. Never on Windows.
pub fn umu_run(managed: Option<&Path>) -> Option<PathBuf> {
    if cfg!(windows) {
        return None;
    }
    managed
        .map(|m| m.join("umu").join("umu-run"))
        .filter(|p| p.is_file())
        .or_else(|| on_path("umu-run"))
}

/// Every `<dir>/*/proton` under the folders Steam and Proton-GE use.
#[cfg_attr(not(unix), allow(dead_code))]
fn protons_in(dirs: &[PathBuf]) -> Vec<CompatTool> {
    let mut out = Vec::new();
    for dir in dirs {
        let Ok(read) = std::fs::read_dir(dir) else { continue };
        for entry in read.flatten() {
            let script = entry.path().join("proton");
            if script.is_file() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let path = script.to_string_lossy().into_owned();
                if !out.iter().any(|t: &CompatTool| t.path == path) {
                    out.push(CompatTool { name, path, kind: "proton".into(), managed: false });
                }
            }
        }
    }
    // Newest first: "GE-Proton10-3" before "GE-Proton9-27", "Proton 9.0" before "Proton 8.0".
    out.sort_by_key(|t| std::cmp::Reverse(natural_key(&t.name)));
    out
}

/// A sort key that compares the numbers in a name as numbers.
#[cfg_attr(not(unix), allow(dead_code))]
fn natural_key(s: &str) -> Vec<(u8, u64, String)> {
    let mut out = Vec::new();
    let mut num = String::new();
    let mut text = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() {
            if !text.is_empty() {
                out.push((0, 0, std::mem::take(&mut text).to_lowercase()));
            }
            num.push(c);
        } else {
            if !num.is_empty() {
                out.push((1, num.parse().unwrap_or(0), String::new()));
                num.clear();
            }
            text.push(c);
        }
    }
    if !num.is_empty() {
        out.push((1, num.parse().unwrap_or(0), String::new()));
    }
    if !text.is_empty() {
        out.push((0, 0, text.to_lowercase()));
    }
    out
}

#[cfg_attr(not(unix), allow(dead_code))]
fn proton_dirs(home: &Path) -> Vec<PathBuf> {
    let steams = [
        home.join(".steam/steam"),
        home.join(".steam/root"),
        home.join(".local/share/Steam"),
        home.join(".var/app/com.valvesoftware.Steam/data/Steam"),
    ];
    let mut dirs: Vec<PathBuf> = steams
        .iter()
        .flat_map(|s| [s.join("compatibilitytools.d"), s.join("steamapps/common")])
        .collect();
    dirs.push(PathBuf::from("/usr/share/steam/compatibilitytools.d"));
    dirs
}

#[cfg(unix)]
pub fn detect_in(managed: Option<&Path>) -> Vec<CompatTool> {
    let mut out = Vec::new();
    if let Some(m) = managed {
        out.extend(protons_in(&[m.to_path_buf()]).into_iter().map(|t| CompatTool { managed: true, ..t }));
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for t in protons_in(&proton_dirs(&home)) {
            if !out.iter().any(|o| o.path == t.path) {
                out.push(t);
            }
        }
    }
    if let Some(p) = umu_run(managed) {
        let own = managed.is_some_and(|m| p.starts_with(m));
        out.push(CompatTool { name: "umu-run".into(), path: p.to_string_lossy().into_owned(), kind: "umu".into(), managed: own });
    }
    for program in ["wine", "wine64"] {
        if let Some(p) = on_path(program) {
            out.push(CompatTool { name: program.into(), path: p.to_string_lossy().into_owned(), kind: "wine".into(), managed: false });
            break;
        }
    }
    out
}

#[cfg(not(unix))]
pub fn detect_in(_managed: Option<&Path>) -> Vec<CompatTool> {
    Vec::new()
}

/// Every tool, the client's own first.
pub fn detect<R: Runtime>(app: &AppHandle<R>) -> Vec<CompatTool> {
    detect_in(managed_dir(app).as_deref())
}

/// What a tool is, from its path: Proton's `proton` script, `umu-run`, or Wine.
pub fn kind_of(tool: &Path) -> &'static str {
    match tool.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()) {
        Some(n) if n == "proton" => "proton",
        Some(n) if n == "umu-run" => "umu",
        _ => "wine",
    }
}

#[tauri::command(async)]
pub fn compat_tools(app: AppHandle) -> Vec<CompatTool> {
    detect(&app)
}

/// What Settings > Compatibility shows.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatStatus {
    tools: Vec<CompatTool>,
    /// umu-run, which runs a Proton inside the Steam Linux Runtime.
    umu: Option<String>,
    mangohud: bool,
    gamemode: bool,
}

#[tauri::command(async)]
pub fn compat_status(app: AppHandle) -> CompatStatus {
    let managed = managed_dir(&app);
    CompatStatus {
        tools: detect_in(managed.as_deref()),
        umu: umu_run(managed.as_deref()).map(|p| p.to_string_lossy().into_owned()),
        mangohud: on_path("mangohud").is_some(),
        gamemode: on_path("gamemoderun").is_some(),
    }
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

#[derive(Clone, Serialize)]
struct Progress {
    step: String,
    fraction: Option<f64>,
}

fn progress<R: Runtime>(app: &AppHandle<R>, step: &str, fraction: Option<f64>) {
    use tauri::Emitter;
    let _ = app.emit("compat-progress", Progress { step: step.into(), fraction });
}

async fn latest(client: &reqwest::Client, repo: &str) -> Result<Release, String> {
    client
        .get(format!("https://api.github.com/repos/{repo}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Could not reach GitHub: {e}"))?
        .json()
        .await
        .map_err(|e| format!("GitHub answered oddly: {e}"))
}

/// Stream a file to `to`, saying how far along it is.
async fn fetch<R: Runtime>(app: &AppHandle<R>, client: &reqwest::Client, url: &str, to: &Path, step: &str) -> Result<(), String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    let res = client
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("{step} failed: {e}"))?;
    let total = res.content_length();
    let mut file = tokio::fs::File::create(to).await.map_err(|e| e.to_string())?;
    let mut got = 0u64;
    let mut last = std::time::Instant::now();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("{step} failed: {e}"))?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        if last.elapsed().as_millis() > 200 {
            last = std::time::Instant::now();
            progress(app, step, total.map(|t| got as f64 / t.max(1) as f64));
        }
    }
    file.flush().await.map_err(|e| e.to_string())
}

/// Unpack with the system's tar, which every Linux has.
async fn untar(archive: &Path, into: &Path) -> Result<(), String> {
    let (archive, into) = (archive.to_path_buf(), into.to_path_buf());
    tauri::async_runtime::spawn_blocking(move || {
        let out = std::process::Command::new("tar")
            .arg("-xf")
            .arg(&archive)
            .arg("-C")
            .arg(&into)
            .output()
            .map_err(|e| format!("Could not run tar: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!("Could not unpack {}: {}", archive.display(), String::from_utf8_lossy(&out.stderr).trim()))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn sha512_of(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha512};
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha512::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?;
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Get the newest Proton-GE and umu-launcher into the app's `compat` folder,
/// the way Steam gets Proton for you. Returns the Proton, ready to pick.
#[tauri::command]
pub async fn compat_install(app: AppHandle) -> Result<CompatTool, String> {
    if cfg!(windows) {
        return Err("Windows runs these games itself.".into());
    }
    let dir = managed_dir(&app).ok_or("No app data folder.")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .user_agent(concat!("KryotoDesktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;

    progress(&app, "Looking for the newest Proton-GE", None);
    let rel = latest(&client, "GloriousEggroll/proton-ge-custom").await?;
    let proton = dir.join(&rel.tag_name).join("proton");
    if !proton.is_file() {
        let tar = rel
            .assets
            .iter()
            .find(|a| a.name.ends_with(".tar.gz"))
            .ok_or("That Proton-GE release has no download.")?;
        let archive = dir.join(format!(".{}", tar.name));
        fetch(&app, &client, &tar.browser_download_url, &archive, &format!("Downloading {}", rel.tag_name)).await?;
        if let Some(sum) = rel.assets.iter().find(|a| a.name.ends_with(".sha512sum")) {
            progress(&app, "Checking the download", None);
            let want = client
                .get(&sum.browser_download_url)
                .send()
                .await
                .and_then(|r| r.error_for_status())
                .map_err(|e| e.to_string())?
                .text()
                .await
                .map_err(|e| e.to_string())?;
            let want = want.split_whitespace().next().unwrap_or_default().to_ascii_lowercase();
            let file = archive.clone();
            let got = tauri::async_runtime::spawn_blocking(move || sha512_of(&file))
                .await
                .map_err(|e| e.to_string())??;
            if want != got {
                let _ = std::fs::remove_file(&archive);
                return Err("The Proton download was damaged. Try again.".into());
            }
        }
        progress(&app, &format!("Unpacking {}", rel.tag_name), None);
        let unpacked = untar(&archive, &dir).await;
        let _ = std::fs::remove_file(&archive);
        unpacked?;
        if !proton.is_file() {
            return Err(format!("{} unpacked without its proton script.", rel.tag_name));
        }
        crate::logging::info("compat", &format!("installed {}", rel.tag_name));
    }

    if !dir.join("umu").join("umu-run").is_file() {
        progress(&app, "Looking for the Steam runtime launcher (umu)", None);
        let umu = latest(&client, "Open-Wine-Components/umu-launcher").await?;
        let tar = umu
            .assets
            .iter()
            .find(|a| a.name.ends_with("zipapp.tar"))
            .ok_or("That umu release has no download.")?;
        let archive = dir.join(format!(".{}", tar.name));
        fetch(&app, &client, &tar.browser_download_url, &archive, &format!("Downloading umu {}", umu.tag_name)).await?;
        let unpacked = untar(&archive, &dir).await;
        let _ = std::fs::remove_file(&archive);
        unpacked?;
        if !dir.join("umu").join("umu-run").is_file() {
            return Err("umu unpacked without umu-run.".into());
        }
        crate::logging::info("compat", &format!("installed umu {}", umu.tag_name));
    }

    progress(&app, "Ready", Some(1.0));
    Ok(CompatTool {
        name: rel.tag_name,
        path: proton.to_string_lossy().into_owned(),
        kind: "proton".into(),
        managed: true,
    })
}

/// Remove a Proton (or umu) the client downloaded. Nothing outside its own
/// `compat` folder can be removed this way.
#[tauri::command]
pub async fn compat_remove(app: AppHandle, path: String) -> Result<(), String> {
    let dir = managed_dir(&app).ok_or("No app data folder.")?;
    let root = std::fs::canonicalize(&dir).map_err(|_| "Nothing to remove.".to_string())?;
    let tool = std::fs::canonicalize(&path).map_err(|_| "That tool is already gone.".to_string())?;
    let folder = tool.parent().ok_or("Not one of Kryoto's tools.")?.to_path_buf();
    if folder.parent() != Some(root.as_path()) {
        return Err("Only tools Kryoto downloaded can be removed here.".into());
    }
    crate::logging::info("compat", &format!("removing {}", folder.display()));
    tauri::async_runtime::spawn_blocking(move || std::fs::remove_dir_all(folder))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Could not remove it: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_protons_come_first() {
        let root = std::env::temp_dir().join("kryoto-compat-test");
        for name in ["GE-Proton9-27", "GE-Proton10-3", "Proton 8.0", "not-a-proton"] {
            let d = root.join(name);
            std::fs::create_dir_all(&d).unwrap();
            if name != "not-a-proton" {
                std::fs::write(d.join("proton"), "#!/bin/sh\n").unwrap();
            }
        }
        let found: Vec<String> = protons_in(std::slice::from_ref(&root)).into_iter().map(|t| t.name).collect();
        assert_eq!(found, ["Proton 8.0", "GE-Proton10-3", "GE-Proton9-27"]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn tools_are_known_by_their_file() {
        assert_eq!(kind_of(Path::new("/opt/GE-Proton10-3/proton")), "proton");
        assert_eq!(kind_of(Path::new("/usr/bin/umu-run")), "umu");
        assert_eq!(kind_of(Path::new("/usr/bin/wine")), "wine");
    }
}
