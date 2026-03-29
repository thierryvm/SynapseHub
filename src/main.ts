import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
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
const versionLabel = document.getElementById("version-label")!;
const updateSummaryText = document.getElementById("update-summary")!;
const updateMeta = document.getElementById("update-meta")!;
const updateProgress = document.getElementById("update-progress")!;
const btnCheckUpdates = document.getElementById("btn-check-updates") as HTMLButtonElement;
const btnInstallUpdate = document.getElementById("btn-install-update") as HTMLButtonElement;

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

let availableUpdate: Update | null = null;
let lastUpdateCheckLabel = "Aucune vérification récente";
let isCheckingUpdates = false;
let isInstallingUpdate = false;

function createPill(label: string, ...classNames: string[]): HTMLSpanElement {
  const pill = document.createElement("span");
  pill.className = ["pill", ...classNames].join(" ");
  pill.textContent = label;
  return pill;
}

function createFocusButton(projectLabel: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "card-focus";
  button.title = "Mettre au premier plan";
  button.setAttribute("aria-label", `Focus ${projectLabel}`);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M15 3h6v6M9 21H3v-6M21 3l-9 9M3 21l9-9");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.8");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");

  svg.append(path);
  button.append(svg);
  return button;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setUpdateControls(): void {
  btnCheckUpdates.disabled = isCheckingUpdates || isInstallingUpdate;
  btnInstallUpdate.disabled = !availableUpdate || isCheckingUpdates || isInstallingUpdate;
  btnInstallUpdate.style.display = availableUpdate ? "inline-flex" : "none";

  if (isCheckingUpdates) {
    btnCheckUpdates.textContent = "Vérification…";
  } else {
    btnCheckUpdates.textContent = "Rechercher";
  }

  if (isInstallingUpdate) {
    btnInstallUpdate.textContent = "Installation…";
  } else {
    btnInstallUpdate.textContent = "Installer";
  }
}

function setUpdateDisplay(summary: string, meta: string, progress = ""): void {
  updateSummaryText.textContent = summary;
  updateMeta.textContent = meta;
  updateProgress.textContent = progress;
  setUpdateControls();
}

async function checkForUpdates(userInitiated: boolean): Promise<void> {
  if (isCheckingUpdates || isInstallingUpdate) {
    return;
  }

  isCheckingUpdates = true;
  setUpdateDisplay(
    "Recherche de mise à jour en cours…",
    "SynapseHub interroge la dernière release publiée et signée.",
  );

  try {
    const update = await check();
    availableUpdate = update;
    lastUpdateCheckLabel = `Dernière vérification: ${new Date().toLocaleTimeString("fr-BE", {
      hour: "2-digit",
      minute: "2-digit",
    })}`;

    if (update) {
      versionLabel.textContent = "v0.1.0 · update prête";
      setUpdateDisplay(
        `Version ${update.version} disponible`,
        update.body?.trim() || `Version actuelle ${update.currentVersion}. Installation en un clic.`,
        lastUpdateCheckLabel,
      );
    } else if (userInitiated) {
      versionLabel.textContent = "v0.1.0";
      setUpdateDisplay(
        "Application à jour",
        "Vous utilisez déjà la dernière version publiée de SynapseHub.",
        lastUpdateCheckLabel,
      );
    }
  } catch (error) {
    availableUpdate = null;
    versionLabel.textContent = "v0.1.0";
    setUpdateDisplay(
      "Vérification indisponible",
      "La mise à jour n’a pas pu être vérifiée. Vérifiez qu’une release GitHub publiée existe.",
      userInitiated ? "Réessayez dans quelques instants." : "",
    );
    console.error("Failed to check for updates:", error);
  } finally {
    isCheckingUpdates = false;
    setUpdateControls();
  }
}

async function installUpdate(): Promise<void> {
  if (isInstallingUpdate) {
    return;
  }

  if (!availableUpdate) {
    await checkForUpdates(true);
    if (!availableUpdate) {
      return;
    }
  }

  isInstallingUpdate = true;
  let downloadedBytes = 0;
  let totalBytes = 0;
  setUpdateDisplay(
    `Installation de ${availableUpdate.version}`,
    "Téléchargement sécurisé en cours…",
    "Préparation du paquet de mise à jour.",
  );

  try {
    await availableUpdate.downloadAndInstall((event) => {
      if (event.event === "Started") {
        totalBytes = event.data.contentLength ?? 0;
        updateProgress.textContent =
          totalBytes > 0
            ? `Téléchargement: 0 / ${formatBytes(totalBytes)}`
            : "Téléchargement démarré";
      } else if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
        updateProgress.textContent =
          totalBytes > 0
            ? `Téléchargement: ${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`
            : `Téléchargement: ${formatBytes(downloadedBytes)}`;
      } else {
        updateProgress.textContent = "Paquet reçu, installation locale en cours…";
      }
    });

    availableUpdate = null;
    versionLabel.textContent = "v0.1.0 · relance conseillée";
    setUpdateDisplay(
      "Mise à jour installée",
      "Relancez SynapseHub si le redémarrage n’est pas automatique sur votre machine.",
      lastUpdateCheckLabel,
    );
  } catch (error) {
    setUpdateDisplay(
      "Installation interrompue",
      "La mise à jour n’a pas pu être appliquée. La version actuelle reste intacte.",
      "Consultez la console si vous avez besoin du détail technique.",
    );
    console.error("Failed to install update:", error);
  } finally {
    isInstallingUpdate = false;
    setUpdateControls();
  }
}

