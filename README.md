<p align="center"><img src="docs/logo.png" width="96" alt="Kryoto Desktop"></p>

# Kryoto Desktop

kryo.to as an app: the store, your games, and downloads that install themselves.

![Library](docs/screenshots/library.png)

| | |
|---|---|
| ![Start](docs/screenshots/splash.png) | ![Sign in](docs/screenshots/welcome.png) |
| ![Game](docs/screenshots/game.png) | ![Downloads](docs/screenshots/downloads.png) |
| ![Storage](docs/screenshots/storage.png) | ![Community](docs/screenshots/community.png) |

## Run it

```text
pnpm install
pnpm app:dev      # the app
pnpm dev          # the UI alone in a browser, on sample data (http://localhost:1421)
pnpm app:build    # the installer (NSIS on Windows, AppImage/.deb on Linux)
```

Debug builds run as `to.kryo.desktop.dev`, next to an installed copy without
sharing its data, and never send error reports.

## Where things are

| | |
|---|---|
| `src-tauri/src/lib.rs` | the Store web view, what kryo.to reports (account, inbox, lists), commands |
| `src-tauri/src/downloads.rs` | taking over kryo.to downloads, resume, space checks, unpacking, install |
| `src-tauri/src/launch.rs` | what Play runs: Steam launch entries, launch options, Wine/Proton |
| `src-tauri/src/library.rs` | `library.json`, play/stop, play time, uninstall |
| `src-tauri/src/storage.rs` | library folders, drive space, moving games between drives |
| `src-tauri/src/system.rs` | tray, single instance, start with Windows, the pop-up menu window |
| `src-tauri/src/logging.rs` | the log file, crash capture, reports to kryo.to |
| `src/boot` | the start box and sign-in |
| `src/shell`, `src/library`, `src/downloads`, `src/settings`, `src/community`, `src/friends` | the app |
| `src/ui/ascii` | the K// mark (traced from kryo.to's) and the block lettering, as vectors |
| `scripts/brand.mjs` | icons and installer art, generated from the same code |

## Tests

```text
pnpm build                   # typecheck + build the UI
cd src-tauri && cargo test
```

`KRYOTO_STAND_IN=<folder with "Captain Hardcore.exe"> cargo test -- --ignored`
also starts a real process the way Play does, against a stand-in that writes
its arguments to `launch-log.txt`.

Changes are listed in kryo.to's changelog; this app has none of its own.
