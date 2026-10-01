//! Following a game past its launcher.
//!
//! Plenty of games start, hand over to another process and exit with code 0
//! within a second or two: a launcher that starts the real exe, a game that
//! restarts itself, a stub that re-executes under a different name. The client
//! watched only the process it started, so it said "It closed again straight
//! away" while the game was running fine (the most reported error of 0.2.3,
//! over 300 times) and counted no playtime for it.
//!
//! So when the started process ends quickly, this looks for a process running
//! from the game's folder - by its executable, or under Wine and Proton by its
//! command line - and follows that one instead.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

/// A first process that lived less than this may have handed over.
pub const HANDOFF_WITHIN_SECS: u64 = 15;
/// How long to look for the process it handed over to.
const LOOK_FOR: Duration = Duration::from_secs(20);

fn normalise(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    if cfg!(windows) { s.to_lowercase() } else { s }
}

fn snapshot() -> System {
    System::new_with_specifics(
        RefreshKind::nothing().with_processes(
            ProcessRefreshKind::nothing()
                .with_exe(sysinfo::UpdateKind::Always)
                .with_cmd(sysinfo::UpdateKind::Always),
        ),
    )
}

/// A process (other than `not`) running out of `dir`, if there is one.
pub fn find_in_folder(dir: &Path, not: u32) -> Option<u32> {
    let root = normalise(dir);
    if root.len() < 4 {
        // A drive root or an empty path would match everything.
        return None;
    }
    let root = format!("{}/", root.trim_end_matches('/'));
    let sys = snapshot();
    sys.processes().iter().find_map(|(pid, p)| {
        let pid = pid.as_u32();
        if pid == not || pid == std::process::id() {
            return None;
        }
        let by_exe = p.exe().map(|e| normalise(e).starts_with(&root)).unwrap_or(false);
        let by_cmd = || {
            p.cmd()
                .iter()
                .any(|a| normalise(&PathBuf::from(a)).starts_with(&root))
        };
        (by_exe || by_cmd()).then_some(pid)
    })
}

/// Look for the process a quick exit handed over to, for a while.
pub fn look_for(dir: &Path, not: u32) -> Option<u32> {
    let until = Instant::now() + LOOK_FOR;
    while Instant::now() < until {
        if let Some(pid) = find_in_folder(dir, not) {
            return Some(pid);
        }
        std::thread::sleep(Duration::from_millis(750));
    }
    None
}

/// Block until `pid` is gone. Polls: a process we did not start cannot be waited on.
pub fn wait_gone(pid: u32) {
    let pid = Pid::from_u32(pid);
    let mut sys = System::new();
    loop {
        sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
        if sys.process(pid).is_none() {
            return;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}
