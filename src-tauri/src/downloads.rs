//! Downloads: from a kryo.to Download button to a game in the Library.
//!
//! The store page asks kryo.to for a signed link and navigates to it, which
//! the Store web view reports as a download. That download is cancelled there
//! and taken over here, so it gets what a browser download cannot: a queue,
//! pause and resume, speed, and - when it lands - extraction into the library
//! folder and a Library entry that already knows how the game starts.
//!
//! Links are signed for an hour and bound to this network, and dl.kryo.to
//! honours `Range` on the same link past its hour (a resume grace), so pausing
//! and resuming is a ranged GET against the URL the page handed over.
//!
//! One download at a time, like Steam: a second one queues.

use crate::launch::LaunchEntry;
use crate::library::{self, LibraryGame};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Queued,
    Downloading,
    Paused,
    /// Checking the archive against the SHA-256 kryo.to lists for it.
    Verifying,
    Extracting,
    Installed,
    Failed,
    Canceled,
}

/// What kryo.to says about the release, fetched when the download starts so
/// the install can finish offline and the list can show art straight away.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CatalogMeta {
    pub title: String,
    pub cover: Option<String>,
    pub hero: Option<String>,
    pub executable: String,
    pub default_args: String,
    pub entries: Vec<LaunchEntry>,
    pub source: Option<String>,
    pub version: Option<String>,
    pub short: Option<String>,
    pub developer: Option<String>,
    pub size_bytes: Option<u64>,
    pub nsfw: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Download {
    pub id: String,
    pub slug: Option<String>,
    pub url: String,
    pub file_name: String,
    pub archive_path: String,
    pub total: Option<u64>,
    pub received: u64,
    /// Bytes a second, averaged over the last couple of seconds.
    pub speed: u64,
    /// Extraction progress, in uncompressed bytes.
    pub extracted: u64,
    pub extract_total: Option<u64>,
    pub status: Status,
    pub error: Option<String>,
    pub install_dir: Option<String>,
    pub game_id: Option<String>,
    pub added_at: u64,
    pub finished_at: Option<u64>,
    pub meta: CatalogMeta,
    /// The byte ranges being fetched in parallel, and how far each has got.
    pub segments: Vec<Segment>,
    /// The archive's expected SHA-256, when kryo.to lists one.
    pub sha256: Option<String>,
    /// The archive matched it.
    pub verified: bool,
    /// Set when the file is one of the game's add-ons (a language pack, the
    /// Online add-on): its name, e.g. "Japanese language pack".
    pub addon: Option<String>,
}

/// One byte range of a download, on a connection of its own.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Segment {
    pub start: u64,
    /// Inclusive.
    pub end: u64,
    pub done: u64,
}

impl Segment {
    fn len(&self) -> u64 {
        self.end - self.start + 1
    }
}

/// Split `total` bytes into up to `n` ranges of at least 16 MB each.
pub fn split(total: u64, n: u32) -> Vec<Segment> {
    if total == 0 {
        return Vec::new();
    }
    let min = 16 * 1024 * 1024;
    let n = u64::from(n.max(1)).min((total / min).max(1));
    let size = total.div_ceil(n);
    (0..n)
        .map(|i| Segment { start: i * size, end: ((i + 1) * size).min(total) - 1, done: 0 })
        .filter(|s| s.start < total)
        .collect()
}

/// A shared speed cap: every connection draws from the same budget.
pub struct Limiter {
    bytes_per_sec: u64,
    start: Instant,
    sent: AtomicU64,
}

impl Limiter {
    pub fn new(mb_per_sec: u32) -> Self {
        Self { bytes_per_sec: u64::from(mb_per_sec) * 1024 * 1024, start: Instant::now(), sent: AtomicU64::new(0) }
    }

    async fn take(&self, n: u64) {
        if self.bytes_per_sec == 0 {
            return;
        }
        let sent = self.sent.fetch_add(n, Ordering::SeqCst) + n;
        let due = std::time::Duration::from_secs_f64(sent as f64 / self.bytes_per_sec as f64);
        let elapsed = self.start.elapsed();
        if due > elapsed {
            tokio::time::sleep(due - elapsed).await;
        }
    }
}

const RUN: u8 = 0;
const PAUSE: u8 = 1;
const CANCEL: u8 = 2;

pub struct Downloads {
    list: Mutex<Vec<Download>>,
    controls: Mutex<HashMap<String, Arc<AtomicU8>>>,
    /// One transfer at a time.
    slot: tokio::sync::Semaphore,
    last_emit: Mutex<Option<Instant>>,
}

impl Downloads {
    pub fn new() -> Self {
        Self {
            list: Mutex::new(Vec::new()),
            controls: Mutex::new(HashMap::new()),
            slot: tokio::sync::Semaphore::new(1),
            last_emit: Mutex::new(None),
        }
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn state_file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("downloads.json"))
}

fn persist<R: Runtime>(app: &AppHandle<R>) {
    let Some(file) = state_file(app) else { return };
    let list = app.state::<Downloads>().list.lock().map(|l| l.clone()).unwrap_or_default();
    if let Ok(json) = serde_json::to_string_pretty(&list) {
        let tmp = file.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(tmp, file);
        }
    }
}

fn emit<R: Runtime>(app: &AppHandle<R>, force: bool) {
    let state = app.state::<Downloads>();
    if !force {
        if let Ok(mut last) = state.last_emit.lock() {
            if last.is_some_and(|t| t.elapsed().as_millis() < 250) {
                return;
            }
            *last = Some(Instant::now());
        }
    }
    let list = state.list.lock().map(|l| l.clone()).unwrap_or_default();
    let _ = app.emit("downloads", list);
}

fn edit<R: Runtime>(app: &AppHandle<R>, id: &str, f: impl FnOnce(&mut Download)) -> Option<Download> {
    let state = app.state::<Downloads>();
    let mut list = state.list.lock().ok()?;
    let item = list.iter_mut().find(|d| d.id == id)?;
    f(item);
    Some(item.clone())
}

/// The download as it stands (for the add-on installer).
pub fn snapshot<R: Runtime>(app: &AppHandle<R>, id: &str) -> Option<Download> {
    edit(app, id, |_| {})
}

pub fn set_status_pub<R: Runtime>(app: &AppHandle<R>, id: &str, status: Status, error: Option<String>) {
    set_status(app, id, status, error)
}

pub fn extract_progress<R: Runtime>(app: &AppHandle<R>, id: &str, done: u64, total: Option<u64>) {
    edit(app, id, |d| {
        d.extracted = done;
        d.extract_total = total;
    });
    emit(app, false);
}

/// Mark a download installed, pointing at the game it went into.
pub fn finish_as<R: Runtime>(app: &AppHandle<R>, id: &str, game: &LibraryGame) {
    edit(app, id, |d| {
        d.install_dir = Some(game.install_dir.clone());
        d.game_id = Some(game.id.clone());
    });
    set_status(app, id, Status::Installed, None);
}

fn set_status<R: Runtime>(app: &AppHandle<R>, id: &str, status: Status, error: Option<String>) {
    edit(app, id, |d| {
        d.status = status;
        d.error = error;
        d.speed = 0;
        if matches!(status, Status::Installed | Status::Failed | Status::Canceled) {
            d.finished_at = Some(now());
        }
    });
    persist(app);
    emit(app, true);
}

/// Load what was left from last time. Anything that was moving is paused -
/// the player resumes it, rather than the client silently using the network.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let Some(file) = state_file(app) else { return };
    let mut list: Vec<Download> = std::fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    for d in &mut list {
        if matches!(d.status, Status::Queued | Status::Downloading | Status::Verifying | Status::Extracting) {
            d.status = Status::Paused;
            d.speed = 0;
        }
    }
    if let Ok(mut l) = app.state::<Downloads>().list.lock() {
        *l = list;
    }
}

