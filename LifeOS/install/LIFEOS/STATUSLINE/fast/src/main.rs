//! statusline-fast: the replay half of the LifeOS statusline, as a compiled binary.
//!
//! Claude Code re-runs the statusline every few seconds. Most of those runs change nothing: the transcript has not moved
//! since the last frame, no wake input (fast/wake) has either, the pane is the same size, and the frame is under
//! 30 seconds old, so `Admission.enter()` in
//! Render.ts replays the cached frame. In Bun that replay still costs ~55 ms, nearly all of it process boot and module
//! load. This binary makes the same replay decision from the same files in about a millisecond and prints the same bytes.
//! Anything it is not certain about (a sweep or capture due, an odd payload or env, no fresh frame) goes to Render.ts
//! unchanged, with the stdin it read handed on, so the TypeScript renderer stays the one implementation of every row.
//!
//! Usage (from LIFEOS_StatusLine.sh): statusline-fast <bun> <Render.ts>

use std::env;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

/// Replay window, in seconds: Admission.ts replays a frame younger than this.
const REPLAY_SECONDS: i64 = 30;
/// Cache.sweepDaily() runs before the replay check once this long has passed since `.swept`.
const SWEEP_SECONDS: i64 = 86_400;

/// `Math.floor(statSync(path).mtimeMs / 1000)`, or 0 when the path cannot be read (Cache.ts `mtime`).
fn mtime(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// An env var as text: None when unset, Err when not valid Unicode (Bun would read it differently, so we hand off).
fn var(name: &str) -> Result<Option<String>, ()> {
    match env::var(name) {
        Ok(v) => Ok(Some(v)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => Err(()),
    }
}

/// The cache directory State.ts uses: $XDG_CACHE_HOME or $HOME/.cache, then lifeos-statusline. None for a root Bun would
/// read differently (relative, dot segments, which path.join normalizes and Path::join does not).
fn cache_root() -> Option<PathBuf> {
    let base = match var("XDG_CACHE_HOME").ok()? {
        Some(x) if !x.is_empty() => x,
        _ => format!("{}/.cache", var("HOME").ok()?.filter(|h| !h.is_empty())?),
    };
    if !base.starts_with('/') || base.split('/').any(|c| c == "." || c == "..") {
        return None;
    }
    Some(Path::new(&base).join("lifeos-statusline"))
}

/// A plain absolute path with no dot segments, the only kind Path::join treats as path.join does.
fn plain_absolute(p: &str) -> bool {
    p.starts_with('/') && !p.split('/').any(|c| c == "." || c == "..")
}

/// The LifeOS root as State.ts resolves it, for the plain cases only: a set LIFEOS_DIR (already checked plain above), or
/// $HOME/.claude/LIFEOS. None when CLAUDE_CONFIG_DIR or CLAUDE_PLUGIN_ROOT relocates it, so the run hands off to Render.ts.
fn lifeos_root() -> Option<PathBuf> {
    if let Some(dir) = var("LIFEOS_DIR").ok()?.filter(|d| !d.is_empty()) {
        return if plain_absolute(&dir) { Some(PathBuf::from(dir)) } else { None };
    }
    for relocating in ["CLAUDE_CONFIG_DIR", "CLAUDE_PLUGIN_ROOT"] {
        if var(relocating).ok()?.filter(|d| !d.is_empty()).is_some() {
            return None;
        }
    }
    let home = var("HOME").ok()?.filter(|h| plain_absolute(h))?;
    Some(Path::new(&home).join(".claude").join("LIFEOS"))
}

/// A session id fit to name a file under the root: State.ts `SAFE_SESSION`.
fn safe_session(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The wake files for this session, State.ts `wakePaths(root, sessionId, wakeTemplates())`: every line of fast/wake (the
/// file beside this binary's target dir) that is not blank, a comment, absolute or climbing out of the root, under the
/// root, with `<session>` lines skipped when the id cannot name a file. Some(empty) when there are none; None (hand off)
/// when the list cannot be read or the root cannot be resolved here. A new wake input is a line in fast/wake, never a
/// change to this file.
fn wake_paths(session_id: Option<&str>) -> Option<Vec<PathBuf>> {
    let exe = env::current_exe().ok()?;
    let fast_dir = exe.parent()?.parent()?.parent()?; // fast/target/release/statusline-fast -> fast/
    let text = fs::read_to_string(fast_dir.join("wake")).ok()?;
    let templates: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter(|l| !l.starts_with('/') && !l.split('/').any(|c| c == "." || c == ".."))
        .collect();
    if templates.is_empty() {
        return Some(Vec::new());
    }
    let root = lifeos_root()?;
    let id = session_id.filter(|id| safe_session(id));
    Some(
        templates
            .into_iter()
            .filter(|t| id.is_some() || !t.contains("<session>"))
            .map(|t| root.join(t.replace("<session>", id.unwrap_or(""))))
            .collect(),
    )
}

/// The cached frame to replay, or None when Render.ts must run. Mirrors buildState(), render() up to admission, and the
/// first test in Admission.enter(); every branch that is not a plain replay returns None.
fn replay(stdin: &[u8]) -> Option<Vec<u8>> {
    // Render.ts flags (--empty, --section, --no-produce) change what is drawn; the shim passes none.
    if env::args_os().len() != 3 {
        return None;
    }
    // A set LIFEOS_DIR must be a plain absolute path, or buildState() fails closed; expansion cases go to Render.ts.
    if let Some(dir) = var("LIFEOS_DIR").ok()? {
        if !dir.is_empty() && (!dir.starts_with('/') || dir.contains('~') || dir.contains("$HOME") || dir.contains("${HOME}")) {
            return None;
        }
    }
    let input: serde_json::Value = serde_json::from_slice(stdin).ok()?;
    let input = input.as_object()?;
    // session_id: a string, or absent/null ("nosess"); a session that cannot name a file is also "nosess".
    let session_id = match input.get("session_id") {
        Some(serde_json::Value::String(s)) if !s.contains(['/', '\\', '\0']) => Some(s.as_str()),
        _ => None,
    };
    let session = match input.get("session_id") {
        None | Some(serde_json::Value::Null) => "nosess".to_string(),
        Some(serde_json::Value::String(s)) if s.is_empty() || s.contains(['/', '\\', '\0']) => "nosess".to_string(),
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(_) => return None,
    };
    let transcript = match input.get("transcript_path") {
        Some(serde_json::Value::String(s)) if !s.is_empty() => PathBuf::from(s),
        _ => return None,
    };

    let root = cache_root()?;

    // Cache.initialize(): the root exists with mode 0700.
    DirBuilder::new().recursive(true).mode(0o700).create(&root).ok()?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).ok()?;

    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    if now - mtime(&root.join(".swept")) >= SWEEP_SECONDS {
        return None; // the daily sweep is due
    }
    if mtime(&root.join("sl-capture")) != 0 {
        return None; // a stdin capture was requested
    }

    // Admission.enter(): replay when the frame is fresh, the pane unchanged, and the transcript older than the frame.
    let name = format!("render-{session}.out");
    let frame_path = root.join(&name);
    let frame = fs::read(&frame_path).ok()?;
    if frame.is_empty() || std::str::from_utf8(&frame).is_err() {
        return None;
    }
    let or_zero = |v: Option<String>| v.filter(|s| !s.is_empty()).unwrap_or_else(|| "0".to_string());
    let stamp = format!("{}x{}", or_zero(var("COLUMNS").ok()?), or_zero(var("LINES").ok()?));
    if fs::read(root.join(format!("{name}.geom"))).ok()? != stamp.as_bytes() {
        return None;
    }
    let at = mtime(&frame_path);
    let seen = mtime(&transcript);
    // Wake inputs (fast/wake) change between turns while the transcript stays still: any one newer than the frame re-renders.
    let quiet = wake_paths(session_id)?.iter().all(|path| mtime(path) < at);
    if seen > 0 && now - at < REPLAY_SECONDS && seen < at && quiet {
        Some(frame)
    } else {
        None
    }
}

/// Hand the run to Render.ts with the stdin already read: written to an unlinked 0600 file that becomes bun's stdin,
/// then exec, so bun replaces this process and nothing is left running beside it.
fn hand_off(stdin: &[u8]) -> ! {
    let args: Vec<_> = env::args_os().collect();
    if args.len() >= 3 {
        let dir = cache_root().filter(|p| p.is_dir()).unwrap_or_else(env::temp_dir);
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
        let path = dir.join(format!("stdin.tmp.{}.{nanos}", std::process::id()));
        let file = OpenOptions::new().read(true).write(true).create_new(true).mode(0o600).open(&path);
        if let Ok(mut file) = file {
            let ready = file.write_all(stdin).and_then(|_| file.seek(SeekFrom::Start(0)));
            let _ = fs::remove_file(&path);
            if ready.is_ok() {
                let error = Command::new(&args[1]).arg(&args[2]).stdin(Stdio::from(file)).exec();
                eprintln!("statusline-fast: exec failed: {error}");
            }
        }
    }
    // The shim's own last resort when bun cannot run.
    print!("LifeOS\n");
    std::process::exit(0);
}

fn main() {
    let mut stdin = Vec::new();
    if std::io::stdin().read_to_end(&mut stdin).is_err() {
        hand_off(&stdin);
    }
    match replay(&stdin) {
        Some(frame) => {
            let mut out = std::io::stdout().lock();
            let _ = out.write_all(&frame).and_then(|_| out.flush());
        }
        None => hand_off(&stdin),
    }
}
