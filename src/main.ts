import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// ─── Types ─────────────────────────────────────────────────────────────────────

type AgentStatus =
  | { type: "Running"; since_secs: number }
  | { type: "Waiting"; since_secs: number }
  | { type: "Idle" };

interface AgentSession {
  pid: number;
  project_name: string;
  project_path: string;
  ide_name: string;
  git_branch: string | null;
  status: AgentStatus;
  lock_file: string;
}

// ─── State ─────────────────────────────────────────────────────────────────────

let sessions: AgentSession[] = [];

// ─── DOM refs ──────────────────────────────────────────────────────────────────

const agentList   = document.getElementById("agent-list")!;
const emptyState  = document.getElementById("empty-state")!;
const agentBadge  = document.getElementById("agent-badge")!;
const btnMinimize = document.getElementById("btn-minimize")!;
const btnClose    = document.getElementById("btn-close")!;
const btnSettings = document.getElementById("btn-settings")!;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(secs: number): string {
  if (secs < 60)  return `${secs}s`;
  if (secs < 3600) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s > 0 ? `${m}m${s}s` : `${m}m`;
  }
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

function getStatusKey(status: AgentStatus): "running" | "waiting" | "idle" {
  return status.type.toLowerCase() as "running" | "waiting" | "idle";
}

function getStatusLabel(status: AgentStatus): string {
  switch (status.type) {
    case "Running": return "En cours";
    case "Waiting": return "En attente";
    case "Idle":    return "Inactif";
  }
}

function getStatusDuration(status: AgentStatus): string | null {
  if (status.type === "Running" || status.type === "Waiting") {
    return formatDuration(status.since_secs);
  }
  return null;
}

function projectNameFromPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

// ─── Render ────────────────────────────────────────────────────────────────────

function renderCard(session: AgentSession): HTMLElement {
  const statusKey = getStatusKey(session.status);
  const duration  = getStatusDuration(session.status);

  const card = document.createElement("div");
  card.className  = "agent-card";
  card.dataset.status = statusKey;
  card.setAttribute("aria-label", `${session.project_name} — ${getStatusLabel(session.status)}`);

  card.innerHTML = `
    <div class="status-indicator" data-status="${statusKey}" aria-hidden="true"></div>

    <div class="card-body">
      <div class="card-project">${escHtml(session.project_name)}</div>
      ${session.git_branch
        ? `<div class="card-branch">⎇ ${escHtml(session.git_branch)}</div>`
        : ""}
      <div class="card-meta">
        <span class="card-ide">${escHtml(session.ide_name)}</span>
        <span class="card-sep" aria-hidden="true"></span>
        <span class="card-status-label" data-status="${statusKey}">
          ${statusKey === "waiting" ? '<span class="waiting-badge">Attend</span>' : getStatusLabel(session.status)}
        </span>
        ${duration
          ? `<span class="card-sep" aria-hidden="true"></span>
             <span class="card-duration">${escHtml(duration)}</span>`
          : ""}
      </div>
    </div>

    <button class="card-focus" title="Mettre au premier plan" aria-label="Focus ${escHtml(session.project_name)}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
        <path d="M15 3h6v6M9 21H3v-6M21 3l-9 9M3 21l9-9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
  `;

  // Focus window on card or button click
  const focusBtn = card.querySelector<HTMLButtonElement>(".card-focus")!;
  const handleFocus = (e: Event) => {
    e.stopPropagation();
    invoke("focus_window", { pid: session.pid }).catch(console.error);
  };
  card.addEventListener("click", handleFocus);
  focusBtn.addEventListener("click", handleFocus);

  return card;
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function render(): void {
  // Preserve empty state node
  const cards = agentList.querySelectorAll(".agent-card");
  cards.forEach((c) => c.remove());

  const active = sessions.filter((s) => s.status.type !== "Idle");
  const waiting = active.filter((s) => s.status.type === "Waiting");

  // Update badge
  if (active.length === 0) {
    agentBadge.textContent = "Aucun agent";
    agentBadge.removeAttribute("data-count");
  } else {
    agentBadge.textContent = `${active.length} actif${active.length > 1 ? "s" : ""}`;
    agentBadge.dataset.count = String(active.length);
  }

  // Show / hide empty state
  emptyState.style.display = active.length === 0 ? "" : "none";

  // Sort: waiting first, then running, then idle
  const sorted = [...sessions].sort((a, b) => {
    const order = { Waiting: 0, Running: 1, Idle: 2 };
    return order[a.status.type] - order[b.status.type];
  });

  sorted.forEach((s) => {
    if (s.status.type !== "Idle") {
      agentList.appendChild(renderCard(s));
    }
  });

  // Update window title for accessibility
  document.title = waiting.length > 0
    ? `SynapseHub — ${waiting.length} en attente`
    : "SynapseHub";
}

// ─── Event listeners ───────────────────────────────────────────────────────────

btnMinimize.addEventListener("click", () => {
  getCurrentWindow().hide().catch(console.error);
});

btnClose.addEventListener("click", () => {
  invoke("quit_app").catch(console.error);
});

btnSettings.addEventListener("click", () => {
  invoke("open_settings").catch(console.error);
});

// ─── Tauri events ──────────────────────────────────────────────────────────────

listen<AgentSession[]>("agents-updated", (event) => {
  sessions = event.payload;
  render();
});

// ─── Init ──────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  try {
    sessions = await invoke<AgentSession[]>("get_sessions");
    render();
  } catch (e) {
    console.error("Failed to load initial sessions:", e);
  }
}

init();