/// Whether a download from the Store should be taken over: only kryo.to's own
/// files. A mirror elsewhere downloads the way a browser would.
pub fn is_ours(url: &url::Url, settings: &crate::settings::Settings) -> bool {
    let host = url.host_str().unwrap_or("");
    if url.scheme() == "https" && (host == "kryo.to" || host.ends_with(".kryo.to")) {
        return true;
    }
    if crate::settings::is_catalog_origin(url, settings) {
        return true;
    }
    // Debug builds only: a local file server standing in for dl.kryo.to, so the
    // whole download-to-play path can be exercised without a real release.
    // Compiled out of release builds entirely.
    #[cfg(debug_assertions)]
    if let Ok(dev) = std::env::var("KRYOTO_DEV_DOWNLOAD_HOST") {
        let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
        return !dev.is_empty() && format!("{host}{port}") == dev;
    }
    false
}

/// The placeholder a download is called until something better is known.
const UNNAMED: &str = "Download";

/// Whether `title` is only a stand-in: empty, the placeholder, or the slug.
fn is_placeholder(title: &str, slug: Option<&str>) -> bool {
    let t = title.trim();
    t.is_empty() || t.eq_ignore_ascii_case(UNNAMED) || slug.is_some_and(|s| s.eq_ignore_ascii_case(t))
}

/// The name dl.kryo.to will save a link under, read from the link itself.
///
/// A `/d/<token>` link carries its file name in the token: the part before the
/// dot is base64url JSON (`{"k":…,"exp":…,"n":"Hades II - Kryoto.7z"}`). It is
/// signed, not secret, so it can be read for a label the moment the download
/// is handed over, before a byte has arrived. Only ever used as a name.
pub fn file_name_in_link(url: &str) -> Option<String> {
    let url: url::Url = url.parse().ok()?;
    let mut parts = url.path_segments()?;
    if parts.next()? != "d" {
        return None;
    }
    let body = parts.next()?.split('.').next()?;
    let json: serde_json::Value = serde_json::from_slice(&base64url(body)?).ok()?;
    json["n"].as_str().map(str::trim).filter(|n| !n.is_empty() && n.len() <= 255).map(String::from)
}

