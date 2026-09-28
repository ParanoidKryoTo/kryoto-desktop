mod addons;
mod compat;
mod downloads;
mod launch;
mod library;
mod links;
mod logging;
mod online;
mod settings;
mod storage;
mod system;

use serde::{Deserialize, Serialize};
use tauri::plugin::Builder as PluginBuilder;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl};

/// The Store / Community / profile pages: one real web view, kryo.to in it.
/// The label is what `capabilities/catalog.json` grants the reporting bridge to.
const STORE: &str = "catalog";
const HOME: &str = "https://kryo.to";

/// Navigation state for the web view, emitted to the shell.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserState {
    url: String,
    title: String,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
    error: Option<String>,
}

/// Who is signed in to kryo.to in the web view.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    username: String,
    display_name: Option<String>,
    avatar_url: Option<String>,
    /// The look the account picked on kryo.to (palette, corners, typeface,
    /// adult blur), which the client follows unless Settings says not to.
    #[serde(default)]
    appearance: Option<serde_json::Value>,
    /// A supporter (or bought "no ads"): the client does not ask them to donate.
    #[serde(default)]
    supporter: bool,
}

/// State reported by the page-side script.
///
/// The `url` field is accepted for shape but never trusted - the handler uses
/// the web view's real URL, so a page cannot spoof the address bar or claim to
/// be kryo.to when reporting an account.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserReport {
    #[allow(dead_code)]
    url: String,
    #[serde(default)]
    title: Option<String>,
    loading: bool,
    #[serde(default)]
    can_go_back: bool,
    #[serde(default)]
    can_go_forward: bool,
    #[serde(default)]
    error: Option<String>,
    /// `Some(None)` = signed out; absent = not reported this time.
    #[serde(default, deserialize_with = "some_account")]
    account: Option<Option<Account>>,
    /// `{ unreadCount, notifications }` from kryo.to's `/api/notifications`.
    #[serde(default)]
    inbox: Option<serde_json::Value>,
    /// `{ version, date }` from kryo.to's `/api/changelog/latest`.
    #[serde(default)]
    news: Option<serde_json::Value>,
    /// `{ entries }` from kryo.to's `/api/account/library`: the games the
    /// account marked Playing, Plan to Play, Favorite and so on.
    #[serde(default)]
    saved: Option<serde_json::Value>,
}

