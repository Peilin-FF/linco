// Dedicated dev window; never overwrites or closes the installed Linco app.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
fn main() {
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "ai.linco.app.paper-dev".into();
    let port = std::env::var("LINCO_PAPER_DEV_PORT").ok().and_then(|value| value.parse::<u16>().ok()).filter(|port| *port >= 1024).unwrap_or(9226);
    if let Some(window) = context.config_mut().app.windows.first_mut() {
        window.title = match port { 9226 => "Linco — Research & Paper Dev", 9228 => "Linco — AI Paper Dev", 9229 | 9230 => "Linco — Fast Paper Dev", 9231 => "Linco — PDF-only Reading Dev", _ => "Linco — Research & Paper Dev (latest)" }.into();
        window.data_directory = Some(
            std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir)
                .join("LincoPaperDev").join(format!("webview-{port}")),
        );
        window.additional_browser_args = Some(format!("--remote-debugging-port={port}"));
    }
    linco_lib::run_development_context(context);
}