/// Decode unpadded base64url. `None` for anything that is not.
fn base64url(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return None,
        } as u32)
    };
    let text = text.trim_end_matches('=');
    if text.len() > 8192 {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.bytes() {
        acc = (acc << 6) | value(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Queue a download the Store handed over. `slug` is the game page it came from.
pub fn enqueue<R: Runtime>(app: &AppHandle<R>, url: String, slug: Option<String>, title: Option<String>) {
    let state = app.state::<Downloads>();
    // The same page's Download pressed twice while the first is still going.
    if let Ok(list) = state.list.lock() {
        if list.iter().any(|d| {
            d.slug.is_some()
                && d.slug == slug
                && matches!(d.status, Status::Queued | Status::Downloading | Status::Verifying | Status::Extracting)
        }) {
            let _ = app.emit("notify", Notice::new("Already downloading", "That game is already in Downloads.", None));
            return;
        }
    }
    let id = format!("dl-{}", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    // The page's title first; then the name the link itself carries, so a
    // download that arrives with nothing else is still called after its game
    // from the first frame rather than "Download".
    let named = title
        .filter(|t| !is_placeholder(t, slug.as_deref()))
        .or_else(|| file_name_in_link(&url).and_then(|n| title_in_file_name(&n)));
    let item = Download {
        id: id.clone(),
        meta: CatalogMeta {
            title: named.or_else(|| slug.clone()).unwrap_or_else(|| UNNAMED.into()),
            ..Default::default()
        },
        slug,
        url,
        added_at: now(),
        ..Default::default()
    };
    if let Ok(mut list) = state.list.lock() {
        list.insert(0, item);
    }
    persist(app);
    emit(app, true);
    let _ = app.emit("download-started", id.clone());
    start(app.clone(), id);
}

fn start<R: Runtime>(app: AppHandle<R>, id: String) {
    let flag = Arc::new(AtomicU8::new(RUN));
    if let Ok(mut c) = app.state::<Downloads>().controls.lock() {
        c.insert(id.clone(), flag.clone());
    }
    tauri::async_runtime::spawn(async move {
        let result = run(&app, &id, &flag).await;
        if let Ok(mut c) = app.state::<Downloads>().controls.lock() {
            c.remove(&id);
        }
        match result {
            Ok(()) => {}
            Err(e) => {
                crate::logging::error("download", &format!("{id}: {e}"));
                set_status(&app, &id, Status::Failed, Some(e))
            }
        }
    });
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    title: String,
    body: String,
    game_id: Option<String>,
}

impl Notice {
    pub fn new(title: &str, body: &str, game_id: Option<String>) -> Self {
        Self { title: title.into(), body: body.into(), game_id }
    }
}

/// The kryo.to game whose title is exactly `name` (letters and digits
/// compared, case aside), from the site's search. Only an exact match: a
/// download filed under the wrong game would install as it.
async fn find_slug(client: &reqwest::Client, endpoint: &str, name: &str) -> Option<String> {
    let squash = |s: &str| s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
    let wanted = squash(name);
    if wanted.is_empty() {
        return None;
    }
    let q: String = url::form_urlencoded::byte_serialize(name.as_bytes()).collect();
    let res = client.get(format!("{endpoint}/api/games/search?q={q}&limit=8")).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let json: serde_json::Value = res.json().await.ok()?;
    json["results"]
        .as_array()?
        .iter()
        .find(|g| g["title"].as_str().is_some_and(|t| squash(t) == wanted))
        .and_then(|g| g["slug"].as_str())
        .filter(|s| !s.is_empty() && s.len() <= 160 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .map(str::to_ascii_lowercase)
}

async fn fetch_meta(client: &reqwest::Client, endpoint: &str, slug: &str) -> Option<CatalogMeta> {
    let res = client.get(format!("{endpoint}/api/games/{slug}")).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let json: serde_json::Value = res.json().await.ok()?;
    Some(meta_from_json(&json["game"]))
}

pub fn meta_from_json(g: &serde_json::Value) -> CatalogMeta {
    let s = |k: &str| g[k].as_str().map(str::trim).filter(|v| !v.is_empty()).map(String::from);
    // A Steam branch listed as its own game carries a suffix ("2027330x");
    // Steam's art is under the number alone.
    let appid = s("steam_appid").map(|a| a.chars().take_while(char::is_ascii_digit).collect::<String>()).filter(|a| !a.is_empty());
    let entries: Vec<LaunchEntry> = serde_json::from_value(g["game_launch_options"]["available"].clone())
        .unwrap_or_default();
    CatalogMeta {
        title: s("title").unwrap_or_default(),
        cover: s("cover_vertical").or_else(|| s("cover")),
        hero: s("hero_image_override").or_else(|| {
            appid.map(|a| format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{a}/library_hero.jpg"))
        }),
        executable: s("game_executable_path").unwrap_or_default(),
        default_args: s("game_executable_args").unwrap_or_default(),
        entries: entries.into_iter().filter(LaunchEntry::is_windows).collect(),
        source: s("source"),
        version: s("version"),
        short: s("short"),
        developer: s("developer"),
        nsfw: g["nsfw"].as_bool().unwrap_or(false),
        size_bytes: g["download_size_bytes"].as_u64(),
    }
}

/// `attachment; filename*=UTF-8''Captain%20Hardcore%20-%20Kryoto.7z`, or the
/// plain `filename="..."` form.
pub fn filename_from_disposition(value: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    if let Some(at) = lower.find("filename*=") {
        let raw = value[at + 10..].split(';').next()?.trim();
        let encoded = raw.rsplit("''").next()?.trim_matches('"');
        let decoded: String = url::form_urlencoded::parse(format!("x={}", encoded.replace('+', "%2B")).as_bytes())
            .next()
            .map(|(_, v)| v.into_owned())?;
        return Some(decoded);
    }
    if let Some(at) = lower.find("filename=") {
        let raw = value[at + 9..].split(';').next()?.trim().trim_matches('"');
        if !raw.is_empty() {
            return Some(raw.to_string());
        }
    }
    None
}

/// A game's name from its archive's: `Captain Hardcore - Kryoto.7z` is
/// "Captain Hardcore" - the extension and the `- Kryoto` signature every
/// release file carries come off.
/// A download that started with no game to name it after (no page, no
/// catalog answer yet) reads "Download" in the list and its notices. Once the
/// file's own name is known, that is a better name than none.
fn name_from_file(d: &mut Download) {
    if is_placeholder(&d.meta.title, d.slug.as_deref()) {
        if let Some(title) = title_in_file_name(&d.file_name) {
            d.meta.title = title;
        }
    }
}

pub fn title_from_file(name: &str) -> String {
    title_in_file_name(name).unwrap_or_else(|| "Game".into())
}

/// The game's name in a release file's name, or `None` when the name says
/// nothing: a server that sent no file name leaves the last piece of the
/// address - `download`, `file`, a signed token - and none of those is a game.
pub fn title_in_file_name(name: &str) -> Option<String> {
    let name = name.trim();
    // Only a short, known archive extension is an extension: a token's dot
    // splits it into two long runs, and "Portal 2.5" is not "Portal 2".
    let stem = match name.rsplit_once('.') {
        Some((stem, ext)) if (1..=4).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric()) => stem,
        _ => name,
    }
    .trim();
    let lower = stem.to_ascii_lowercase();
    let stem = if lower.ends_with("- kryoto") { stem[..stem.len() - "- kryoto".len()].trim() } else { stem };
    const GENERIC: [&str; 9] = ["download", "downloads", "file", "files", "game", "archive", "release", "d", "attachment"];
    if stem.is_empty() || GENERIC.iter().any(|g| stem.eq_ignore_ascii_case(g)) {
        return None;
    }
    // A token or a hash: one long word of letters, digits, `-`, `_` and dots.
    let tokenish = stem.len() >= 24 && stem.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if tokenish {
        return None;
    }
    Some(stem.to_string())
}

/// A name that is safe as a single path component on every OS.
pub fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { ' ' } else { c })
        .collect();
    // Words that are only dots are `.`/`..` in disguise.
    let cleaned = cleaned
        .split_whitespace()
        .filter(|w| !w.chars().all(|c| c == '.'))
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned = cleaned.trim_matches('.').trim().to_string();
    if cleaned.is_empty() { "Game".into() } else { cleaned.chars().take(120).collect() }
}

async fn run<R: Runtime>(app: &AppHandle<R>, id: &str, flag: &AtomicU8) -> Result<(), String> {
    let downloads = app.state::<Downloads>();
    let settings = crate::settings::load(app);
    let client = reqwest::Client::builder()
        .user_agent(concat!("KryotoDesktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;

    // Named before waiting for a free slot, so a queued download reads as its
    // game rather than as its slug until the ones ahead of it finish.
    let mut item = edit(app, id, |_| {}).ok_or("The download is gone.")?;
    let endpoint = crate::settings::catalog_endpoint(&settings);
    // Nothing said which game this is (no page, no context the page could
    // pass on): look it up on kryo.to by the name the file downloads as, so
    // it still installs with its art, its exe and its place in the library.
    if item.slug.is_none() {
        let name = file_name_in_link(&item.url)
            .and_then(|n| title_in_file_name(&n))
            .or_else(|| (!is_placeholder(&item.meta.title, None)).then(|| item.meta.title.clone()));
        if let Some(name) = name {
            if let Some(slug) = find_slug(&client, &endpoint, &name).await {
                item = edit(app, id, |d| d.slug = Some(slug)).ok_or("The download is gone.")?;
                emit(app, true);
            }
        }
    }
    if item.meta.executable.is_empty() && item.meta.version.is_none() {
        if let Some(slug) = &item.slug {
            if let Some(meta) = fetch_meta(&client, &endpoint, slug).await {
                edit(app, id, |d| {
                    d.total = d.total.or(meta.size_bytes);
                    let named = std::mem::take(&mut d.meta.title);
                    d.meta = meta;
                    if d.meta.title.trim().is_empty() {
                        d.meta.title = named;
                    }
                });
                emit(app, true);
            }
        }
    }

    let _permit = downloads.slot.acquire().await.map_err(|e| e.to_string())?;
    if flag.load(Ordering::SeqCst) != RUN {
        return settle_stopped(app, id, flag);
    }
    // Settings as they are now, not as they were when it was queued.
    let settings = crate::settings::load(app);

    let already_complete = {
        let d = edit(app, id, |_| {}).ok_or("The download is gone.")?;
        !d.archive_path.is_empty() && d.total.is_some_and(|t| t > 0 && d.received >= t)
    };
    if !already_complete {
        set_status(app, id, Status::Downloading, None);
        let limiter = Arc::new(Limiter::new(settings.speed_limit_mb));
        let mut attempt = 0;
        loop {
            let step = if settings.connections > 1 {
                transfer_parallel(app, id, flag, &client, &settings.library_dir, settings.connections, &limiter).await
            } else {
                transfer(app, id, flag, &client, &settings.library_dir).await
            };
            match step {
                Ok(true) => break,
                Ok(false) => return settle_stopped(app, id, flag),
                Err(Transfer::Fatal(e)) => return Err(e),
                Err(Transfer::Retry(e)) => {
                    attempt += 1;
                    if attempt > 4 {
                        return Err(format!("The connection kept dropping ({e}). Resume to try again."));
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(2 * attempt)).await;
                    if flag.load(Ordering::SeqCst) != RUN {
                        return settle_stopped(app, id, flag);
                    }
                }
            }
        }
    }
    identify(app, id, &client).await;
    verify(app, id).await?;
    if edit(app, id, |_| {}).and_then(|d| d.addon).is_some() {
        return crate::addons::install(app, id, &settings).await;
    }
    install(app, id, &settings).await
}

/// What kryo.to says about this exact file: its SHA-256, and whether it is
/// one of the game's add-ons. Matched by the name it downloads as.
async fn identify<R: Runtime>(app: &AppHandle<R>, id: &str, client: &reqwest::Client) {
    let Some(d) = edit(app, id, |_| {}) else { return };
    let Some(slug) = d.slug.clone() else { return };
    if d.file_name.is_empty() {
        return;
    }
    #[allow(unused_mut)]
    let mut base = crate::settings::catalog_endpoint(&crate::settings::load(app));
    // Debug builds only, beside KRYOTO_DEV_DOWNLOAD_HOST: the stand-in filehost
    // also answers this, so a local archive can be checked against its own hash.
    #[cfg(debug_assertions)]
    if let Ok(dev) = std::env::var("KRYOTO_DEV_DOWNLOAD_HOST") {
        if !dev.is_empty() {
            base = format!("http://{dev}");
        }
    }
    let Ok(res) = client.get(format!("{base}/api/games/{slug}/downloads")).send().await else { return };
    let Ok(json) = res.json::<serde_json::Value>().await else { return };
    let (sha, addon) = match_file(&json, &d.file_name);
    edit(app, id, |d| {
        if sha.is_some() {
            d.sha256 = sha;
        }
        d.addon = addon;
    });
}

/// The SHA-256 and (for an add-on) the name of `file` in a
/// `/api/games/<slug>/downloads` answer.
pub fn match_file(json: &serde_json::Value, file: &str) -> (Option<String>, Option<String>) {
    let same = |name: &str| safe_name(name).eq_ignore_ascii_case(file);
    let hash_in = |v: &serde_json::Value| {
        v["hashes"].as_array().and_then(|hs| {
            hs.iter()
                .find(|h| h["name"].as_str().is_some_and(same))
                .and_then(|h| h["sha256"].as_str())
                .filter(|s| s.len() == 64)
                .map(|s| s.to_ascii_lowercase())
        })
    };
    if let Some(sha) = hash_in(json) {
        return (Some(sha), None);
    }
    for addon in json["addons"].as_array().into_iter().flatten() {
        let named = addon["links"].as_array().into_iter().flatten().any(|l| l["name"].as_str().is_some_and(same));
        let hash = hash_in(addon);
        if named || hash.is_some() {
            let label = addon["label"].as_str().filter(|l| !l.trim().is_empty()).unwrap_or("Add-on").to_string();
            return (hash, Some(label));
        }
    }
    (None, None)
}

/// Check the archive against the SHA-256 kryo.to lists for it. A mismatch
/// deletes the archive - it cannot be trusted, and resuming it would only
/// keep the damage.
async fn verify<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    let d = edit(app, id, |_| {}).ok_or("The download is gone.")?;
    let Some(expected) = d.sha256.clone() else { return Ok(()) };
    if d.verified {
        return Ok(());
    }
    set_status(app, id, Status::Verifying, None);
    let path = PathBuf::from(&d.archive_path);
    let total = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let progress_app = app.clone();
    let pid = id.to_string();
    let actual = tauri::async_runtime::spawn_blocking(move || -> std::io::Result<String> {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let mut file = std::fs::File::open(&path)?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 4 * 1024 * 1024];
        let mut done = 0u64;
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            done += n as u64;
            edit(&progress_app, &pid, |d| {
                d.extracted = done;
                d.extract_total = Some(total);
            });
            emit(&progress_app, false);
        }
        Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Could not read the archive to check it: {e}"))?;
    if actual != expected {
        crate::logging::error("download", &format!("{id}: sha256 {actual} is not {expected}"));
        let _ = std::fs::remove_file(&d.archive_path);
        edit(app, id, |d| {
            d.received = 0;
            d.segments.clear();
            d.archive_path.clear();
            d.extracted = 0;
            d.extract_total = None;
        });
        return Err("Archive doesn't match hash. Please try redownloading or contact support.".into());
    }
    edit(app, id, |d| {
        d.verified = true;
        d.extracted = 0;
        d.extract_total = None;
    });
    Ok(())
}

fn settle_stopped<R: Runtime>(app: &AppHandle<R>, id: &str, flag: &AtomicU8) -> Result<(), String> {
    if flag.load(Ordering::SeqCst) == CANCEL {
        if let Some(d) = edit(app, id, |_| {}) {
            if !d.archive_path.is_empty() {
                let _ = std::fs::remove_file(&d.archive_path);
            }
        }
        edit(app, id, |d| d.received = 0);
        set_status(app, id, Status::Canceled, None);
    } else {
        set_status(app, id, Status::Paused, None);
    }
    Ok(())
}

enum Transfer {
    Retry(String),
    Fatal(String),
}

/// Move bytes. `Ok(true)` finished, `Ok(false)` paused or cancelled.
async fn transfer<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    flag: &AtomicU8,
    client: &reqwest::Client,
    library_dir: &str,
) -> Result<bool, Transfer> {
    let item = edit(app, id, |_| {}).ok_or(Transfer::Fatal("The download is gone.".into()))?;
    let on_disk = if item.archive_path.is_empty() {
        0
    } else {
        std::fs::metadata(&item.archive_path).map(|m| m.len()).unwrap_or(0)
    };
    let mut request = client.get(&item.url);
    if on_disk > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={on_disk}-"));
    }
    let response = request.send().await.map_err(|e| Transfer::Retry(e.to_string()))?;
    let status = response.status();
    match status.as_u16() {
        200 | 206 => {}
        410 => {
            return Err(Transfer::Fatal(
                "The download link expired. Open the game in the Store and press Download again.".into(),
            ))
        }
        403 => {
            return Err(Transfer::Fatal(
                "kryo.to refused the link - it only works on the network it was made for. Press Download again in the Store."
                    .into(),
            ))
        }
        416 if on_disk > 0 => return Ok(true),
        s if s >= 500 => return Err(Transfer::Retry(format!("the server answered {s}"))),
        s => return Err(Transfer::Fatal(format!("The download failed: the server answered {s}."))),
    }
    let resumed = status.as_u16() == 206;
    let total = if resumed {
        response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit('/').next())
            .and_then(|v| v.parse::<u64>().ok())
    } else {
        response.content_length()
    };

    let mut path = PathBuf::from(&item.archive_path);
    if item.archive_path.is_empty() {
        let name = response
            .headers()
            .get(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .and_then(filename_from_disposition)
            .or_else(|| file_name_in_link(&item.url))
            .or_else(|| {
                response.url().path_segments().and_then(|mut s| s.next_back()).map(String::from)
            })
            .map(|n| safe_name(&n))
            .unwrap_or_else(|| format!("{}.7z", safe_name(&item.meta.title)));
        let dir = Path::new(library_dir).join("_downloads");
        std::fs::create_dir_all(&dir).map_err(|e| Transfer::Fatal(format!("Cannot write to {}: {e}", dir.display())))?;
        path = dir.join(&name);
        edit(app, id, |d| {
            d.file_name = name.clone();
            d.archive_path = path.to_string_lossy().into_owned();
            name_from_file(d);
        });
    }

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(&path)
        .await
        .map_err(|e| Transfer::Fatal(format!("Cannot write {}: {e}", path.display())))?;
    let mut received = if resumed { on_disk } else { 0 };
    // Room for the rest of the archive, and for about as much again unpacked.
    // The exact unpacked size is checked again before extracting.
    if let Some(t) = total {
        crate::storage::check_room(Path::new(library_dir), t.saturating_sub(received) + t, &item.meta.title)
            .map_err(Transfer::Fatal)?;
    }
    edit(app, id, |d| {
        d.received = received;
        d.total = total.or(d.total);
    });

    let mut stream = response.bytes_stream();
    let mut window_start = Instant::now();
    let mut window_bytes = 0u64;
    let mut last_persist = Instant::now();
    while let Some(chunk) = stream.next().await {
        if flag.load(Ordering::SeqCst) != RUN {
            let _ = file.flush().await;
            edit(app, id, |d| d.received = received);
            return Ok(false);
        }
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let _ = file.flush().await;
                let _ = file.sync_all().await;
                edit(app, id, |d| d.received = received);
                return Err(Transfer::Retry(e.to_string()));
            }
        };
        file.write_all(&chunk)
            .await
            .map_err(|e| Transfer::Fatal(format!("Writing the download failed: {e}")))?;
        received += chunk.len() as u64;
        window_bytes += chunk.len() as u64;
        let elapsed = window_start.elapsed().as_secs_f64();
        if elapsed >= 1.0 {
            let speed = (window_bytes as f64 / elapsed) as u64;
            window_start = Instant::now();
            window_bytes = 0;
            edit(app, id, |d| {
                d.received = received;
                d.speed = if d.speed == 0 { speed } else { (d.speed + speed) / 2 };
            });
            emit(app, false);
        }
        if last_persist.elapsed().as_secs() >= 5 {
            persist(app);
            last_persist = Instant::now();
        }
    }
    file.flush().await.map_err(|e| Transfer::Fatal(e.to_string()))?;
    edit(app, id, |d| {
        d.received = received;
        d.total = Some(d.total.unwrap_or(received).max(received));
    });
    if total.is_some_and(|t| received < t) {
        return Err(Transfer::Retry("the connection closed early".into()));
    }
    Ok(true)
}