fn some_account<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<Account>>, D::Error> {
    Option::<Account>::deserialize(d).map(Some)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserErrorEvent {
    url: String,
    reason: String,
}

/// The game kryo.to said it was about to download (`store_expect_download`),
/// kept until the download arrives. A navigation that turns into a download
/// can reach `on_download` without its `#fragment` (WebView2 hands over the
/// address without it), and a board's `?game=` may be gone by then too, so
/// this is the context that survives. Used once, and only while fresh.
#[derive(Default)]
struct PendingDownload(std::sync::Mutex<Option<ExpectedDownload>>);

struct ExpectedDownload {
    slug: String,
    title: Option<String>,
    at: std::time::Instant,
}

/// How long a page's word about its next download holds.
const EXPECT_FOR: std::time::Duration = std::time::Duration::from_secs(90);

fn take_expected<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<ExpectedDownload> {
    let state = app.try_state::<PendingDownload>()?;
    let mut pending = state.0.lock().ok()?;
    pending.take().filter(|e| e.at.elapsed() < EXPECT_FOR)
}

/// A download's game and title, from everything that can say: the address's
/// fragment, what the page announced, then the page the Store is on.
fn download_game<R: Runtime>(
    app: &tauri::AppHandle<R>,
    url: &url::Url,
    page: Option<url::Url>,
    settings: &settings::Settings,
) -> (Option<String>, Option<String>) {
    let page_slug = page.and_then(|u| game_slug(&u, settings));
    merge_download_context(download_context(url), take_expected(app), page_slug)
}

fn merge_download_context(
    (mut slug, mut title): (Option<String>, Option<String>),
    expected: Option<ExpectedDownload>,
    page_slug: Option<String>,
) -> (Option<String>, Option<String>) {
    if let Some(expected) = expected {
        // A fragment naming another game wins; a stale announcement never
        // renames a download it was not about.
        if slug.is_none() || slug.as_deref() == Some(expected.slug.as_str()) {
            title = title.or(expected.title);
            slug = slug.or(Some(expected.slug));
        }
    }
    (slug.or(page_slug), title)
}

/// Only plain web navigation stays inside the web view. Everything else
/// (file:, javascript:, data:, custom schemes) is blocked and reported.
fn allowed_browser_url(url: &url::Url) -> bool {
    (url.scheme() == "https" || url.scheme() == "http") && !url.host_str().unwrap_or("").is_empty()
}

fn is_kryoto<R: Runtime>(url: &url::Url, app: &tauri::AppHandle<R>) -> bool {
    settings::is_catalog_origin(url, &settings::load(app))
}

fn map_catalog_url(url: url::Url, endpoint: &str) -> Result<url::Url, String> {
    let production = HOME.parse::<url::Url>().map_err(|e| e.to_string())?;
    if url.origin() != production.origin() {
        return Ok(url);
    }
    let mut mapped = url::Url::parse(endpoint).map_err(|e| e.to_string())?;
    mapped.set_path(url.path());
    mapped.set_query(url.query());
    mapped.set_fragment(url.fragment());
    Ok(mapped)
}

pub(crate) fn catalog_endpoint_changed<R: Runtime>(
    app: &tauri::AppHandle<R>,
    settings: &settings::Settings,
) -> Result<(), String> {
    if let Some(view) = app.get_webview(STORE) {
        let endpoint = settings::catalog_endpoint(settings);
        let url = url::Url::parse(&format!("{endpoint}/")).map_err(|e| e.to_string())?;
        view.navigate(url).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn block_reason(url: &url::Url) -> String {
    match url.scheme() {
        "file" | "javascript" | "data" | "blob" => {
            format!("Blocked {} navigation: this scheme never opens inline.", url.scheme())
        }
        _ => format!("Blocked unsupported address: {}://", url.scheme()),
    }
}

fn store<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<tauri::Webview<R>, String> {
    app.get_webview(STORE).ok_or_else(|| "The store is not open.".to_string())
}

fn emit_state<R: Runtime>(app: &tauri::AppHandle<R>, state: BrowserState) {
    let _ = app.emit("browser-state", &state);
}

/// Page-side reporting: SPA history (the native layer only sees full loads),
/// title changes, and - on kryo.to only - who is signed in. It only REPORTS;
/// the shell trusts the web view's URL from the native side.
const BROWSER_STATE_SCRIPT: &str = r#"
(() => {
  if (window.__kryoDesktop) return;
  window.__kryoDesktop = true;
  const key = '__kryo_desktop_history__';
  const invoke = (command, payload) => {
    try {
      const target = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (typeof target === 'function') return target(command, payload);
    } catch (_) {}
    return Promise.resolve();
  };
  const readState = () => {
    try { return JSON.parse(sessionStorage.getItem(key) || 'null') || { entries: [], index: -1 }; }
    catch (_) { return { entries: [], index: -1 }; }
  };
  const report = (extra) => {
    try {
      const s = readState();
      invoke('report_catalog_state', { state: Object.assign({
        url: location.href,
        title: (document.title || '').slice(0, 200),
        loading: false,
        canGoBack: s.index > 0,
        canGoForward: s.index >= 0 && s.index < s.entries.length - 1
      }, extra || {}) });
    } catch (_) {}
  };
  const save = (s) => { try { sessionStorage.setItem(key, JSON.stringify(s)); } catch (_) {} };
  let state = readState();
  const current = location.href;
  if (!Array.isArray(state.entries) || state.index < 0) state = { entries: [current], index: 0 };
  else if (state.entries[state.index] !== current) {
    const at = state.entries.indexOf(current);
    if (at >= 0) state.index = at;
    else { state.entries = state.entries.slice(0, state.index + 1).concat(current); state.index = state.entries.length - 1; }
  }
  save(state);
  const track = (next) => {
    state.entries = state.entries.slice(0, state.index + 1).concat(next);
    state.index = state.entries.length - 1;
    save(state); report();
  };
  const push = history.pushState.bind(history);
  history.pushState = (...a) => { const r = push(...a); track(location.href); return r; };
  const replace = history.replaceState.bind(history);
  history.replaceState = (...a) => { const r = replace(...a); state.entries[state.index] = location.href; save(state); report(); return r; };
  addEventListener('popstate', () => {
    const at = state.entries.indexOf(location.href);
    if (at >= 0) state.index = at; else track(location.href);
    save(state); report();
  });
  try { new MutationObserver(() => report()).observe(document.querySelector('title') || document.head, { childList: true, subtree: true, characterData: true }); } catch (_) {}
  const who = () => {
    fetch('/api/changelog/latest').then((r) => r.json()).then((j) => report({ news: j })).catch(() => {});
    fetch('/api/auth/me', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        const u = j && j.user;
        report({ account: u ? {
          username: u.username,
          displayName: u.displayName || null,
          avatarUrl: u.avatarUrl || null,
          supporter: !!(u.isSupporter || (Array.isArray(u.perks) && u.perks.indexOf('ad_free') >= 0)),
          appearance: {
            palette: u.appearancePalette || null,
            radius: u.appearanceRadius || null,
            typeface: u.appearanceTypeface || null,
            nsfwBlur: u.appearanceNsfwBlur !== false,
            motion: u.appearanceMotion || null
          }
        } : null });
        if (!u) return;
        fetch('/api/account/library', { credentials: 'include' })
          .then((r) => r.json())
          .then((l) => report({ saved: { entries: (l.entries || []).slice(0, 2000) } }))
          .catch(() => {});
        fetch('/api/notifications?limit=8', { credentials: 'include' })
          .then((r) => r.json())
          .then((n) => report({ inbox: { unreadCount: n.unreadCount || 0, notifications: (n.notifications || []).slice(0, 8) } }))
          .catch(() => {});
      })
      .catch(() => {});
  };
  window.__kryoDesktopRefresh = who;
  // kryo.to names a download right before it starts it (the site's
  // game-downloads.tsx): the download can reach the app without the
  // address's #fragment, so this is the context that holds.
  try {
    Object.defineProperty(window, 'kryotoDesktop', {
      value: Object.freeze({
        expectDownload: (slug, title) => invoke('store_expect_download', {
          slug: String(slug || ''),
          title: title ? String(title) : null
        })
      })
    });
  } catch (_) {}
  // The mouse's back and forward buttons: the app's history, not the page's,
  // so they step through the Store and back into the Library like the arrows.
  const side = (e) => { if (e.button === 3 || e.button === 4) { e.preventDefault(); e.stopPropagation(); return true } return false };
  addEventListener('mousedown', side, true);
  addEventListener('mouseup', (e) => { if (side(e)) invoke('store_nav_button', { forward: e.button === 4 }) }, true);
  addEventListener('offline', () => report({ error: 'offline' }));
  report();
  who();
  // Signing in or out happens on a page; look again when one settles.
  setInterval(who, 60000);
  let last = location.pathname;
  setInterval(() => { if (location.pathname !== last) { last = location.pathname; who(); } }, 1500);
})();
"#;

fn open_external_url(url: &str) -> Result<(), String> {
    let parsed: url::Url = url.parse().map_err(|_| "Not a valid address.".to_string())?;
    if !allowed_browser_url(&parsed) {
        return Err(block_reason(&parsed));
    }
    #[cfg(windows)]
    let result = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", parsed.as_str()])
            .creation_flags(0x0800_0000)
            .spawn()
    };
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(parsed.as_str()).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(parsed.as_str()).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

/// Open a link in the system browser.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    open_external_url(&url)
}

/// The game a kryo.to page is showing: its own page (`/game/<slug>`), or the
/// card open on the home and browse boards (`?game=<slug>`), whose modal has
/// its own Download.
fn game_slug(url: &url::Url, settings: &settings::Settings) -> Option<String> {
    if !settings::is_catalog_origin(url, settings) {
        return None;
    }
    let valid = |s: &str| {
        !s.is_empty() && s.len() <= 160 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    };
    let mut parts = url.path_segments()?;
    if parts.next() == Some("game") {
        if let Some(slug) = parts.next().filter(|s| valid(s)) {
            return Some(slug.to_ascii_lowercase());
        }
    }
    url.query_pairs()
        .find(|(k, _)| k == "game")
        .map(|(_, v)| v.into_owned())
        .filter(|s| valid(s))
        .map(|s| s.to_ascii_lowercase())
}

fn download_context(url: &url::Url) -> (Option<String>, Option<String>) {
    let Some(fragment) = url.fragment() else { return (None, None) };
    let fields: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(fragment.as_bytes()).into_owned().collect();
    let slug = fields.get("kryoto-game").filter(|slug| {
        !slug.is_empty() && slug.len() <= 120 && slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    });
    let title = fields.get("kryoto-title").filter(|title| !title.trim().is_empty() && title.len() <= 300);
    (slug.map(|slug| slug.to_ascii_lowercase()), title.cloned())
}

/// Create the Store web view (or move it) inside the main window.
///
/// Built here rather than from JavaScript because the two hooks that make it a
/// client and not a browser tab only exist on the Rust builder: downloads of
/// kryo.to's files are taken over by the Downloads manager, and pop-ups open
/// in the same view (kryo.to) or the system browser (anywhere else).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn store_mount(
    app: tauri::AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: Option<bool>,
    user_agent: Option<String>,
) -> Result<(), String> {
    if let Some(view) = app.get_webview(STORE) {
        view.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        view.set_size(LogicalSize::new(width.max(1.0), height.max(1.0))).map_err(|e| e.to_string())?;
        // Visibility is `store_visible`'s job: a resize while a dialog is up
        // must not bring the page back over it.
        return Ok(());
    }
    let parsed: url::Url = url.parse().map_err(|_| "Not a valid address.".to_string())?;
    let endpoint = settings::catalog_endpoint(&settings::load(&app));
    let parsed = map_catalog_url(parsed, &endpoint)?;
    let window = app.get_window("main").ok_or("The main window is gone.")?;
    let popup_app = app.clone();
    let mut builder = WebviewBuilder::new(STORE, WebviewUrl::External(parsed));
    // The browser's own user agent with the client named on the end, so
    // kryo.to can tell it is inside Kryoto Desktop: it drops the navigation
    // the client already has, and a phone approving a sign-in sees
    // "Kryoto Desktop Client" instead of a browser's name.
    if let Some(ua) = user_agent.filter(|u| !u.trim().is_empty() && u.len() < 512) {
        let ua = if ua.contains("KryotoDesktop/") { ua } else { format!("{ua} KryotoDesktop/{}", env!("CARGO_PKG_VERSION")) };
        builder = builder.user_agent(&ua);
    }
    let builder = builder
        .transparent(true)
        .on_download(|webview, event| match event {
            DownloadEvent::Requested { url, .. } => {
                let settings = settings::load(webview.app_handle());
                if !downloads::is_ours(&url, &settings) {
                    return true;
                }
                let (slug, title) = download_game(webview.app_handle(), &url, webview.url().ok(), &settings);
                let mut clean_url = url;
                clean_url.set_fragment(None);
                downloads::enqueue(webview.app_handle(), clean_url.to_string(), slug, title);
                false
            }
            _ => true,
        })
        .on_new_window(move |url, _features| {
            let endpoint = settings::catalog_endpoint(&settings::load(&popup_app));
            let url = match map_catalog_url(url.clone(), &endpoint) {
                Ok(url) => url,
                Err(error) => {
                    let _ = popup_app.emit(
                        "browser-error",
                        BrowserErrorEvent { url: url.to_string(), reason: error },
                    );
                    return NewWindowResponse::Deny;
                }
            };
            if is_kryoto(&url, &popup_app) {
                if let Some(view) = popup_app.get_webview(STORE) {
                    let _ = view.navigate(url);
                }
            } else if allowed_browser_url(&url) {
                let _ = open_external_url(url.as_str());
            }
            NewWindowResponse::Deny
        });
    let view = window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(|e| e.to_string())?;
    if visible == Some(false) {
        let _ = view.hide();
    }
    #[cfg(windows)]
    allow_repeat_downloads(&view, settings::load(&app));
    Ok(())
}

