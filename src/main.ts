import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  type AgentSession,
  getStatusDuration,
  getStatusKey,
  getStatusLabel,
  projectNameFromPath,
  sortSessions,
  summarizeSessions,
} from "./session-view";

let sessions: AgentSession[] = [];

const agentList = document.getElementById("agent-list")!;
const emptyState = document.getElementById("empty-state")!;
const agentBadge = document.getElementById("agent-badge")!;
const btnMinimize = document.getElementById("btn-minimize")!;
const btnClose = document.getElementById("btn-close")!;
const btnSettings = document.getElementById("btn-settings")!;
const settingsModal = document.getElementById("settings-modal")!;
const btnCloseSettings = document.getElementById("btn-close-settings")!;
const btnCopyConfig = document.getElementById("btn-copy-config")!;
const configCode = document.getElementById("config-code")!;
const modalStatus = document.getElementById("modal-status")!;

const heroKicker = document.getElementById("hero-kicker")!;
const heroTitle = document.getElementById("hero-title")!;
const heroSubtitle = document.getElementById("hero-subtitle")!;
const runningCount = document.getElementById("running-count")!;
const waitingCount = document.getElementById("waiting-count")!;
const projectsCount = document.getElementById("projects-count")!;
const runningMeta = document.getElementById("running-meta")!;
const waitingMeta = document.getElementById("waiting-meta")!;
const projectsMeta = document.getElementById("projects-meta")!;
const sectionCount = document.getElementById("section-count")!;
const footerDetail = document.getElementById("footer-detail")!;

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderCard(session: AgentSession): HTMLElement {
  const statusKey = getStatusKey(session.status);
  const duration = getStatusDuration(session.status);
  const projectLabel = session.project_name || projectNameFromPath(session.project_path);

  const card = document.createElement("article");
  card.className = "agent-card";
  card.dataset.status = statusKey;
  card.setAttribute("aria-label", `${projectLabel} — ${getStatusLabel(session.status)}`);

  card.innerHTML = `
    <div class="card-topline">
      <div class="card-signal">
        <span class="status-indicator" data-status="${statusKey}" aria-hidden="true"></span>
        <div>
          <p class="card-project">${escHtml(projectLabel)}</p>
          <p class="card-path">${escHtml(session.project_path)}</p>
        </div>
      </div>
      <button class="card-focus" title="Mettre au premier plan" aria-label="Focus ${escHtml(projectLabel)}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
          <path d="M15 3h6v6M9 21H3v-6M21 3l-9 9M3 21l9-9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>

    <div class="card-strip">
      <span class="pill pill--soft">${escHtml(session.ide_name)}</span>
      ${
        session.git_branch
          ? `<span class="pill pill--branch">⎇ ${escHtml(session.git_branch)}</span>`
          : `<span class="pill pill--ghost">No branch</span>`
      }
      <span class="pill pill--status" data-status="${statusKey}">
        ${statusKey === "waiting" ? "Attend une reprise" : escHtml(getStatusLabel(session.status))}
      </span>
    </div>

    ${
      duration
        ? `<div class="card-footnote">Actif depuis <strong>${escHtml(duration)}</strong></div>`
        : `<div class="card-footnote">Session détectée, sans activité en cours</div>`
    }
  `;

  const focusBtn = card.querySelector<HTMLButtonElement>(".card-focus")!;
  const handleFocus = (event: Event) => {
    event.stopPropagation();

    if (session.status.type === "Waiting") {
      invoke("acknowledge_waiting", { projectPath: session.project_path }).catch(console.error);
    }

    invoke("focus_window", { pid: session.pid }).catch(console.error);
  };

  card.addEventListener("click", handleFocus);
  focusBtn.addEventListener("click", handleFocus);

  return card;
}