/// What a status code means for a download.
fn check_status(code: u16) -> Result<(), Transfer> {
    match code {
        200 | 206 => Ok(()),
        410 => Err(Transfer::Fatal("The download link expired. Open the game in the Store and press Download again.".into())),
        403 => Err(Transfer::Fatal(
            "kryo.to refused the link - it only works on the network it was made for. Press Download again in the Store.".into(),
        )),
        s if s >= 500 => Err(Transfer::Retry(format!("the server answered {s}"))),
        s => Err(Transfer::Fatal(format!("The download failed: the server answered {s}."))),
    }
}

/// Fetch in parallel: the file is split into ranges, each on its own
/// connection, written straight to its place in a file made at full size. A
/// server that does not do ranges falls back to one stream.
async fn transfer_parallel<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    flag: &AtomicU8,
    client: &reqwest::Client,
    library_dir: &str,
    connections: u32,
    limiter: &Arc<Limiter>,
) -> Result<bool, Transfer> {
    let mut item = edit(app, id, |_| {}).ok_or(Transfer::Fatal("The download is gone.".into()))?;
    let resumable = !item.segments.is_empty() && !item.archive_path.is_empty() && Path::new(&item.archive_path).is_file();
    if !resumable {
        let probe = client
            .get(&item.url)
            .header(reqwest::header::RANGE, "bytes=0-0")
            .send()
            .await
            .map_err(|e| Transfer::Retry(e.to_string()))?;
        check_status(probe.status().as_u16())?;
        let total = (probe.status().as_u16() == 206)
            .then(|| {
                probe
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.rsplit('/').next())
                    .and_then(|v| v.parse::<u64>().ok())
            })
            .flatten();
        let Some(total) = total.filter(|t| *t > 0) else {
            drop(probe);
            return transfer(app, id, flag, client, library_dir).await;
        };
        let name = probe
            .headers()
            .get(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .and_then(filename_from_disposition)
            .or_else(|| file_name_in_link(&item.url))
            .or_else(|| probe.url().path_segments().and_then(|mut s| s.next_back()).map(String::from))
            .map(|n| safe_name(&n))
            .unwrap_or_else(|| format!("{}.7z", safe_name(&item.meta.title)));
        drop(probe);
        crate::storage::check_room(Path::new(library_dir), total * 2, &item.meta.title).map_err(Transfer::Fatal)?;
        let dir = Path::new(library_dir).join("_downloads");
        std::fs::create_dir_all(&dir).map_err(|e| Transfer::Fatal(format!("Cannot write to {}: {e}", dir.display())))?;
        let path = dir.join(&name);
        let file = std::fs::File::create(&path).map_err(|e| Transfer::Fatal(format!("Cannot write {}: {e}", path.display())))?;
        file.set_len(total).map_err(|e| Transfer::Fatal(format!("Cannot make room for {}: {e}", path.display())))?;
        drop(file);
        let segments = split(total, connections);
        edit(app, id, |d| {
            d.file_name = name.clone();
            d.archive_path = path.to_string_lossy().into_owned();
            name_from_file(d);
            d.total = Some(total);
            d.received = 0;
            d.segments = segments;
            d.verified = false;
        });
        persist(app);
        item = edit(app, id, |_| {}).ok_or(Transfer::Fatal("The download is gone.".into()))?;
    }

    let path = PathBuf::from(&item.archive_path);
    let segments = item.segments.clone();
    let progress: Arc<Vec<AtomicU64>> = Arc::new(segments.iter().map(|s| AtomicU64::new(s.done.min(s.len()))).collect());
    let stop = Arc::new(AtomicU8::new(RUN));
    let mut tasks = Vec::new();
    for (i, seg) in segments.iter().cloned().enumerate() {
        if seg.done >= seg.len() {
            continue;
        }
        let (client, url, path, progress, limiter, stop) =
            (client.clone(), item.url.clone(), path.clone(), progress.clone(), limiter.clone(), stop.clone());
        tasks.push(tokio::spawn(async move { fetch_range(&client, &url, &path, i, seg, &progress, &stop, &limiter).await }));
    }

    let mut last_sum: u64 = progress.iter().map(|p| p.load(Ordering::SeqCst)).sum();
    let mut tick = Instant::now();
    let mut last_persist = Instant::now();
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        // Pause and cancel reach the connections through `stop`.
        stop.store(flag.load(Ordering::SeqCst), Ordering::SeqCst);
        let sum: u64 = progress.iter().map(|p| p.load(Ordering::SeqCst)).sum();
        let dt = tick.elapsed().as_secs_f64().max(0.001);
        let speed = (sum.saturating_sub(last_sum) as f64 / dt) as u64;
        last_sum = sum;
        tick = Instant::now();
        edit(app, id, |d| {
            d.received = sum;
            d.speed = if d.speed == 0 { speed } else { (d.speed * 2 + speed) / 3 };
            for (i, s) in d.segments.iter_mut().enumerate() {
                if let Some(p) = progress.get(i) {
                    s.done = p.load(Ordering::SeqCst);
                }
            }
        });
        emit(app, false);
        if last_persist.elapsed().as_secs() >= 5 {
            persist(app);
            last_persist = Instant::now();
        }
        if tasks.iter().all(|t| t.is_finished()) {
            break;
        }
    }
    let mut retry = None;
    let mut fatal = None;
    for t in tasks {
        match t.await {
            Ok(Ok(())) => {}
            Ok(Err(Transfer::Retry(e))) => retry = Some(e),
            Ok(Err(Transfer::Fatal(e))) => fatal = Some(e),
            Err(e) => retry = Some(e.to_string()),
        }
    }
    let sum: u64 = progress.iter().map(|p| p.load(Ordering::SeqCst)).sum();
    edit(app, id, |d| {
        d.received = sum;
        for (i, s) in d.segments.iter_mut().enumerate() {
            if let Some(p) = progress.get(i) {
                s.done = p.load(Ordering::SeqCst);
            }
        }
    });
    persist(app);
    if let Some(e) = fatal {
        return Err(Transfer::Fatal(e));
    }
    if flag.load(Ordering::SeqCst) != RUN {
        return Ok(false);
    }
    if let Some(e) = retry {
        return Err(Transfer::Retry(e));
    }
    Ok(true)
}