/// kryo.to starts a download once its check has passed, which is no longer the
/// click itself. Chromium lets a page do that once; after that it asks before
/// every further download, and WebView2 has nowhere to ask, so the second game
/// of a session never arrived. kryo.to pages may; nothing else is let through.
#[cfg(windows)]
fn allow_repeat_downloads(view: &tauri::Webview, settings: settings::Settings) {
    let _ = view.with_webview(|w| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use webview2_com::PermissionRequestedEventHandler;
        let Ok(core) = w.controller().CoreWebView2() else { return };
        let handler = PermissionRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind)?;
            if kind != COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS {
                return Ok(());
            }
            let mut uri = windows::core::PWSTR::null();
            args.Uri(&mut uri)?;
            let uri = webview2_com::take_pwstr(uri);
            if uri
                .parse::<url::Url>()
                .is_ok_and(|u| downloads::is_ours(&u, &settings))
            {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
            }
            Ok(())
        }));
        let mut token = Default::default();
        let _ = core.add_PermissionRequested(&handler, &mut token);
    });
}

#[tauri::command]
fn store_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    let Some(view) = app.get_webview(STORE) else { return Ok(()) };
    if visible { view.show() } else { view.hide() }.map_err(|e| e.to_string())?;
    if visible {
        let _ = view.set_focus();
    }
    Ok(())
}

