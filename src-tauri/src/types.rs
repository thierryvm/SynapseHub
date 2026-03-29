use serde::{Deserialize, Serialize};

/// Raw structure of a ~/.claude/ide/*.lock file.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockFile {
    pub pid: u32,
    pub workspace_folders: Vec<String>,
    pub ide_name: String,
    #[allow(dead_code)]
    pub transport: String,
    #[allow(dead_code)]
    pub running_in_windows: Option<bool>,
    #[allow(dead_code)]
    pub auth_token: String,
}

/// Agent activity status tracked by SynapseHub.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AgentStatus {
    /// Claude Code is actively processing.
    Running { since_secs: u64 },
    /// Claude Code has stopped and is waiting for user input.
    Waiting { since_secs: u64 },
    /// Process exists but has been idle for a long time.
    Idle,
}

/// A resolved agent session shown in the dashboard.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentSession {
    pub pid: u32,
    pub project_name: String,
    pub project_path: String,
    pub ide_name: String,
    pub git_branch: Option<String>,
    pub status: AgentStatus,
    /// Path of the source lock file (used as stable identifier).
    pub lock_file: String,
}

/// Payload sent by the Claude Code Stop hook to our HTTP receiver.
#[derive(Debug, Deserialize)]
pub struct HookPayload {
    /// Shared secret set during setup.
    pub token: String,
    /// Absolute path of the project workspace.
    pub project_dir: String,
    /// PID of the Claude Code process (optional, aids matching).
    #[allow(dead_code)]
    pub pid: Option<u32>,
    /// Nom optionnel de l'agent (ex: "Aider", "Cursor")
    #[allow(dead_code)]
    pub agent_name: Option<String>,
}

/// Global mutable app state shared across threads.
#[derive(Debug, Default)]
pub struct AppState {
    pub sessions: Vec<AgentSession>,
    /// Tokens for projects currently in "waiting" state.
    /// Key: project_path, Value: timestamp (secs since epoch).
    pub waiting_since: std::collections::HashMap<String, u64>,
}
