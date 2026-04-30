export type AgentStatus =
  | { type: "Running"; since_secs: number }
  | { type: "Waiting"; since_secs: number }
  | { type: "Idle" };

export interface AgentSession {
  pid: number;
  project_name: string;
  project_path: string;
  ide_name: string;
  git_branch: string | null;
  status: AgentStatus;
  lock_file: string;
}

export interface SessionSummary {
  activeCount: number;
  runningCount: number;
  waitingCount: number;
  trackedProjects: number;
  title: string;
  subtitle: string;
  footer: string;
}

export function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) {
    const minutes = Math.floor(secs / 60);
    const seconds = secs % 60;
    return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(secs / 3600);
  const minutes = Math.floor((secs % 3600) / 60);
  return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
}

export function getStatusKey(status: AgentStatus): "running" | "waiting" | "idle" {
  return status.type.toLowerCase() as "running" | "waiting" | "idle";
}

/**
 * Maps the runtime status to the `data-status` attribute the v0.2.0
 * design expects on `.session-card`. The design's CSS only knows
 * running / waiting / stopped / error, so we collapse `Idle` to
 * `stopped` (semantically the same: no active loop).
 */
export function getStatusDataAttr(
  status: AgentStatus,
): "running" | "waiting" | "stopped" {
  return status.type === "Idle" ? "stopped" : (status.type.toLowerCase() as "running" | "waiting");
}

export function getStatusLabel(status: AgentStatus): string {
  switch (status.type) {
    case "Running":
      return "En cours";
    case "Waiting":
      return "En attente";
    case "Idle":
      return "Inactif";
  }
}

export function getStatusLabelShort(status: AgentStatus): string {
  switch (status.type) {
    case "Running":
      return "Running";
    case "Waiting":
      return "Waiting";
    case "Idle":
      return "Stopped";
  }
}

export function getStatusDuration(status: AgentStatus): string | null {
  if (status.type === "Running" || status.type === "Waiting") {
    return formatDuration(status.since_secs);
  }

  return null;
}

export function projectNameFromPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

export function sortSessions(sessions: AgentSession[]): AgentSession[] {
  const order = { Waiting: 0, Running: 1, Idle: 2 };
  return [...sessions].sort((a, b) => order[a.status.type] - order[b.status.type]);
}

export function summarizeSessions(sessions: AgentSession[]): SessionSummary {
  const activeSessions = sessions.filter((session) => session.status.type !== "Idle");
  const runningCount = activeSessions.filter((session) => session.status.type === "Running").length;
  const waitingCount = activeSessions.filter((session) => session.status.type === "Waiting").length;
  const trackedProjects = new Set(
    sessions.map((session) => session.project_path || session.project_name).filter(Boolean),
  ).size;

  if (activeSessions.length === 0) {
    return {
      activeCount: 0,
      runningCount: 0,
      waitingCount: 0,
      trackedProjects,
      title: "Prêt à suivre vos agents",
      subtitle: "Le hub attend le prochain terminal IA ou IDE actif.",
      footer: "Aucun agent critique",
    };
  }

  if (activeSessions.length === 1) {
    const session = activeSessions[0];
    const project = session.project_name || projectNameFromPath(session.project_path);

    return {
      activeCount: 1,
      runningCount,
      waitingCount,
      trackedProjects,
      title:
        session.status.type === "Waiting"
          ? `${session.ide_name} attend sur ${project}`
          : `${session.ide_name} actif sur ${project}`,
      subtitle:
        session.status.type === "Waiting"
          ? "La session a besoin d'une reprise ou d'une interaction utilisateur."
          : "Une session IA est en cours sur ce projet.",
      footer: session.git_branch ? `Branche ${session.git_branch}` : "Projet suivi sans branche detectee",
    };
  }

  if (waitingCount > 0) {
    const noun = waitingCount > 1 ? "agents demandent" : "agent demande";
    return {
      activeCount: activeSessions.length,
      runningCount,
      waitingCount,
      trackedProjects,
      title: `${waitingCount} ${noun} votre attention`,
      subtitle: "Reprenez une session en attente pour la faire revenir en mode actif.",
      footer: "Action utilisateur recommandée",
    };
  }

  return {
    activeCount: activeSessions.length,
    runningCount,
    waitingCount,
    trackedProjects,
    title: `${runningCount} session${runningCount > 1 ? "s" : ""} en flux`,
    subtitle: "Les agents détectés tournent normalement sur vos projets suivis.",
    footer: "Tout fonctionne normalement",
  };
}

/**
 * Maps the Rust-side `ide_name` string (free-form, see `detect_ide_name`)
 * to a stable key used as `data-ide` on the session card. The CSS uses
 * this key to apply per-IDE colour hints; the glyph helper below uses
 * the same key to pick the 2-letter monogram.
 */
export function ideKey(ideName: string): string {
  const lower = ideName.toLowerCase();
  if (lower.includes("claude code")) return "claude-code";
  if (lower.includes("claude desktop")) return "claude-desktop";
  if (lower.includes("cursor")) return "cursor";
  if (lower.includes("codex")) return "codex";
  if (lower.includes("antigravity")) return "antigravity";
  if (lower.includes("windsurf")) return "windsurf";
  if (lower.includes("vscode") || lower.includes("vs code")) return "vscode";
  if (lower.includes("aider")) return "aider";
  if (lower.includes("cline")) return "cline";
  if (lower.includes("openhands")) return "openhands";
  if (lower.includes("agent ia")) return "agent-ia";
  return "unknown";
}

const IDE_GLYPHS: Record<string, string> = {
  "claude-code": "CC",
  "claude-desktop": "CD",
  cursor: "CR",
  codex: "CX",
  antigravity: "AG",
  windsurf: "WS",
  vscode: "VS",
  aider: "AI",
  cline: "CL",
  openhands: "OH",
  "agent-ia": "AX",
  unknown: "··",
};

export function ideGlyph(ideName: string): string {
  return IDE_GLYPHS[ideKey(ideName)] ?? "··";
}