/// A mouse back/forward button pressed in the Store: the shell steps its one
/// history, as its arrows do.
#[tauri::command]
fn store_nav_button(app: tauri::AppHandle, forward: bool) {
    let _ = app.emit_to("main", "nav-button", forward);
}

/// kryo.to is about to start a download: which game it is. Sent by the page
/// (`window.kryotoDesktop.expectDownload`, from BROWSER_STATE_SCRIPT) right
/// before it navigates to the file. Only a kryo.to page in the Store may say.
#[tauri::command]
fn store_expect_download(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    slug: String,
    title: Option<String>,
) -> Result<(), String> {
    if webview.label() != STORE {
        return Err("Only the Store names its downloads.".into());
    }
    let page = webview.url().map_err(|e| e.to_string())?;
    if !is_kryoto(&page, &app) {
        return Err("Only kryo.to names its downloads.".into());
    }
    let slug = slug.trim().to_ascii_lowercase();
    if slug.is_empty() || slug.len() > 160 || !slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Not a kryo.to game.".into());
    }
    let title = title
        .map(|t| t.trim().chars().filter(|c| !c.is_control()).take(300).collect::<String>())
        .filter(|t| !t.is_empty());
    let state = app.state::<PendingDownload>();
    let mut pending = state.0.lock().map_err(|_| "busy".to_string())?;
    *pending = Some(ExpectedDownload { slug, title, at: std::time::Instant::now() });
    Ok(())
}