/// One range, on one connection, written at its own offset. Progress is only
/// counted for bytes that have been written.
#[allow(clippy::too_many_arguments)]
async fn fetch_range(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    index: usize,
    seg: Segment,
    progress: &[AtomicU64],
    stop: &AtomicU8,
    limiter: &Limiter,
) -> Result<(), Transfer> {
    let done = progress[index].load(Ordering::SeqCst);
    if done >= seg.len() {
        return Ok(());
    }
    let from = seg.start + done;
    let res = client
        .get(url)
        .header(reqwest::header::RANGE, format!("bytes={from}-{}", seg.end))
        .send()
        .await
        .map_err(|e| Transfer::Retry(e.to_string()))?;
    check_status(res.status().as_u16())?;
    if res.status().as_u16() != 206 {
        return Err(Transfer::Fatal("The server stopped answering ranged requests. Set Downloads to one connection and try again.".into()));
    }
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .await
        .map_err(|e| Transfer::Fatal(format!("Cannot write {}: {e}", path.display())))?;
    file.seek(std::io::SeekFrom::Start(from)).await.map_err(|e| Transfer::Fatal(e.to_string()))?;
    let mut written = done;
    let mut stream = res.bytes_stream();
    let mut failure = None;
    while let Some(chunk) = stream.next().await {
        if stop.load(Ordering::SeqCst) != RUN {
            break;
        }
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                failure = Some(e.to_string());
                break;
            }
        };
        let take = (chunk.len() as u64).min(seg.len() - written) as usize;
        if let Err(e) = file.write_all(&chunk[..take]).await {
            return Err(Transfer::Fatal(format!("Writing the download failed: {e}")));
        }
        written += take as u64;
        limiter.take(take as u64).await;
        if written >= seg.len() {
            break;
        }
        // Counted once the bytes are flushed often enough to matter: every
        // 8 MB, and at the end.
        if written - progress[index].load(Ordering::SeqCst) >= 8 * 1024 * 1024 {
            file.flush().await.map_err(|e| Transfer::Fatal(e.to_string()))?;
            progress[index].store(written, Ordering::SeqCst);
        }
    }
    file.flush().await.map_err(|e| Transfer::Fatal(e.to_string()))?;
    let _ = file.sync_data().await;
    progress[index].store(written, Ordering::SeqCst);
    if let Some(e) = failure {
        return Err(Transfer::Retry(e));
    }
    if written < seg.len() && stop.load(Ordering::SeqCst) == RUN {
        return Err(Transfer::Retry("the connection closed early".into()));
    }
    Ok(())
}

