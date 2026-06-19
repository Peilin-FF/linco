// Linco —— Tauri 应用入口。
//
// 设计:Linco 不实现任何 agent harness。它开一个真正的伪终端(PTY)跑
// 用户的 shell;用户在终端里安装并运行各家 CLI(claude / codex / 等)。
// 对话框的输入被重定向写入 PTY(等价于在终端键入),CLI 的输出在
// 终端视图中实时渲染。对任何厂家的 CLI 都通用。

mod agent;
mod agent_rpc;
mod blocking;
mod completion;
mod config;
mod fs;
mod git;
mod preview;
mod procs;
mod remote;
mod search;
mod shadow;
mod terminal;
mod watch;

use agent::AgentState;
use terminal::TerminalState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 存 AppHandle 给 agent_rpc 的 reader 线程 emit 文件变更事件
            agent_rpc::set_app(app.handle().clone());
            Ok(())
        })
        .manage(TerminalState::default())
        .manage(AgentState::default())
        .invoke_handler(tauri::generate_handler![
            terminal::term_start,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_kill,
            config::load_config,
            config::save_config,
            agent::agent_send,
            agent::agent_cancel,
            completion::agent_completions,
            preview::preview_start,
            preview::preview_set_target,
            preview::preview_default_target,
            preview::preview_prefetch_assets,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Linco");
}