/// Kryoto path shortcut (menus, tabs). Path-only, same origin.
#[tauri::command]
fn navigate_catalog(app: tauri::AppHandle, path: String) -> Result<(), String> {
    if !path.starts_with('/') || path.contains("://") || path.contains('\\') {
        return Err("Invalid catalog path".to_string());
    }
    let endpoint = settings::catalog_endpoint(&settings::load(&app));
    browser_navigate(app, format!("{endpoint}{path}"))
}

/// Address-bar navigation. Only http(s) without credentials.
#[tauri::command]
fn browser_navigate(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed: url::Url = url.trim().parse().map_err(|_| "That address is not a valid URL.".to_string())?;
    if !allowed_browser_url(&parsed) {
        return Err(block_reason(&parsed));
    }
    if !parsed.username().is_empty() {
        return Err("Addresses with embedded credentials are blocked.".to_string());
    }
    let endpoint = settings::catalog_endpoint(&settings::load(&app));
    store(&app)?.navigate(map_catalog_url(parsed, &endpoint)?).map_err(|e| e.to_string())
}

#[tauri::command]
fn report_catalog_state(app: tauri::AppHandle, state: BrowserReport) -> Result<(), String> {
    let view = store(&app)?;
    let actual = view.url().map_err(|e| e.to_string())?;
    // Only kryo.to itself may say who is signed in, or what is in their inbox.
    if is_kryoto(&actual, &app) {
        if let Some(account) = state.account {
            logging::set_account(account.as_ref().map(|a| a.username.clone()));
            let _ = app.emit("account-state", account);
        }
        if let Some(inbox) = state.inbox {
            let _ = app.emit("inbox-state", inbox);
        }
        if let Some(news) = state.news {
            let _ = app.emit("news-state", news);
        }
        if let Some(saved) = state.saved {
            let _ = app.emit("saved-state", saved);
        }
    }
    let error = state.error.map(|v| v.trim().to_string()).filter(|v| !v.is_empty() && v != "offline");
    emit_state(
        &app,
        BrowserState {
            url: actual.to_string(),
            title: state.title.unwrap_or_default(),
            loading: state.loading,
            can_go_back: state.can_go_back,
            can_go_forward: state.can_go_forward,
            error,
        },
    );
    Ok(())
}

/// Sign out of kryo.to in the Store (its logout is a POST, not a page).
#[tauri::command]
fn store_sign_out(app: tauri::AppHandle) -> Result<(), String> {
    let view = store(&app)?;
    if !view.url().map(|u| is_kryoto(&u, &app)).unwrap_or(false) {
        let endpoint = settings::catalog_endpoint(&settings::load(&app));
        view.navigate(format!("{endpoint}/").parse().map_err(|e: url::ParseError| e.to_string())?)
            .map_err(|e| e.to_string())?;
        return Err("Open kryo.to first, then sign out.".into());
    }
    view.eval("fetch('/api/auth/logout',{method:'POST',credentials:'include'}).finally(()=>{location.href='/'})")
        .map_err(|e| e.to_string())
}