/// Unpack into the library folder, find the exe, and list the game.
async fn install<R: Runtime>(app: &AppHandle<R>, id: &str, settings: &crate::settings::Settings) -> Result<(), String> {
    set_status(app, id, Status::Extracting, None);
    let item = edit(app, id, |_| {}).ok_or("The download is gone.")?;
    let archive = PathBuf::from(&item.archive_path);
    let title = if is_placeholder(&item.meta.title, item.slug.as_deref()) {
        title_from_file(&item.file_name)
    } else {
        item.meta.title.clone()
    };
    // An update goes where the game already is - whichever library folder
    // that is, under whatever its folder is called - so saves stay with it.
    let folders = crate::settings::all_folders(settings);
    let existing = item.slug.as_ref().and_then(|slug| {
        library::load(app).ok()?.into_iter().find(|g| g.slug.as_deref() == Some(slug.as_str()))
    });
    let dest = existing
        .and_then(|g| crate::storage::game_folder(&folders, &g.install_dir))
        .unwrap_or_else(|| Path::new(&settings.library_dir).join(safe_name(&title)));
    let parent = dest.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from(&settings.library_dir));
    let staging = parent.join(format!(".{}.installing", safe_name(&title)));
    if let Some(size) = unpacked_size(&archive) {
        crate::storage::check_room(&parent, size, &title)?;
    }

    let progress_app = app.clone();
    let progress_id = id.to_string();
    let (dest_clone, staging_clone) = (dest.clone(), staging.clone());
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _ = std::fs::remove_dir_all(&staging_clone);
        extract(&archive, &staging_clone, &|done, total| {
            edit(&progress_app, &progress_id, |d| {
                d.extracted = done;
                d.extract_total = total;
            });
            emit(&progress_app, false);
        })?;
        // Unpacked beside the game rather than into it, then merged in: an
        // archive that wraps everything in one folder does not end up nested
        // a level down, and an update overwrites the files it ships while
        // leaving saves and settings the game wrote next to itself.
        let top = single_child_dir(&staging_clone).unwrap_or_else(|| staging_clone.clone());
        move_tree(&top, &dest_clone).map_err(|e| format!("Installing into {} failed: {e}", dest_clone.display()))?;
        let _ = std::fs::remove_dir_all(&staging_clone);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    let (root, executable) = locate(&dest, &item.meta.executable);
    let game = library::upsert_installed(
        app,
        LibraryGame {
            title: title.clone(),
            slug: item.slug.clone(),
            cover: item.meta.cover.clone(),
            hero: item.meta.hero.clone(),
            install_dir: root.to_string_lossy().into_owned(),
            executable,
            default_args: item.meta.default_args.clone(),
            entries: item.meta.entries.clone(),
            source: item.meta.source.clone(),
            version: item.meta.version.clone(),
            short: item.meta.short.clone(),
            developer: item.meta.developer.clone(),
            nsfw: item.meta.nsfw,
            ..Default::default()
        },
    )?;
    if settings.delete_archives {
        let _ = std::fs::remove_file(&item.archive_path);
    }
    edit(app, id, |d| {
        d.install_dir = Some(game.install_dir.clone());
        d.game_id = Some(game.id.clone());
    });
    set_status(app, id, Status::Installed, None);
    let _ = app.emit("library-changed", ());
    if settings.notify_downloads {
        let _ = app.emit(
            "notify",
            Notice::new(&format!("{title} is ready to play"), "Installed and added to your library.", Some(game.id)),
        );
    }
    Ok(())
}

/// What a .7z says it unpacks to, from its headers. `None` for other formats.
fn unpacked_size(archive: &Path) -> Option<u64> {
    let ext = archive.extension()?.to_string_lossy().to_ascii_lowercase();
    if ext != "7z" {
        return None;
    }
    let a = sevenz_rust::Archive::open(archive).ok()?;
    Some(a.files.iter().map(|f| f.size()).sum())
}

/// The one folder inside `dir`, when that is all there is.
pub(crate) fn single_child_dir(dir: &Path) -> Option<PathBuf> {
    let items: Vec<_> = std::fs::read_dir(dir).ok()?.flatten().collect();
    match items.as_slice() {
        [only] if only.path().is_dir() => Some(only.path()),
        _ => None,
    }
}

/// Move everything under `from` into `to`, replacing files that are there and
/// keeping the ones that are not.
pub fn move_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            if target.is_dir() {
                move_tree(&entry.path(), &target)?;
            } else {
                if target.exists() {
                    std::fs::remove_file(&target)?;
                }
                std::fs::rename(entry.path(), &target)?;
            }
        } else {
            if target.exists() {
                std::fs::remove_file(&target)?;
            }
            std::fs::rename(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Reject archive entries that would land outside the install folder.
fn safe_join(dest: &Path, name: &str) -> Option<PathBuf> {
    let rel = Path::new(name);
    if rel.components().any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_))) {
        return None;
    }
    Some(dest.join(rel))
}

/// Unpack `archive` into `dest`, reporting uncompressed bytes as it goes.
///
/// 7z archives are read in-process first. Forge packs with 7-Zip, which can use
/// the BCJ2 filter that the Rust decoder does not implement; when it refuses,
/// the system's libarchive (`tar`, which reads 7z with BCJ2 on Windows 10+ and
/// on Linux) finishes the job without progress.
pub fn extract(archive: &Path, dest: &Path, progress: &dyn Fn(u64, Option<u64>)) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("Cannot create {}: {e}", dest.display()))?;
    let is_7z = archive
        .extension()
        .map(|e| e.to_string_lossy().eq_ignore_ascii_case("7z"))
        .unwrap_or(false);
    if is_7z {
        match extract_7z(archive, dest, progress) {
            Ok(()) => return Ok(()),
            Err(e) => {
                progress(0, None);
                return extract_with_tar(archive, dest).map_err(|t| format!("{e}; {t}"));
            }
        }
    }
    progress(0, None);
    extract_with_tar(archive, dest)
}

fn extract_7z(archive: &Path, dest: &Path, progress: &dyn Fn(u64, Option<u64>)) -> Result<(), String> {
    let total: u64 = sevenz_rust::Archive::open(archive)
        .map_err(|e| format!("Not a readable 7z ({e})"))?
        .files
        .iter()
        .map(|f| f.size())
        .sum();
    let mut done = 0u64;
    let mut last = Instant::now();
    progress(0, Some(total));
    sevenz_rust::decompress_file_with_extract_fn(archive, dest, |entry, reader, _| {
        let Some(path) = safe_join(dest, entry.name()) else {
            return Err(sevenz_rust::Error::other(format!("unsafe path in archive: {}", entry.name())));
        };
        if entry.is_directory() {
            std::fs::create_dir_all(&path).map_err(sevenz_rust::Error::io)?;
            return Ok(true);
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(sevenz_rust::Error::io)?;
        }
        let file = std::fs::File::create(&path).map_err(sevenz_rust::Error::io)?;
        let mut writer = std::io::BufWriter::with_capacity(1 << 20, file);
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = reader.read(&mut buf).map_err(sevenz_rust::Error::io)?;
            if n == 0 {
                break;
            }
            std::io::Write::write_all(&mut writer, &buf[..n]).map_err(sevenz_rust::Error::io)?;
            done += n as u64;
            if last.elapsed().as_millis() > 200 {
                progress(done, Some(total));
                last = Instant::now();
            }
        }
        std::io::Write::flush(&mut writer).map_err(sevenz_rust::Error::io)?;
        Ok(true)
    })
    .map_err(|e| format!("Unpacking failed ({e})"))?;
    progress(total, Some(total));
    Ok(())
}

