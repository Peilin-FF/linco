// Linco —— Tauri 应用入口。
//
// 设计:Linco 不实现任何 agent harness。它开一个真正的伪终端(PTY)跑
// 用户的 shell;用户在终端里安装并运行各家 CLI(claude / codex / 等)。
// 对话框的输入被重定向写入 PTY(等价于在终端键入),CLI 的输出在
// 终端视图中实时渲染。对任何厂家的 CLI 都通用。

mod agent_proxy;
mod agent_rpc;
mod blocking;
mod config;
mod fs;
mod git;
mod model_test;
mod plugins;
mod preview;
mod proc_ext;
mod procs;
mod remote;
mod search;
mod sessions;
mod shadow;
mod terminal;
mod transfer;
mod usage;
mod watch;

#[cfg(test)]
mod legacy_guard;

use terminal::TerminalState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_drag::init())
        .setup(|app| {
            // 存 AppHandle 给 agent_rpc 的 reader 线程 emit 文件变更事件
            agent_rpc::set_app(app.handle().clone());
            Ok(())
        })
        .manage(TerminalState::default())
        .manage(usage::UsageState::default())
        .invoke_handler(tauri::generate_handler![
            terminal::term_start,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_kill,
            usage::usage_load,
            usage::usage_record_turn,
            usage::usage_ingest_terminal_output,
            config::load_config,
            config::save_config,
            model_test::test_model_connection,
            plugins::set_language,
            plugins::install_remote_plugins,
            plugins::plugin_status,
            plugins::plugin_set,
            preview::preview_start,
            preview::preview_set_target,
            preview::preview_default_target,
            preview::preview_prefetch_assets,
            agent_proxy::proxy_available,
            agent_proxy::proxy_start,
            agent_proxy::proxy_stop,
            agent_proxy::proxy_status,
            agent_proxy::proxy_cmdlog_file,
            agent_proxy::proxy_begin_turn,
            watch::watch_start,
            watch::watch_stop,
            shadow::shadow_begin_turn,
            shadow::shadow_diff,
            shadow::shadow_changed,
            fs::fs_list_dir,
            fs::fs_read_file,
            fs::fs_read_bytes,
            fs::fs_write_file,
            fs::fs_write_bytes,
            fs::fs_create_file,
            fs::fs_create_dir,
            fs::fs_rename,
            fs::fs_delete,
            fs::fs_reveal,
            fs::fs_copy,
            fs::fs_move,
            fs::fs_search,
            search::search_content,
            search::search_content_stream,
            search::search_cancel,
            search::replace_in_file,
            git::git_is_repo,
            git::git_status,
            git::git_diff_file,
            git::git_stage,
            git::git_unstage,
            git::git_stage_all,
            git::git_unstage_all,
            git::git_discard,
            git::git_commit,
            git::git_pull,
            git::git_push,
            git::git_fetch,
            git::git_remote_url,
            git::git_test_connection,
            git::git_apply_credentials,
            git::sync_git_to_remote,
            git::git_branches,
            git::git_checkout,
            git::git_create_branch,
            git::git_log,
            git::git_show,
            git::git_stash_list,
            git::git_stash_push,
            git::git_stash_apply,
            git::git_stash_pop,
            git::git_stash_drop,
            remote::ssh_config_hosts,
            remote::ssh_connect,
            remote::ssh_check,
            remote::ssh_disconnect,
            remote::parse_ssh_command,
            remote::ssh_config_add,
            remote::remote_home,
            procs::agent_processes,
            procs::agent_tasks,
            procs::proc_output_file,
            procs::tail_file,
            sessions::agent_sessions,
            sessions::agent_session_delete,
            transfer::transfer_upload,
            transfer::transfer_download,
            transfer::transfer_cancel,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Linco")
        .run(|_app, event| {
            // app 退出时确保命令可见代理子进程被清理,避免留下孤儿进程
            if let tauri::RunEvent::Exit = event {
                agent_proxy::proxy_stop();
            }
        });
}
