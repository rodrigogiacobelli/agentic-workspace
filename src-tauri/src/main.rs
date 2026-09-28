#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Before anything starts: ssh and git run this binary as their helper,
    // and the application — the single-instance check above all — must not
    // start under them.
    if let Some(code) = agentic_workspace_lib::helper() {
        std::process::exit(code)
    }
    agentic_workspace_lib::run();
}