function updateSummary(): void {
  const summary = summarizeSessions(sessions);
  const waitingSessions = sessions.filter((session) => session.status.type === "Waiting");

  heroKicker.textContent = waitingSessions.length > 0 ? "Attention requise" : "Monitoring local";
  heroTitle.textContent = summary.title;
  heroSubtitle.textContent = summary.subtitle;

  runningCount.textContent = String(summary.runningCount);
  waitingCount.textContent = String(summary.waitingCount);
  projectsCount.textContent = String(summary.trackedProjects);

  runningMeta.textContent =
    summary.runningCount > 0 ? "Agents actuellement productifs" : "Aucune session en exécution";
  waitingMeta.textContent =
    summary.waitingCount > 0 ? "Un retour utilisateur est attendu" : "Aucun blocage détecté";
  projectsMeta.textContent =
    summary.trackedProjects > 0 ? "Espaces de travail observés" : "Vos dossiers apparaîtront ici";

  footerDetail.textContent = summary.footer;
}

function render(): void {
  const cards = agentList.querySelectorAll(".agent-card");
  cards.forEach((card) => card.remove());

  const activeSessions = sessions.filter((session) => session.status.type !== "Idle");
  const sortedSessions = sortSessions(sessions);

  if (activeSessions.length === 0) {
    agentBadge.textContent = "Aucun agent";
    agentBadge.removeAttribute("data-count");
  } else {
    agentBadge.textContent = `${activeSessions.length} actif${activeSessions.length > 1 ? "s" : ""}`;
    agentBadge.dataset.count = String(activeSessions.length);
  }

  sectionCount.textContent = `${activeSessions.length} active${activeSessions.length > 1 ? "s" : ""}`;
  emptyState.style.display = activeSessions.length === 0 ? "" : "none";

  sortedSessions.forEach((session) => {
    if (session.status.type !== "Idle") {
      agentList.appendChild(renderCard(session));
    }
  });

  updateSummary();
  document.title =
    activeSessions.length > 0 ? `SynapseHub — ${activeSessions.length} sessions live` : "SynapseHub";
}

btnMinimize.addEventListener("click", () => {
  invoke("hide_window").catch(console.error);
});

btnClose.addEventListener("click", () => {
  invoke("quit_app").catch(console.error);
});

btnSettings.addEventListener("click", async () => {
  try {
    const config = await invoke<{ port?: number; token?: string }>("get_config");
    const port = config.port || "PORT_INTROUVABLE";
    const token = config.token || "<TOKEN_INTROUVABLE>";

    configCode.textContent = `"hooks": {
  "Stop": [{
    "matcher": "",
    "hooks": [{
      "type": "command",
      "command": "curl -s -X POST http://127.0.0.1:${port}/hook -H \\"Content-Type: application/json\\" -d \\"{\\\\\\"token\\\\\\":\\\\\\"${token}\\\\\\",\\\\\\"project_dir\\\\\\":\\\\\\"$CLAUDE_PROJECT_DIR\\\\\\"}\\""
    }]
  }]
}`;

    modalStatus.textContent = "";
    settingsModal.style.display = "flex";
  } catch (error) {
    modalStatus.textContent = "Impossible de charger la configuration";
    settingsModal.style.display = "flex";
    console.error("Failed to load config:", error);
  }
});

btnCloseSettings.addEventListener("click", () => {
  settingsModal.style.display = "none";
});

btnCopyConfig.addEventListener("click", async () => {
  try {
    const code = configCode.textContent || "";
    await navigator.clipboard.writeText(code);
    modalStatus.textContent = "Configuration copiée";
    setTimeout(() => {
      if (modalStatus.textContent === "Configuration copiée") {
        modalStatus.textContent = "";
      }
    }, 2500);
  } catch {
    modalStatus.textContent = "Échec de la copie";
  }
});

listen<AgentSession[]>("agents-updated", (event) => {
  sessions = event.payload;
  render();
});

async function init(): Promise<void> {
  try {
    sessions = await invoke<AgentSession[]>("get_sessions");
    render();
  } catch (error) {
    console.error("Failed to load initial sessions:", error);
  }
}

init();
