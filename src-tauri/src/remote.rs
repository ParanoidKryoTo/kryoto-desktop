//! Kryoto Desktop, run from the website (kryo.to `lib/desktop-remote.ts`).
//!
//! A game queued on kryo.to ("Download in Kryoto Desktop") starts here, and
//! every download's progress shows on kryo.to's Downloads page, from any
//! device. The Store view's page script does the talking, signed in like any
//! browser (BROWSER_STATE_SCRIPT in lib.rs): it takes what kryo.to queued and
//! hands it to `remote_apply`, and sends `remote_snapshot` back while
//! something moves. Only a kryo.to page in the Store may call either.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State, Webview};

use crate::downloads::{self, Downloads};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteItem {
    id: String,
    slug: Option<String>,
    title: String,
    status: String,
    received: u64,
    total: Option<u64>,
    speed: u64,
    extracted: u64,
    extract_total: Option<u64>,
    error: Option<String>,
    queue_order: u64,
    added_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    install_id: String,
    name: String,
    version: String,
    os: String,
    downloads: Vec<RemoteItem>,
}

fn from_store(app: &AppHandle, webview: &Webview) -> Result<(), String> {
    if webview.label() != crate::STORE {
        return Err("Only the Store may ask.".into());
    }
    let page = webview.url().map_err(|e| e.to_string())?;
    if !crate::settings::is_catalog_origin(&page, &crate::settings::load(app)) {
        return Err("Only kryo.to may ask.".into());
    }
    Ok(())
}

/// What the downloads are doing, for kryo.to's Downloads page. Finished ones
/// are left out after a day, so the list is about now.
#[tauri::command]
pub fn remote_snapshot(app: AppHandle, webview: Webview, state: State<'_, Downloads>) -> Result<Snapshot, String> {
    from_store(&app, &webview)?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let downloads = downloads::downloads_list(state)
        .into_iter()
        .filter(|d| d.finished_at.is_none_or(|f| now.saturating_sub(f) < 86_400))
        .take(60)
        .map(|d| RemoteItem {
            title: if d.meta.title.is_empty() { downloads::title_from_file(&d.file_name) } else { d.meta.title.clone() },
            status: serde_json::to_value(d.status).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(),
            id: d.id,
            slug: d.slug,
            received: d.received,
            total: d.total,
            speed: d.speed,
            extracted: d.extracted,
            extract_total: d.extract_total,
            error: d.error,
            queue_order: d.queue_order,
            added_at: d.added_at,
        })
        .collect();
    Ok(Snapshot {
        install_id: crate::logging::install_id(&app),
        name: sysinfo::System::host_name().unwrap_or_else(|| "Kryoto Desktop".into()),
        version: app.package_info().version.to_string(),
        os: format!("{} {}", std::env::consts::OS, sysinfo::System::os_version().unwrap_or_default()).trim().to_string(),
        downloads,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCommand {
    kind: String,
    url: Option<String>,
    slug: Option<String>,
    title: Option<String>,
    download_id: Option<String>,
}

/// Do what kryo.to queued: start a download (from kryo.to's own filehost only),
/// or pause, resume or cancel one. Returns how many were done.
#[tauri::command]
pub fn remote_apply(app: AppHandle, webview: Webview, state: State<'_, Downloads>, commands: Vec<RemoteCommand>) -> Result<usize, String> {
    from_store(&app, &webview)?;
    let settings = crate::settings::load(&app);
    let mut done = 0;
    for c in commands.into_iter().take(20) {
        match c.kind.as_str() {
            "download" => {
                let Some(url) = c.url.as_deref().and_then(|u| url::Url::parse(u).ok()) else { continue };
                if !downloads::is_ours(&url, &settings) {
                    continue;
                }
                let slug = c.slug.filter(|s| !s.is_empty() && s.len() <= 160 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
                let title = c.title.map(|t| t.chars().filter(|ch| !ch.is_control()).take(200).collect::<String>()).filter(|t| !t.is_empty());
                crate::logging::info("remote", &format!("queued from kryo.to: {}", title.as_deref().unwrap_or("a game")));
                downloads::enqueue(&app, url.to_string(), slug, title);
                done += 1;
            }
            "pause" | "resume" | "cancel" => {
                let Some(id) = c.download_id.filter(|i| !i.is_empty() && i.len() <= 80) else { continue };
                match c.kind.as_str() {
                    "pause" => downloads::download_pause(app.clone(), state.clone(), id),
                    "resume" => {
                        let _ = downloads::download_resume(app.clone(), id);
                    }
                    _ => downloads::download_cancel(app.clone(), state.clone(), id),
                }
                done += 1;
            }
            _ => {}
        }
    }
    Ok(done)
}