/// Mark every kryo.to notification read, then have the page report again.
#[tauri::command]
fn store_mark_read(app: tauri::AppHandle) -> Result<(), String> {
    let view = store(&app)?;
    if !view.url().map(|u| is_kryoto(&u, &app)).unwrap_or(false) {
        return Err("Open kryo.to first.".into());
    }
    view.eval(
        "fetch('/api/notifications',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({all:true})}).finally(()=>window.__kryoDesktopRefresh&&window.__kryoDesktopRefresh())",
    )
    .map_err(|e| e.to_string())
}

/// Set a game's status in the account's kryo.to library (`playing`, `plan`,
/// `completed`, `onhold`, `dropped`, `favorite`), or take it out with `None`.
/// Runs in the Store's page, with the session the player signed in with.
#[tauri::command]
fn store_set_status(
    app: tauri::AppHandle,
    slug: String,
    status: Option<String>,
    title: Option<String>,
    cover: Option<String>,
) -> Result<(), String> {
    const STATUSES: [&str; 6] = ["playing", "plan", "completed", "onhold", "dropped", "favorite"];
    if slug.is_empty() || !slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Not a kryo.to game.".into());
    }
    if status.as_deref().is_some_and(|s| !STATUSES.contains(&s)) {
        return Err("Not a library status.".into());
    }
    let view = store(&app)?;
    if !view.url().map(|u| is_kryoto(&u, &app)).unwrap_or(false) {
        return Err("Open kryo.to first.".into());
    }
    let call = match status {
        Some(s) => {
            let body = serde_json::json!({
                "slug": slug,
                "status": s,
                "title": title.unwrap_or_default(),
                "cover": cover.unwrap_or_default(),
            })
            .to_string();
            let body = serde_json::to_string(&body).map_err(|e| e.to_string())?;
            format!(
                "fetch('/api/account/library',{{method:'PUT',credentials:'include',headers:{{'content-type':'application/json'}},body:{body}}})"
            )
        }
        None => format!("fetch('/api/account/library?slug={slug}',{{method:'DELETE',credentials:'include'}})"),
    };
    view.eval(format!("{call}.finally(()=>window.__kryoDesktopRefresh&&window.__kryoDesktopRefresh())"))
        .map_err(|e| e.to_string())
}

/// A game closed: add the session to the account's play time on kryo.to
/// (community statistics, the play-time board). Sent from the Store's page
/// with the player's own session. `key` makes a retried report count once.
#[tauri::command]
fn store_report_play(app: tauri::AppHandle, slug: String, started_at: u64, seconds: u64, key: String) -> Result<(), String> {
    if slug.is_empty() || !slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Not a kryo.to game.".into());
    }
    if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') || seconds == 0 {
        return Err("Not a play session.".into());
    }
    let view = store(&app)?;
    if !view.url().map(|u| is_kryoto(&u, &app)).unwrap_or(false) {
        return Err("Open kryo.to first.".into());
    }
    view.eval(format!(
        "fetch('/api/desktop/playtime',{{method:'POST',credentials:'include',headers:{{'content-type':'application/json'}},body:JSON.stringify({{slug:'{slug}',startedAt:{started_at},seconds:{seconds},sessionKey:'{key}'}})}}).catch(()=>{{}})"
    ))
    .map_err(|e| e.to_string())
}

