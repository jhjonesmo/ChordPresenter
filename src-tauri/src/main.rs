// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use chrono::Local;
use tauri::{CustomMenuItem, Manager, Menu, MenuItem, Submenu};

// ── Logging ───────────────────────────────────────────────────────────────────

fn log_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path_resolver().app_log_dir()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn log_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    log_dir(app).map(|d| d.join("chordpresenter.log"))
}

fn log(app: &tauri::AppHandle, tag: &str, message: &str) {
    let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S");
    let line = format!("[{}] [{}] {}\n", timestamp, tag, message);

    // Always print to stderr in dev mode for quick feedback
    eprint!("{}", line);

    if let Some(path) = log_path(app) {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

#[tauri::command]
fn get_log_path(app: tauri::AppHandle) -> String {
    log_path(&app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[tauri::command]
fn get_recent_logs(app: tauri::AppHandle) -> String {
    if let Some(path) = log_path(&app) {
        std::fs::read_to_string(&path).unwrap_or_default()
    } else {
        String::new()
    }
}

#[tauri::command]
fn clear_log(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(path) = log_path(&app) {
        std::fs::write(&path, "").map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Config ────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
struct Config {
    output_dir: String,
}

fn config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home)
        .join(".config")
        .join("chordpresenter")
        .join("config.json")
}

fn load_config() -> Config {
    let path = config_path();
    if path.exists() {
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&text).unwrap_or_default()
    } else {
        Config::default()
    }
}

#[tauri::command]
fn get_config() -> Config {
    load_config()
}

#[tauri::command]
fn save_config(output_dir: String) -> Result<(), String> {
    let config = Config { output_dir };
    let path = config_path();
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Bundled script resolution ──────────────────────────────────────────────────

/// Resolve the path to a Python script.
///
/// Dev mode  (`pnpm tauri dev`):
///   Uses CARGO_MANIFEST_DIR (src-tauri/) → ../scripts/<name>
///   i.e. the live source files in ChordPresenter/scripts/ — no copy needed.
///
/// Production (`pnpm tauri build`):
///   Uses app.path_resolver().resolve_resource() which maps to
///   <App>.app/Contents/Resources/<name> — the bundled copies.
fn script_path(app: &tauri::AppHandle, name: &str) -> Result<String, String> {
    #[cfg(debug_assertions)]
    {
        // CARGO_MANIFEST_DIR = .../ChordPresenter/src-tauri
        // parent()           = .../ChordPresenter
        // join("scripts")    = .../ChordPresenter/scripts
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let path = manifest
            .parent()
            .unwrap_or(manifest)
            .join("scripts")
            .join(name);

        if path.exists() {
            return Ok(path.to_string_lossy().to_string());
        }
        // Fall through to resource resolver if scripts/ not found
    }

    // In the production bundle, resources declared as "../scripts/foo.py" are stored
    // under Contents/Resources/_up_/scripts/foo.py (Tauri maps ".." → "_up_").
    let bundled = format!("_up_/scripts/{}", name);
    app.path_resolver()
        .resolve_resource(&bundled)
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| format!("Bundled script not found: {}", bundled))
}

// ── Subprocess helper ─────────────────────────────────────────────────────────

struct RunResult {
    stdout: String,
    stderr: String,
    success: bool,
}

fn run_python(app: &tauri::AppHandle, mut cmd: Command, label: &str) -> Result<String, String> {
    log(app, "RUN", &format!("{}: {:?}", label, cmd));
    let output = cmd.output().map_err(|e| {
        let msg = format!("Could not launch python3: {}", e);
        log(app, "ERROR", &msg);
        msg
    })?;

    let result = RunResult {
        stdout:  String::from_utf8_lossy(&output.stdout).to_string(),
        stderr:  String::from_utf8_lossy(&output.stderr).to_string(),
        success: output.status.success(),
    };

    if !result.stdout.trim().is_empty() {
        log(app, "OUT", result.stdout.trim());
    }
    if !result.stderr.trim().is_empty() {
        log(app, if result.success { "WARN" } else { "ERROR" }, result.stderr.trim());
    }

    if result.success {
        Ok(result.stdout)
    } else {
        Err(format!("{}\n{}", result.stderr.trim(), result.stdout.trim()))
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn run_conversion(
    app: tauri::AppHandle,
    md_path: String,
    target_key: Option<String>,
    output_dir: String,
    lyrics_only: Option<bool>,
) -> Result<String, String> {
    let script = script_path(&app, "md_to_pro.py")?;
    let mut cmd = Command::new("python3");
    cmd.arg(&script).arg(&md_path);

    if let Some(ref key) = target_key {
        let k = key.trim();
        if !k.is_empty() { cmd.arg("--key").arg(k); }
    }
    if !output_dir.trim().is_empty() {
        cmd.arg("--out").arg(output_dir.trim());
    }
    if lyrics_only.unwrap_or(false) {
        cmd.arg("--lyrics-only");
    }

    run_python(&app, cmd, "run_conversion")
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if !p.is_absolute() {
        return Err("Path must be absolute".into());
    }
    let canonical = p.canonicalize().map_err(|e| format!("Invalid path: {}", e))?;
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() || !canonical.starts_with(&home) {
        return Err("Path is outside the home directory".into());
    }
    std::fs::read_to_string(&canonical).map_err(|e| format!("Could not read file: {}", e))
}

#[tauri::command]
fn fetch_ew_preview(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let u = url.trim();
    if !u.starts_with("http://") && !u.starts_with("https://") {
        return Err("URL must start with http:// or https://".into());
    }
    let script = script_path(&app, "ew_fetch.py")?;
    let mut cmd = Command::new("python3");
    cmd.arg(&script).arg("--url").arg(u).arg("--preview");
    run_python(&app, cmd, "fetch_ew_preview")
        .map(|s| s.trim().to_string())
}

#[tauri::command]
fn generate_from_url(
    app: tauri::AppHandle,
    title: String,
    artist: String,
    chart_text: String,
    target_key: Option<String>,
    output_dir: String,
    lyrics_only: Option<bool>,
) -> Result<String, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let tmp_path = format!("/tmp/chordpresenter_ew_{}.txt", ts);

    std::fs::write(&tmp_path, &chart_text)
        .map_err(|e| format!("Could not write temp file: {}", e))?;

    let script = script_path(&app, "ew_fetch.py")?;
    let mut cmd = Command::new("python3");
    cmd.arg(&script)
        .arg("--chart-file").arg(&tmp_path)
        .arg("--title").arg(&title)
        .arg("--artist").arg(&artist);

    if let Some(ref key) = target_key {
        let k = key.trim();
        if !k.is_empty() { cmd.arg("--key").arg(k); }
    }
    if !output_dir.trim().is_empty() {
        cmd.arg("--out").arg(output_dir.trim());
    }
    if lyrics_only.unwrap_or(false) {
        cmd.arg("--lyrics-only");
    }

    let result = run_python(&app, cmd, "generate_from_url");
    let _ = std::fs::remove_file(&tmp_path);
    result
}

// ── Menu ──────────────────────────────────────────────────────────────────────

fn create_menu() -> Menu {
    let preferences = CustomMenuItem::new("preferences", "Preferences…")
        .accelerator("CmdOrCtrl+,");
    let open_log = CustomMenuItem::new("open_log", "Open Log File");

    let app_menu = Submenu::new(
        "ChordPresenter",
        Menu::new()
            .add_item(preferences)
            .add_native_item(MenuItem::Separator)
            .add_item(open_log)
            .add_native_item(MenuItem::Separator)
            .add_native_item(MenuItem::Hide)
            .add_native_item(MenuItem::HideOthers)
            .add_native_item(MenuItem::ShowAll)
            .add_native_item(MenuItem::Separator)
            .add_native_item(MenuItem::Quit),
    );

    let edit_menu = Submenu::new(
        "Edit",
        Menu::new()
            .add_native_item(MenuItem::Undo)
            .add_native_item(MenuItem::Redo)
            .add_native_item(MenuItem::Separator)
            .add_native_item(MenuItem::Cut)
            .add_native_item(MenuItem::Copy)
            .add_native_item(MenuItem::Paste)
            .add_native_item(MenuItem::SelectAll),
    );

    Menu::new()
        .add_submenu(app_menu)
        .add_submenu(edit_menu)
}

fn main() {
    tauri::Builder::default()
        .menu(create_menu())
        .on_menu_event(|event| {
            match event.menu_item_id() {
                "preferences" => {
                    event.window().emit("open-preferences", ()).unwrap();
                }
                "open_log" => {
                    let app = event.window().app_handle();
                    if let Some(path) = log_path(&app) {
                        // Create the file if it doesn't exist yet
                        if !path.exists() {
                            let _ = std::fs::write(&path, "");
                        }
                        tauri::api::shell::open(
                            &app.shell_scope(),
                            path.to_string_lossy().to_string(),
                            None,
                        ).ok();
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            run_conversion,
            read_file,
            fetch_ew_preview,
            generate_from_url,
            get_config,
            save_config,
            get_log_path,
            get_recent_logs,
            clear_log,
        ])
        .setup(|app| {
            // Log startup
            let handle = app.handle();
            log(&handle, "START", &format!(
                "ChordPresenter started — log: {}",
                log_path(&handle).map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
            ));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