function renderCard(session: AgentSession): HTMLElement {
  const statusKey = getStatusKey(session.status);
  const duration = getStatusDuration(session.status);
  const projectLabel = session.project_name || projectNameFromPath(session.project_path);
  const canFocusWindow = session.pid > 0;

  const card = document.createElement("article");
  card.className = "agent-card";
  card.dataset.status = statusKey;
  card.setAttribute("aria-label", `${projectLabel} — ${getStatusLabel(session.status)}`);

  const topLine = document.createElement("div");
  topLine.className = "card-topline";

  const signal = document.createElement("div");
  signal.className = "card-signal";

  const indicator = document.createElement("span");
  indicator.className = "status-indicator";
  indicator.dataset.status = statusKey;
  indicator.setAttribute("aria-hidden", "true");

  const textBlock = document.createElement("div");

  const project = document.createElement("p");
  project.className = "card-project";
  project.textContent = projectLabel;

  const path = document.createElement("p");
  path.className = "card-path";
  path.textContent = session.project_path;

  textBlock.append(project, path);
  signal.append(indicator, textBlock);

  const focusBtn = createFocusButton(projectLabel);
  focusBtn.disabled = !canFocusWindow;
  if (!canFocusWindow) {
    focusBtn.title = "Aucune fenêtre locale disponible";
  }
  topLine.append(signal, focusBtn);

  const strip = document.createElement("div");
  strip.className = "card-strip";
  strip.append(createPill(session.ide_name, "pill--soft"));

  if (session.git_branch) {
    strip.append(createPill(`⎇ ${session.git_branch}`, "pill--branch"));
  } else {
    strip.append(createPill("Aucune branche", "pill--ghost"));
  }

  const statusPill = createPill(
    statusKey === "waiting" ? "Attend une reprise" : getStatusLabel(session.status),
    "pill--status",
  );
  statusPill.dataset.status = statusKey;
  strip.append(statusPill);

  const footnote = document.createElement("div");
  footnote.className = "card-footnote";

  if (duration) {
    footnote.append("Actif depuis ");
    const strong = document.createElement("strong");
    strong.textContent = duration;
    footnote.append(strong);
  } else {
    footnote.textContent = "Session détectée, sans activité en cours";
  }

  card.append(topLine, strip, footnote);

  const handleFocus = (event: Event) => {
    event.stopPropagation();

    if (session.status.type === "Waiting") {
      invoke("acknowledge_waiting", { projectPath: session.project_path }).catch(console.error);
    }

    if (canFocusWindow) {
      invoke("focus_window", { pid: session.pid }).catch(console.error);
    }
  };

  if (canFocusWindow || session.status.type === "Waiting") {
    card.addEventListener("click", handleFocus);
    focusBtn.addEventListener("click", handleFocus);
  }

  return card;
}

function updateSummary(): void {
  const summary = summarizeSessions(sessions);
  const waitingSessions = sessions.filter((session) => session.status.type === "Waiting");

  heroKicker.textContent = waitingSessions.length > 0 ? "Attention requise" : "Surveillance locale";
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
  const sortedSessions = sortSessions(activeSessions);

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
    agentList.appendChild(renderCard(session));
  });

  updateSummary();
  document.title =
    activeSessions.length > 0 ? `SynapseHub — ${activeSessions.length} sessions actives` : "SynapseHub";
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
    void checkForUpdates(false);
  } catch (error) {
    modalStatus.textContent = "Impossible de charger la configuration";
    settingsModal.style.display = "flex";
    console.error("Failed to load config:", error);
  }
});

btnCloseSettings.addEventListener("click", () => {
  settingsModal.style.display = "none";
});

settingsModal.addEventListener("click", (event) => {
  if (event.target === settingsModal) {
    settingsModal.style.display = "none";
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && settingsModal.style.display !== "none") {
    settingsModal.style.display = "none";
  }
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

btnCheckUpdates.addEventListener("click", () => {
  void checkForUpdates(true);
});

btnInstallUpdate.addEventListener("click", () => {
  void installUpdate();
});

listen<AgentSession[]>("agents-updated", (event) => {
  sessions = event.payload;
  render();
});

async function init(): Promise<void> {
  try {
    sessions = await invoke<AgentSession[]>("get_sessions");
    render();
    void checkForUpdates(false);
  } catch (error) {
    console.error("Failed to load initial sessions:", error);
  }
}

init();