fn extract_with_tar(archive: &Path, dest: &Path) -> Result<(), String> {
    #[cfg(windows)]
    let candidates: Vec<(PathBuf, Vec<String>)> = {
        let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        vec![(PathBuf::from(system).join(r"System32\tar.exe"), vec![])]
    };
    // GNU tar cannot read 7z, so on Linux libarchive's bsdtar comes first,
    // then 7-Zip under each of the names distributions give it.
    #[cfg(not(windows))]
    let candidates: Vec<(PathBuf, Vec<String>)> = vec![
        (PathBuf::from("bsdtar"), vec![]),
        (PathBuf::from("7zz"), vec!["7z".into()]),
        (PathBuf::from("7z"), vec!["7z".into()]),
        (PathBuf::from("7za"), vec!["7z".into()]),
        (PathBuf::from("tar"), vec![]),
    ];
    let mut last_error = String::from("no archive tool found (install bsdtar or 7-Zip)");
    for (tool, style) in candidates {
        let mut cmd = std::process::Command::new(&tool);
        if style.first().map(String::as_str) == Some("7z") {
            cmd.arg("x").arg("-y").arg(format!("-o{}", dest.display())).arg(archive);
        } else {
            cmd.arg("-xf").arg(archive).arg("-C").arg(dest);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        match cmd.output() {
            Ok(out) if out.status.success() => return Ok(()),
            Ok(out) => last_error = String::from_utf8_lossy(&out.stderr).trim().to_string(),
            Err(e) => last_error = e.to_string(),
        }
    }
    Err(format!("Could not unpack the archive: {last_error}"))
}

/// Work out the game's root folder and its exe after unpacking.
///
/// An archive may or may not wrap everything in one top folder, and the release
/// names its exe relative to the game's root (`bin/win64/Game.exe`), so: find
/// that exe anywhere shallow, and the root is whatever sits above its relative
/// path. Without one, the biggest plausible exe near the top.
pub fn locate(dest: &Path, wanted: &str) -> (PathBuf, String) {
    let wanted = wanted.replace('\\', "/").trim_matches('/').to_string();
    let exes = find_exes(dest, 4);
    if !wanted.is_empty() {
        let wanted_lower = wanted.to_ascii_lowercase();
        for exe in &exes {
            let rel = exe.strip_prefix(dest).unwrap_or(exe).to_string_lossy().replace('\\', "/");
            if rel.to_ascii_lowercase() == wanted_lower || rel.to_ascii_lowercase().ends_with(&format!("/{wanted_lower}")) {
                let depth = wanted.split('/').count();
                let mut root = exe.clone();
                for _ in 0..depth {
                    root.pop();
                }
                return (root, wanted);
            }
        }
    }
    // One folder and nothing else: that folder is the game.
    let mut root = dest.to_path_buf();
    if let Ok(read) = std::fs::read_dir(dest) {
        let items: Vec<_> = read.flatten().collect();
        if items.len() == 1 && items[0].path().is_dir() {
            root = items[0].path();
        }
    }
    const JUNK: [&str; 8] = ["unins", "crash", "redist", "vcredist", "dxsetup", "setup", "report", "helper"];
    let best = exes
        .iter()
        .filter(|p| p.starts_with(&root))
        .filter(|p| {
            let name = p.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
            !JUNK.iter().any(|j| name.contains(j))
        })
        .min_by_key(|p| {
            let depth = p.strip_prefix(&root).map(|r| r.components().count()).unwrap_or(9);
            let size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
            (depth, u64::MAX - size)
        });
    let exe = best
        .and_then(|p| p.strip_prefix(&root).ok())
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    (root, exe)
}

fn find_exes(dir: &Path, depth: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(read) = std::fs::read_dir(dir) else { return out };
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth > 0 {
                out.extend(find_exes(&path, depth - 1));
            }
        } else if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) {
            out.push(path);
        }
    }
    out
}

/* ── commands ─────────────────────────────────────────────── */

