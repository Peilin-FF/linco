use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde_json::Value;
use tauri::{AppHandle, Manager};

const POWERPOINT_MCP_NAME: &str = "linco-powerpoint-live";
const LEGACY_DRAWIO_MCP_NAME: &str = "linco-drawio-live";

fn descriptor_path() -> Result<PathBuf, String> {
    Ok(PathBuf::from(crate::config::home_dir()?)
        .join(".linco")
        .join("powerpoint-live.json"))
}

#[cfg(target_os = "windows")]
fn integration_source(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let source = resource_dir.join("codex").join("powerpoint-live");
        if source.join("scripts").join("server.mjs").exists() {
            return Ok(source);
        }
    }
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../vendor/HTML-VibeCoding/codex/powerpoint-live");
    if source.join("scripts").join("server.mjs").exists() {
        Ok(source)
    } else {
        Err("PowerPoint Live integration resources are missing".into())
    }
}

#[cfg(target_os = "windows")]
fn monitor_script(app: &AppHandle) -> Result<PathBuf, String> {
    let source = integration_source(app)?;
    let script = source.join("scripts").join("powerpoint-monitor.ps1");
    if script.exists() {
        Ok(script)
    } else {
        Err("PowerPoint Live monitor script is missing".into())
    }
}

#[cfg(target_os = "windows")]
fn copy_dir(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        std::fs::remove_dir_all(destination).map_err(|error| error.to_string())?;
    }
    std::fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for entry in std::fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            copy_dir(&source_path, &destination_path)?;
        } else {
            std::fs::copy(&source_path, &destination_path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn cli_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(target_os = "windows")]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    value.into_owned()
}

fn annotation_output_path(
    presentation_path: &Path,
    slide_index: u32,
    linco_home: &Path,
) -> Result<PathBuf, String> {
    if slide_index == 0 {
        return Err("PowerPoint slide indexes start at 1".into());
    }
    let stem = presentation_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("presentation")
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() || matches!(value, '-' | '_') {
                value
            } else {
                '_'
            }
        })
        .collect::<String>();
    let mut hasher = DefaultHasher::new();
    presentation_path.to_string_lossy().hash(&mut hasher);
    let presentation_hash = hasher.finish();
    Ok(linco_home.join("powerpoint-annotations").join(format!(
        "{stem}-{presentation_hash:016x}-slide-{slide_index:03}-annotation.png"
    )))
}

#[cfg(target_os = "windows")]
fn install_codex_integration(app: &AppHandle) -> Result<(), String> {
    let home = PathBuf::from(crate::config::home_dir()?);

    let mut remove_legacy =
        crate::proc_ext::cli_command("codex", &["mcp", "remove", LEGACY_DRAWIO_MCP_NAME]);
    let _ = remove_legacy.output();
    let legacy_skill = home.join(".codex").join("skills").join("drawio-live");
    if legacy_skill.exists() {
        std::fs::remove_dir_all(&legacy_skill).map_err(|error| error.to_string())?;
    }
    let legacy_descriptor = home.join(".linco").join("drawio-live.json");
    if legacy_descriptor.exists() {
        std::fs::remove_file(&legacy_descriptor).map_err(|error| error.to_string())?;
    }

    let source = integration_source(app)?;
    let skill_source = source.join("skills").join("powerpoint-live");
    if skill_source.exists() {
        copy_dir(
            &skill_source,
            &home.join(".codex").join("skills").join("powerpoint-live"),
        )?;
    }

    let server_arg = cli_path(&source.join("scripts").join("server.mjs"));
    let mut remove = crate::proc_ext::cli_command("codex", &["mcp", "remove", POWERPOINT_MCP_NAME]);
    let _ = remove.output();
    let mut add = crate::proc_ext::cli_command(
        "codex",
        &["mcp", "add", POWERPOINT_MCP_NAME, "--", "node", &server_arg],
    );
    let output = add.output().map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if error.is_empty() {
            "failed to register the PowerPoint Live MCP server".into()
        } else {
            error
        })
    }
}

pub fn prepare(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if let Err(error) = install_codex_integration(&app) {
            eprintln!("PowerPoint Live integration install skipped: {error}");
        }

        let script = monitor_script(&app)?;
        let mut command = Command::new("powershell.exe");
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-Sta",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(script)
            .args(["-LincoPid", &std::process::id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::proc_ext::no_window(&mut command);
        command.spawn().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn powerpoint_live_status() -> Result<Option<Value>, String> {
    let path = descriptor_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
    let value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    Ok(Some(value))
}

#[tauri::command]
pub fn powerpoint_live_activate() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-Sta",
            "-Command",
            "try{$ppt=[Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')}catch{$ppt=New-Object -ComObject PowerPoint.Application}; $ppt.Visible=-1; $ppt.Activate()",
        ]);
        crate::proc_ext::no_window(&mut command);
        command.spawn().map_err(|error| error.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("PowerPoint Live currently requires Windows desktop PowerPoint.".into())
    }
}

#[tauri::command]
pub fn powerpoint_live_save_annotation(
    presentation_path: String,
    slide_index: u32,
    png_base64: String,
) -> Result<String, String> {
    if png_base64.len() > 32 * 1024 * 1024 {
        return Err("PowerPoint annotation image is too large".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64)
        .map_err(|error| format!("Invalid PowerPoint annotation image: {error}"))?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("PowerPoint annotation must be a PNG image".into());
    }

    let linco_home = PathBuf::from(crate::config::home_dir()?).join(".linco");
    let output = annotation_output_path(Path::new(&presentation_path), slide_index, &linco_home)?;
    let directory = output
        .parent()
        .ok_or("PowerPoint annotation output has no parent directory")?;
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let temporary = output.with_extension(format!("{nonce}.tmp"));
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    if output.exists() {
        std::fs::remove_file(&output).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&temporary, &output).map_err(|error| error.to_string())?;
    Ok(output.to_string_lossy().into_owned())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::{annotation_output_path, cli_path};
    use std::path::Path;

    #[test]
    fn removes_windows_verbatim_prefix_for_external_clis() {
        assert_eq!(
            cli_path(Path::new(r"\\?\C:\workspace\server.mjs")),
            r"C:\workspace\server.mjs"
        );
        assert_eq!(
            cli_path(Path::new(r"\\?\UNC\server\share\server.mjs")),
            r"\\server\share\server.mjs"
        );
    }

    #[test]
    fn annotation_is_a_linco_sidecar_outside_the_presentation() {
        let presentation = Path::new(r"C:\work\paper\figure.pptx");
        let linco_home = Path::new(r"C:\Profiles\test\.linco");
        let path = annotation_output_path(presentation, 2, linco_home).unwrap();
        assert_eq!(
            path.parent().unwrap(),
            linco_home.join("powerpoint-annotations")
        );
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("figure-"));
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with("-slide-002-annotation.png"));
        assert!(!path.starts_with(presentation.parent().unwrap()));
    }
}
