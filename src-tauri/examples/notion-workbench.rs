// Separate development executable, so testing a native-browser change doesn't
// overwrite or terminate the user's running Linco instance.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
fn main() {
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "ai.linco.app.notion-dev".into();
    if let Some(window) = context.config_mut().app.windows.first_mut() {
        window.title = "Linco — Notion development".into();
        window.data_directory = Some(
            std::env::current_dir()
                .expect("project directory")
                .join("tmp/notion-dev-browser"),
        );
        window.additional_browser_args = Some("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=9225".into());
    }
    std::env::set_var("LINCO_NOTION_DEVTOOLS", "1");
    linco_lib::run_with_context(context);
}