#[tauri::command]
pub fn downloads_list(state: State<'_, Downloads>) -> Vec<Download> {
    state.list.lock().map(|l| l.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn download_pause(state: State<'_, Downloads>, id: String) {
    if let Some(flag) = state.controls.lock().ok().and_then(|c| c.get(&id).cloned()) {
        flag.store(PAUSE, Ordering::SeqCst);
    }
}

#[tauri::command]
pub fn download_resume(app: AppHandle, state: State<'_, Downloads>, id: String) -> Result<(), String> {
    if state.controls.lock().map(|c| c.contains_key(&id)).unwrap_or(false) {
        return Ok(());
    }
    edit(&app, &id, |d| {
        d.error = None;
        d.status = Status::Queued;
    })
    .ok_or("That download is gone.")?;
    emit(&app, true);
    start(app.clone(), id);
    Ok(())
}

#[tauri::command]
pub fn download_cancel(app: AppHandle, state: State<'_, Downloads>, id: String) {
    if let Some(flag) = state.controls.lock().ok().and_then(|c| c.get(&id).cloned()) {
        flag.store(CANCEL, Ordering::SeqCst);
        return;
    }
    // Not running (paused or failed): tidy up here.
    if let Some(d) = edit(&app, &id, |_| {}) {
        if !d.archive_path.is_empty() && d.status != Status::Installed {
            let _ = std::fs::remove_file(&d.archive_path);
        }
    }
    edit(&app, &id, |d| d.received = 0);
    set_status(&app, &id, Status::Canceled, None);
}

/// Clear a finished, failed or cancelled row.
#[tauri::command]
pub fn download_remove(app: AppHandle, state: State<'_, Downloads>, id: String) {
    if state.controls.lock().map(|c| c.contains_key(&id)).unwrap_or(false) {
        return;
    }
    if let Ok(mut list) = state.list.lock() {
        list.retain(|d| d.id != id);
    }
    persist(&app);
    emit(&app, true);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_cover_the_file_exactly() {
        let total = 2_458_559_531u64;
        let segs = split(total, 8);
        assert_eq!(segs.len(), 8);
        assert_eq!(segs[0].start, 0);
        assert_eq!(segs.last().unwrap().end, total - 1);
        for w in segs.windows(2) {
            assert_eq!(w[0].end + 1, w[1].start);
        }
        assert_eq!(segs.iter().map(|s| s.len()).sum::<u64>(), total);
        // Small files are not split into slivers.
        assert_eq!(split(5 * 1024 * 1024, 8).len(), 1);
        assert!(split(0, 8).is_empty());
    }

    #[test]
    fn files_are_matched_to_their_hash_and_add_ons_are_recognised() {
        let json = serde_json::json!({
            "hashes": [{ "name": "Until Then - Kryoto.7z", "sha256": "8087783ba95268c527b59dba1a7a745bfbef5df90574aa05d5dd02742c6d3ec5" }],
            "addons": [{ "label": "Online add-on", "links": [{ "name": "Until Then - Online - Kryoto.7z" }], "hashes": [] }]
        });
        let (sha, addon) = match_file(&json, "Until Then - Kryoto.7z");
        assert_eq!(sha.as_deref(), Some("8087783ba95268c527b59dba1a7a745bfbef5df90574aa05d5dd02742c6d3ec5"));
        assert!(addon.is_none());
        let (sha, addon) = match_file(&json, "Until Then - Online - Kryoto.7z");
        assert!(sha.is_none());
        assert_eq!(addon.as_deref(), Some("Online add-on"));
        assert_eq!(match_file(&json, "something else.7z"), (None, None));
    }

    #[test]
    fn filenames_come_out_of_content_disposition() {
        assert_eq!(
            filename_from_disposition("attachment; filename*=UTF-8''Captain%20Hardcore%20-%20Kryoto.7z").as_deref(),
            Some("Captain Hardcore - Kryoto.7z")
        );
        assert_eq!(
            filename_from_disposition(r#"attachment; filename="Game - Kryoto.7z""#).as_deref(),
            Some("Game - Kryoto.7z")
        );
        assert_eq!(filename_from_disposition("inline"), None);
    }

    #[test]
    fn an_update_merges_over_the_old_install_and_keeps_saves() {
        let d = scratch("merge");
        let old = d.join("Game");
        std::fs::create_dir_all(old.join("Data")).unwrap();
        std::fs::write(old.join("Game.exe"), b"old").unwrap();
        std::fs::write(old.join("save.dat"), b"mine").unwrap();
        let new = d.join("staging/Game");
        std::fs::create_dir_all(new.join("Data")).unwrap();
        std::fs::write(new.join("Game.exe"), b"new").unwrap();
        std::fs::write(new.join("Data/level.bin"), b"L").unwrap();
        let top = single_child_dir(&d.join("staging")).unwrap();
        move_tree(&top, &old).unwrap();
        assert_eq!(std::fs::read(old.join("Game.exe")).unwrap(), b"new");
        assert_eq!(std::fs::read(old.join("save.dat")).unwrap(), b"mine", "saves stay");
        assert!(old.join("Data/level.bin").is_file());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn titles_come_from_release_file_names() {
        assert_eq!(title_from_file("Captain Hardcore - Kryoto.7z"), "Captain Hardcore");
        assert_eq!(title_from_file("Portal 2.zip"), "Portal 2");
        assert_eq!(title_from_file(".7z"), "Game");
    }

    /// A download with no name from anywhere else was called "download" - the
    /// last piece of an address is not a game.
    #[test]
    fn generic_file_names_name_nothing() {
        for name in ["download", "Download.7z", "file", "d", "eyJrIjoiYWJjIiwiZXhwIjoxfQ.c2lnbmF0dXJlc2lnbmF0dXJl"] {
            assert_eq!(title_in_file_name(name), None, "{name}");
        }
        assert_eq!(title_in_file_name("Hades II - Kryoto.7z").as_deref(), Some("Hades II"));
        assert_eq!(title_in_file_name("Portal 2.5 Remix.7z").as_deref(), Some("Portal 2.5 Remix"));
        assert!(is_placeholder("download", None));
        assert!(is_placeholder("hades-ii", Some("hades-ii")));
        assert!(!is_placeholder("Hades II", Some("hades-ii")));
    }

    /// dl.kryo.to's link carries the name the file saves as.
    #[test]
    fn the_link_names_its_file() {
        // {"k":"a/b","exp":1,"n":"Hades II - Kryoto.7z"}, as lib/dl-token.ts mints it.
        let body = "eyJrIjoiYS9iIiwiZXhwIjoxLCJuIjoiSGFkZXMgSUkgLSBLcnlvdG8uN3oifQ";
        let url = format!("https://dl.kryo.to/d/{body}.c2ln");
        assert_eq!(file_name_in_link(&url).as_deref(), Some("Hades II - Kryoto.7z"));
        assert_eq!(file_name_in_link("https://dl.kryo.to/x/abc"), None);
        assert_eq!(file_name_in_link("https://dl.kryo.to/d/%%%"), None);
        assert_eq!(base64url("aGk").as_deref(), Some(&b"hi"[..]));
    }

    #[test]
    fn names_are_safe_folder_names() {
        assert_eq!(safe_name("Half-Life: Alyx?"), "Half-Life Alyx");
        assert_eq!(safe_name("..\\..\\x"), "x");
        assert_eq!(safe_name("   "), "Game");
    }

    #[test]
    fn only_kryoto_downloads_are_taken_over() {
        let settings = crate::settings::Settings::default();
        assert!(is_ours(&"https://dl.kryo.to/d/abc".parse().unwrap(), &settings));
        assert!(is_ours(&"https://kryo.to/api/download/v/1".parse().unwrap(), &settings));
        assert!(!is_ours(&"https://evil-kryo.to/x".parse().unwrap(), &settings));
        assert!(!is_ours(&"http://dl.kryo.to/d/abc".parse().unwrap(), &settings));
        assert!(!is_ours(&"https://vikingfile.com/f/x".parse().unwrap(), &settings));
        let local = crate::settings::Settings { catalog_endpoint: "http://localhost:3000".into(), ..Default::default() };
        assert!(is_ours(&"http://localhost:3000/api/download/v/1".parse().unwrap(), &local));
        assert!(!is_ours(&"http://localhost:3001/api/download/v/1".parse().unwrap(), &local));
    }

    #[test]
    fn archive_entries_cannot_escape() {
        let d = Path::new("/lib/Game");
        assert!(safe_join(d, "../../evil.dll").is_none());
        assert!(safe_join(d, "bin/ok.dll").is_some());
    }

    #[test]
    fn meta_reads_the_game_api() {
        let json: serde_json::Value = serde_json::from_str(
            r#"{"title":"Captain Hardcore","steam_appid":"1190600","cover_vertical":"https://x/v.jpg",
               "game_executable_path":"Captain Hardcore.exe","game_executable_args":null,"source":"Steam (DRM-free)",
               "version":"b123","download_size_bytes":1234,
               "game_launch_options":{"available":[
                 {"type":"vr","oslist":"windows","arguments":"","executable":"Captain Hardcore.exe","workingdir":"","description":""},
                 {"type":"default","oslist":"windows","arguments":"-nohmd","executable":"Captain Hardcore.exe","workingdir":"","description":"Captain Hardcore Desktop Mode"},
                 {"oslist":"macos","arguments":"","executable":"x.app","workingdir":"","description":""}]}}"#,
        )
        .unwrap();
        let m = meta_from_json(&json);
        assert_eq!(m.entries.len(), 2, "the macOS entry is dropped");
        assert_eq!(m.entries[1].arguments, "-nohmd");
        assert_eq!(m.entries[0].kind, "vr");
        assert_eq!(m.size_bytes, Some(1234));
        assert!(m.hero.unwrap().contains("1190600/library_hero"));
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kryoto-desktop-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn the_exe_decides_the_root_whether_or_not_there_is_a_top_folder() {
        let d = scratch("locate");
        std::fs::create_dir_all(d.join("Captain Hardcore/bin")).unwrap();
        std::fs::write(d.join("Captain Hardcore/Captain Hardcore.exe"), b"x").unwrap();
        std::fs::write(d.join("Captain Hardcore/UnityCrashHandler64.exe"), b"xxxxxxxx").unwrap();
        let (root, exe) = locate(&d, "Captain Hardcore.exe");
        assert_eq!(root, d.join("Captain Hardcore"));
        assert_eq!(exe, "Captain Hardcore.exe");
        // Nothing named: the non-junk exe at the top of the single folder.
        let (root, exe) = locate(&d, "");
        assert_eq!(root, d.join("Captain Hardcore"));
        assert_eq!(exe, "Captain Hardcore.exe");
        let _ = std::fs::remove_dir_all(d);
    }

    /// A real 7-Zip archive, made by 7-Zip the way Forge makes them (`-mx1
    /// -mmt`), unpacked by `extract`. Skipped where 7-Zip is not installed.
    #[cfg(windows)]
    #[test]
    fn a_forge_style_archive_unpacks() {
        let seven = Path::new(r"C:\Program Files\7-Zip\7z.exe");
        if !seven.exists() {
            return;
        }
        let d = scratch("extract");
        let src = d.join("src/Captain Hardcore");
        std::fs::create_dir_all(src.join("Data")).unwrap();
        std::fs::copy(r"C:\Windows\System32\cmd.exe", src.join("Captain Hardcore.exe")).unwrap();
        std::fs::write(src.join("Data/level.bin"), vec![7u8; 300_000]).unwrap();
        let archive = d.join("Captain Hardcore - Kryoto.7z");
        let status = std::process::Command::new(seven)
            .arg("a")
            .arg(&archive)
            .arg(d.join("src").join("*"))
            .args(["-mx1", "-mmt", "-y"])
            .output()
            .unwrap();
        assert!(status.status.success(), "{}", String::from_utf8_lossy(&status.stdout));
        let out = d.join("out");
        let seen = std::cell::Cell::new(0u64);
        extract(&archive, &out, &|done, _| seen.set(done)).unwrap();
        let (root, exe) = locate(&out, "Captain Hardcore.exe");
        assert!(root.join(&exe).is_file());
        assert_eq!(std::fs::read(root.join("Data/level.bin")).unwrap().len(), 300_000);
        let _ = std::fs::remove_dir_all(d);
    }
}