/// Ask the page to say again who is signed in and what is new.
#[tauri::command]
fn store_refresh_account(app: tauri::AppHandle) -> Result<(), String> {
    store(&app)?
        .eval("window.__kryoDesktopRefresh&&window.__kryoDesktopRefresh()")
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn catalog_url(app: tauri::AppHandle) -> Result<String, String> {
    Ok(store(&app)?.url().map_err(|e| e.to_string())?.to_string())
}

#[tauri::command]
fn control_catalog(app: tauri::AppHandle, action: String) -> Result<(), String> {
    let script = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        "stop" => "window.stop()",
        _ => return Err("Invalid catalog action".to_string()),
    };
    store(&app)?.eval(script).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let instance = system::claim_instance();
    if matches!(instance, system::Instance::AlreadyRunning) {
        // The copy already running has been asked to come to the front.
        return;
    }
    let to_tray = std::env::args().any(|a| a == "--tray");
    // Started by a `kryoto://` link: the shell takes it once it is ready.
    if let Some(link) = links::from_args() {
        links::set_pending(&link);
    }
    let mut listener = match instance {
        system::Instance::First(l) => Some(l),
        _ => None,
    };
    tauri::Builder::default()
        .manage(library::Running::default())
        .manage(downloads::Downloads::new())
        .manage(storage::Moving::default())
        .manage(system::Popup::default())
        .manage(PendingDownload::default())
        .setup(move |app| {
            logging::init(app.handle());
            logging::start_reporter(app.handle().clone());
            // Off the main thread: registry and xdg-mime are not worth a frame.
            std::thread::spawn(links::register);
            downloads::init(app.handle());
            if let Some(l) = listener.take() {
                system::serve_instance(app.handle().clone(), l);
            }
            if let Err(e) = system::build_tray(app.handle()) {
                logging::error("tray", &e.to_string());
            }
            if let Some(main) = app.get_window("main") {
                system::round_corners(&main, false);
                if !to_tray {
                    let _ = main.show();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                system::on_main_window_event(window, event);
            }
        })
        .plugin(
            PluginBuilder::<tauri::Wry, ()>::new("catalog-policy")
                .on_navigation(|webview, url| {
                    if webview.label() != STORE {
                        return true;
                    }
                    if allowed_browser_url(url) {
                        let settings = settings::load(webview.app_handle());
                        let endpoint = settings::catalog_endpoint(&settings);
                        match map_catalog_url(url.clone(), &endpoint) {
                            Ok(mapped) if mapped != *url => {
                                if let Err(error) = webview.navigate(mapped) {
                                    let _ = webview.app_handle().emit(
                                        "browser-error",
                                        BrowserErrorEvent {
                                            url: url.to_string(),
                                            reason: error.to_string(),
                                        },
                                    );
                                }
                                return false;
                            }
                            Ok(_) => return true,
                            Err(error) => {
                                let _ = webview.app_handle().emit(
                                    "browser-error",
                                    BrowserErrorEvent {
                                        url: url.to_string(),
                                        reason: error,
                                    },
                                );
                                return false;
                            }
                        }
                    }
                    // kryo.to's "Open in Kryoto Desktop", pressed inside the app.
                    if url.scheme() == links::SCHEME {
                        links::deliver(webview.app_handle(), url.as_str());
                        return false;
                    }
                    let _ = webview.app_handle().emit(
                        "browser-error",
                        BrowserErrorEvent { url: url.to_string(), reason: block_reason(url) },
                    );
                    false
                })
                .build(),
        )
        .on_page_load(|webview, payload| {
            if webview.label() != STORE {
                return;
            }
            let loading = payload.event() == PageLoadEvent::Started;
            emit_state(
                webview.app_handle(),
                BrowserState {
                    url: payload.url().to_string(),
                    title: String::new(),
                    loading,
                    can_go_back: false,
                    can_go_forward: false,
                    error: None,
                },
            );
            if !loading {
                let _ = webview.eval(BROWSER_STATE_SCRIPT);
            }
        })
        .invoke_handler(tauri::generate_handler![
            links::take_pending_link,
            store_mount,
            store_visible,
            store_sign_out,
            store_mark_read,
            store_refresh_account,
            store_set_status,
            store_report_play,
            navigate_catalog,
            browser_navigate,
            report_catalog_state,
            store_nav_button,
            store_expect_download,
            catalog_url,
            control_catalog,
            open_external,
            settings::settings_get,
            settings::settings_save,
            library::library_list,
            library::library_add,
            library::library_save,
            library::library_remove,
            library::game_launch,
            library::game_launch_preview,
            library::game_running,
            library::game_stop,
            library::game_disk_size,
            library::open_folder,
            downloads::downloads_list,
            downloads::download_pause,
            downloads::download_resume,
            downloads::download_cancel,
            downloads::download_remove,
            compat::compat_tools,
            addons::addon_undo,
            online::online_check,
            online::online_apply,
            online::online_undo,
            storage::storage_overview,
            storage::storage_add_folder,
            storage::storage_remove_folder,
            storage::storage_set_default,
            storage::storage_move,
            logging::log_write,
            logging::logs_tail,
            logging::logs_folder,
            logging::logs_send,
            system::shell_ready,
            system::app_exit,
            system::os_notify,
            system::pick_path,
            system::popup_open,
            system::popup_payload,
            system::popup_ready,
            system::popup_select,
            system::popup_close,
            system::popup_hover
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kryoto Desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every command the shell can call must be allowed for its window, or
    /// Tauri refuses it at runtime with "Command not found" - which is how
    /// every call in 0.1 and the first 0.2 build failed while every Rust test
    /// passed.
    #[test]
    fn every_command_is_allowed_for_the_shell() {
        let src = include_str!("lib.rs");
        let start = src.find("generate_handler![").unwrap() + "generate_handler![".len();
        let end = start + src[start..].find(']').unwrap();
        let allowed = format!("{}{}", include_str!("../permissions/shell.toml"), include_str!("../permissions/catalog.toml"));
        let missing: Vec<&str> = src[start..end]
            .split(',')
            .map(|c| c.trim().rsplit("::").next().unwrap_or("").trim())
            .filter(|c| !c.is_empty())
            .filter(|c| !allowed.contains(&format!("\"{c}\"")))
            .collect();
        assert!(missing.is_empty(), "add to permissions/shell.toml: {missing:?}");
    }

    /// A plugin's page script runs in every frame of every web view, the Store's
    /// kryo.to pages and Cloudflare's challenge frame included. The notification
    /// plugin's replaced `window.Notification` and every download failed its
    /// Turnstile check. A new plugin has to be checked for that first.
    #[test]
    fn no_plugin_touches_the_store_pages() {
        let toml = include_str!("../Cargo.toml");
        let plugins: Vec<&str> = toml.lines().filter(|l| l.trim_start().starts_with("tauri-plugin-")).collect();
        let checked: [&str; 0] = []; // none yet
        let unchecked: Vec<&&str> = plugins.iter().filter(|l| !checked.iter().any(|c| l.trim_start().starts_with(c))).collect();
        assert!(unchecked.is_empty(), "check these add no page script, then list them here: {unchecked:?}");
    }

    #[test]
    fn game_pages_give_their_slug() {
        let u = |s: &str| s.parse::<url::Url>().unwrap();
        let settings = settings::Settings::default();
        assert_eq!(
            game_slug(&u("https://kryo.to/game/captain-hardcore?download=1"), &settings).as_deref(),
            Some("captain-hardcore")
        );
        assert_eq!(game_slug(&u("https://kryo.to/browse"), &settings), None);
        assert_eq!(game_slug(&u("https://evil.example/game/x"), &settings), None);
        // The canvas modal on the home and browse boards.
        assert_eq!(game_slug(&u("https://kryo.to/?game=hades-ii"), &settings).as_deref(), Some("hades-ii"));
        assert_eq!(game_slug(&u("https://kryo.to/browse?q=x&game=Hades-II"), &settings).as_deref(), Some("hades-ii"));
        assert_eq!(game_slug(&u("https://kryo.to/?game=../x"), &settings), None);
        assert_eq!(game_slug(&u("https://evil.example/?game=x"), &settings), None);
    }

    #[test]
    fn canvas_download_context_carries_slug_and_title_without_changing_the_file_url() {
        let mut url: url::Url =
            "https://dl.kryo.to/d/signed#kryoto-game=chinese-street-food-legend&kryoto-title=Chinese+Street+Food+Legend"
                .parse()
                .unwrap();
        assert_eq!(
            download_context(&url),
            (Some("chinese-street-food-legend".into()), Some("Chinese Street Food Legend".into()))
        );
        url.set_fragment(None);
        assert_eq!(url.as_str(), "https://dl.kryo.to/d/signed");
    }

    /// The canvas modal's download used to arrive as "Download": WebView2
    /// hands the download over without the address's fragment. What the page
    /// announced fills in, and never overrides a fragment about another game.
    #[test]
    fn a_download_is_named_by_what_the_page_announced() {
        let expected = |slug: &str| ExpectedDownload {
            slug: slug.into(),
            title: Some("Hades II".into()),
            at: std::time::Instant::now(),
        };
        assert_eq!(
            merge_download_context((None, None), Some(expected("hades-ii")), None),
            (Some("hades-ii".into()), Some("Hades II".into()))
        );
        assert_eq!(
            merge_download_context((Some("celeste".into()), None), Some(expected("hades-ii")), None),
            (Some("celeste".into()), None)
        );
        assert_eq!(
            merge_download_context((None, None), None, Some("celeste".into())),
            (Some("celeste".into()), None)
        );
    }

    #[test]
    fn production_catalog_links_map_to_custom_endpoint() {
        let original: url::Url = "https://kryo.to/login?next=/".parse().unwrap();
        let mapped = map_catalog_url(original, "http://localhost:3000").unwrap();
        assert_eq!(mapped.as_str(), "http://localhost:3000/login?next=/");
    }

    #[test]
    fn a_signed_out_report_is_not_a_missing_one() {
        let out: BrowserReport = serde_json::from_str(r#"{"url":"x","loading":false,"account":null}"#).unwrap();
        assert!(matches!(out.account, Some(None)));
        let none: BrowserReport = serde_json::from_str(r#"{"url":"x","loading":false}"#).unwrap();
        assert!(none.account.is_none());
    }
}
