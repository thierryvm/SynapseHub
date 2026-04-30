import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import packageJson from "../package.json";
import {
  type AgentSession,
  formatDuration,
  getStatusDataAttr,
  getStatusLabelShort,
  ideGlyph,
  ideKey,
  projectNameFromPath,
  sortSessions,
} from "./session-view";

// State
let sessions: AgentSession[] = [];
let availableUpdate: Update | null = null;
let lastUpdateCheckLabel = "Aucune vérification récente";
let isCheckingUpdates = false;
let isInstallingUpdate = false;

const APP_VERSION_LABEL = `v${packageJson.version}`;
const ONBOARDING_FLAG = "synapsehub_onboarding_completed_v0.2.0";
const DENSITY_COMPACT_THRESHOLD = 10;
const SVG_NS = "http://www.w3.org/2000/svg";

// DOM refs
const root = document.documentElement;
const sessionList = document.getElementById("session-list") as HTMLElement;
const emptyState = document.getElementById("empty-state") as HTMLElement;
const agentBadgeCount = document.getElementById("agent-badge-count") as HTMLElement;
const runningCountEl = document.getElementById("running-count") as HTMLElement;
const runningSuffix = document.getElementById("running-suffix") as HTMLElement;
const runningMeta = document.getElementById("running-meta") as HTMLElement;
const waitingCountEl = document.getElementById("waiting-count") as HTMLElement;
const waitingMeta = document.getElementById("waiting-meta") as HTMLElement;
const projectsCountEl = document.getElementById("projects-count") as HTMLElement;
const projectsMeta = document.getElementById("projects-meta") as HTMLElement;
const footerSessionCount = document.getElementById("footer-session-count") as HTMLElement;
const footerDetail = document.getElementById("footer-detail") as HTMLElement;
const versionLabel = document.getElementById("version-label") as HTMLElement;

const btnMinimize = document.getElementById("btn-minimize") as HTMLButtonElement;
const btnClose = document.getElementById("btn-close") as HTMLButtonElement;
const btnSettings = document.getElementById("btn-settings") as HTMLButtonElement;
const btnShowOnboarding = document.getElementById("btn-show-onboarding") as HTMLButtonElement;

const drawer = document.getElementById("settings-drawer") as HTMLElement;
const drawerBackdrop = document.getElementById("drawer-backdrop") as HTMLElement;
const btnCloseDrawer = document.getElementById("btn-close-drawer") as HTMLButtonElement;
const btnCopyConfig = document.getElementById("btn-copy-config") as HTMLButtonElement;
const configCode = document.getElementById("config-code") as HTMLElement;
const modalStatus = document.getElementById("modal-status") as HTMLElement;

const updateSummary = document.getElementById("update-summary") as HTMLElement;
const updateMeta = document.getElementById("update-meta") as HTMLElement;
const updateProgress = document.getElementById("update-progress") as HTMLElement;
const installRow = document.getElementById("install-row") as HTMLDivElement;
const btnCheckUpdates = document.getElementById("btn-check-updates") as HTMLButtonElement;
const btnInstallUpdate = document.getElementById("btn-install-update") as HTMLButtonElement;

const onboardingBackdrop = document.getElementById("onboarding-backdrop") as HTMLElement;
const onboardEyebrow = document.getElementById("onboard-eyebrow") as HTMLElement;
const onboardTitle = document.getElementById("onboard-title") as HTMLElement;
const onboardBody = document.getElementById("onboard-body") as HTMLElement;
const onboardGlyph = document.getElementById("onboard-glyph") as HTMLElement;
const onboardDots = document.getElementById("onboard-dots") as HTMLElement;
const btnOnboardSkip = document.getElementById("onboard-skip") as HTMLButtonElement;
const btnOnboardPrev = document.getElementById("onboard-prev") as HTMLButtonElement;
const btnOnboardNext = document.getElementById("onboard-next") as HTMLButtonElement;

versionLabel.textContent = APP_VERSION_LABEL;

// SVG builders (no innerHTML)
function svg(viewBox: string, attrs: Record<string, string> = {}): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("viewBox", viewBox);
  el.setAttribute("aria-hidden", "true");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function svgPath(parent: SVGElement, d: string, attrs: Record<string, string> = {}): void {
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", d);
  for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
  parent.appendChild(p);
}

function svgCircle(parent: SVGElement, cx: number, cy: number, r: number, attrs: Record<string, string> = {}): void {
  const c = document.createElementNS(SVG_NS, "circle");
  c.setAttribute("cx", String(cx));
  c.setAttribute("cy", String(cy));
  c.setAttribute("r", String(r));
  for (const [k, v] of Object.entries(attrs)) c.setAttribute(k, v);
  parent.appendChild(c);
}

function svgLine(parent: SVGElement, x1: number, y1: number, x2: number, y2: number, attrs: Record<string, string> = {}): void {
  const l = document.createElementNS(SVG_NS, "line");
  l.setAttribute("x1", String(x1));
  l.setAttribute("y1", String(y1));
  l.setAttribute("x2", String(x2));
  l.setAttribute("y2", String(y2));
  for (const [k, v] of Object.entries(attrs)) l.setAttribute(k, v);
  parent.appendChild(l);
}

function buildBranchIcon(): SVGSVGElement {
  const s = svg("0 0 16 16", {
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.4",
    "stroke-linecap": "round",
  });
  svgCircle(s, 4, 3, 1.6);
  svgCircle(s, 4, 13, 1.6);
  svgCircle(s, 12, 6, 1.6);
  svgPath(s, "M4 4.6v6.8");
  svgPath(s, "M4 7.5c0-1.5 1-2.5 2.5-2.5h2.5");
  return s;
}

function buildFocusIcon(): SVGSVGElement {
  const s = svg("0 0 16 16", {
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.4",
    "stroke-linecap": "round",
  });
  svgPath(s, "M2 5V3a1 1 0 0 1 1-1h2");
  svgPath(s, "M14 5V3a1 1 0 0 0-1-1h-2");
  svgPath(s, "M2 11v2a1 1 0 0 0 1 1h2");
  svgPath(s, "M14 11v2a1 1 0 0 1-1 1h-2");
  svgCircle(s, 8, 8, 2);
  return s;
}

function buildCheckIcon(): SVGSVGElement {
  const s = svg("0 0 16 16", {
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  svgPath(s, "M3 8.5l3 3 7-7");
  return s;
}

function buildBrandGlyph(): SVGSVGElement {
  const s = svg("0 0 32 32", { fill: "none", xmlns: SVG_NS });
  svgCircle(s, 16, 16, 3.2, { fill: "currentColor" });
  svgCircle(s, 16, 16, 6, { stroke: "currentColor", "stroke-width": "1.2", "stroke-opacity": "0.5" });
  svgLine(s, 16, 16, 5, 5, { stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round" });
  svgLine(s, 16, 16, 27, 5, { stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round" });
  svgLine(s, 16, 16, 5, 27, { stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round" });
  svgLine(s, 16, 16, 27, 27, { stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round" });
  svgCircle(s, 5, 5, 2, { fill: "currentColor" });
  svgCircle(s, 27, 5, 2, { fill: "currentColor" });
  svgCircle(s, 5, 27, 2, { fill: "currentColor" });
  svgCircle(s, 27, 27, 2, { fill: "currentColor" });
  return s;
}

// Card rendering (DOM API only — no innerHTML)
function renderSessionCard(session: AgentSession): HTMLElement {
  const status = getStatusDataAttr(session.status);
  const statusLabel = getStatusLabelShort(session.status);
  const projectLabel = session.project_name || projectNameFromPath(session.project_path);
  const ideKeyTxt = ideKey(session.ide_name);
  const canFocus = session.pid > 0;

  const card = document.createElement("article");
  card.className = "session-card";
  card.dataset.status = status;
  card.dataset.pid = String(session.pid);
  card.tabIndex = 0;
  card.setAttribute("aria-label", `${projectLabel} — ${statusLabel}`);

  // IDE glyph slot
  const ide = document.createElement("div");
  ide.className = "session-ide";
  ide.dataset.ide = ideKeyTxt;
  ide.title = session.ide_name;
  ide.textContent = ideGlyph(session.ide_name);
  card.appendChild(ide);

  // Body (project / path / ide name / branch)
  const body = document.createElement("div");
  body.className = "session-body";

  const line1 = document.createElement("div");
  line1.className = "session-line-1";
  const project = document.createElement("span");
  project.className = "session-project";
  project.title = projectLabel;
  project.textContent = projectLabel;
  line1.appendChild(project);
  if (session.git_branch) {
    const branch = document.createElement("span");
    branch.className = "session-branch";
    branch.appendChild(buildBranchIcon());
    const branchTxt = document.createElement("span");
    branchTxt.className = "branch-text";
    branchTxt.textContent = session.git_branch;
    branch.appendChild(branchTxt);
    line1.appendChild(branch);
  }
  body.appendChild(line1);

  const line2 = document.createElement("div");
  line2.className = "session-line-2";
  const path = document.createElement("span");
  path.className = "session-path";
  path.title = session.project_path;
  path.textContent = session.project_path;
  line2.appendChild(path);
  const ideName = document.createElement("span");
  ideName.className = "session-ide-name";
  ideName.textContent = session.ide_name;
  line2.appendChild(ideName);
  body.appendChild(line2);

  card.appendChild(body);

  // Status pill
  const statusEl = document.createElement("div");
  statusEl.className = "session-status";
  statusEl.setAttribute("aria-label", `Statut ${statusLabel}`);
  const dot = document.createElement("span");
  dot.className = "dot";
  statusEl.appendChild(dot);
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = statusLabel;
  statusEl.appendChild(label);
  if (session.status.type === "Running" || session.status.type === "Waiting") {
    const runtime = document.createElement("span");
    runtime.className = "session-runtime";
    runtime.textContent = formatDuration(session.status.since_secs);
    statusEl.appendChild(runtime);
  }
  card.appendChild(statusEl);

  // Action: focus
  const actions = document.createElement("div");
  actions.className = "session-actions";
  const focusBtn = document.createElement("button");
  focusBtn.className = "icon-btn";
  focusBtn.type = "button";
  focusBtn.dataset.action = "focus";
  focusBtn.setAttribute("aria-label", "Focus IDE");
  focusBtn.title = "Mettre la fenêtre IDE au premier plan";
  if (!canFocus) focusBtn.disabled = true;
  focusBtn.appendChild(buildFocusIcon());
  actions.appendChild(focusBtn);
  card.appendChild(actions);

  // Click handlers (event capture pattern from v0.1.5)
  const handleAction = (event: Event) => {
    event.stopPropagation();
    if (status === "waiting") {
      invoke("acknowledge_waiting", { projectPath: session.project_path }).catch(console.error);
    }
    if (!canFocus) return;
    invoke<boolean>("focus_window", { pid: session.pid })
      .then((focused) => {
        if (focused) {
          // v0.1.5: dashboard is alwaysOnTop, hide it so the IDE actually shows.
          invoke("hide_window").catch(console.error);
        } else {
          console.warn(
            `focus_window(${session.pid}) → no window found in parent chain (terminal may have closed)`,
          );
        }
      })
      .catch((err) => console.error(`focus_window(${session.pid}) failed:`, err));
  };

  card.addEventListener("click", handleAction);
  focusBtn.addEventListener("click", handleAction);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleAction(event);
    }
  });

  return card;
}

function updateStats(): void {
  const active = sessions.filter((s) => s.status.type !== "Idle");
  const running = active.filter((s) => s.status.type === "Running").length;
  const waiting = active.filter((s) => s.status.type === "Waiting").length;
  const projects = new Set(
    sessions.map((s) => s.project_path || s.project_name).filter(Boolean),
  ).size;

  agentBadgeCount.textContent = String(active.length);

  runningCountEl.textContent = String(running);
  runningSuffix.textContent = sessions.length > 0 ? ` / ${sessions.length}` : "";
  runningMeta.textContent =
    running > 0 ? `${running} agent${running > 1 ? "s" : ""} en flux` : "Aucune session en exécution";

  waitingCountEl.textContent = String(waiting);
  waitingMeta.textContent = waiting > 0 ? "Action utilisateur attendue" : "Aucun blocage détecté";

  projectsCountEl.textContent = String(projects);
  projectsMeta.textContent =
    projects > 0
      ? `${projects} dossier${projects > 1 ? "s" : ""} suivi${projects > 1 ? "s" : ""}`
      : "Vos dossiers récents";

  const sessionsTotal = sessions.length;
  footerSessionCount.textContent = `${sessionsTotal} session${sessionsTotal > 1 ? "s" : ""}`;
  footerDetail.textContent =
    waiting > 0
      ? `${waiting} en attente`
      : running > 0
        ? `${running} actif${running > 1 ? "s" : ""}`
        : "Aucun agent critique";

  root.dataset.density =
    active.length > DENSITY_COMPACT_THRESHOLD ? "compact" : "confortable";
}

function render(): void {
  const sorted = sortSessions(sessions);

  const isEmpty = sessions.length === 0;
  emptyState.style.display = isEmpty ? "" : "none";

  const existingCards = sessionList.querySelectorAll(".session-card");
  existingCards.forEach((c) => c.remove());

  if (!isEmpty) {
    for (const s of sorted) sessionList.appendChild(renderSessionCard(s));
  }

  updateStats();
  document.title =
    sessions.length > 0
      ? `SynapseHub — ${sessions.length} session${sessions.length > 1 ? "s" : ""}`
      : "SynapseHub";
}

// Settings drawer
const TK_PATTERN =
  /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\],])/g;

function tokenClass(match: string): string {
  if (/^"/.test(match)) return /:$/.test(match) ? "tk-key" : "tk-str";
  if (/true|false/.test(match)) return "tk-bool";
  if (/null/.test(match)) return "tk-null";
  if (/[{}\[\],]/.test(match)) return "tk-punct";
  return "tk-num";
}

/**
 * Builds a syntax-highlighted JSON tree as DOM nodes (no innerHTML).
 * Each token becomes a <span class="tk-..."> appended in source order;
 * the gaps between tokens are preserved as plain text nodes.
 */
function highlightJSONIntoElement(target: HTMLElement, raw: string): void {
  // Clear previous content
  while (target.firstChild) target.removeChild(target.firstChild);

  let lastIndex = 0;
  for (const match of raw.matchAll(TK_PATTERN)) {
    const tokenStart = match.index ?? 0;
    if (tokenStart > lastIndex) {
      target.appendChild(document.createTextNode(raw.slice(lastIndex, tokenStart)));
    }
    const span = document.createElement("span");
    span.className = tokenClass(match[0]);
    span.textContent = match[0];
    target.appendChild(span);
    lastIndex = tokenStart + match[0].length;
  }
  if (lastIndex < raw.length) {
    target.appendChild(document.createTextNode(raw.slice(lastIndex)));
  }
}

function buildHookConfig(port: number | string, token: string): string {
  const config = {
    hooks: {
      Stop: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: `curl -s -X POST http://127.0.0.1:${port}/hook -H "Content-Type: application/json" -d "{\\"token\\":\\"${token}\\",\\"project_dir\\":\\"$CLAUDE_PROJECT_DIR\\"}"`,
            },
          ],
        },
      ],
    },
  };
  return JSON.stringify(config, null, 2);
}

async function loadConfig(): Promise<void> {
  try {
    const config = await invoke<{ port?: number; token?: string }>("get_config");
    const port = config.port ?? "PORT_INTROUVABLE";
    const token = config.token ?? "<TOKEN_INTROUVABLE>";
    const json = buildHookConfig(port, token);
    configCode.dataset.raw = json;
    highlightJSONIntoElement(configCode, json);
    modalStatus.textContent = "";
  } catch (err) {
    modalStatus.textContent = "Impossible de charger la configuration";
    console.error("Failed to load config:", err);
  }
}

function openDrawer(): void {
  drawer.dataset.open = "true";
  drawer.setAttribute("aria-hidden", "false");
  drawerBackdrop.dataset.open = "true";
  void loadConfig();
  void checkForUpdates(false);
}

function closeDrawer(): void {
  drawer.dataset.open = "false";
  drawer.setAttribute("aria-hidden", "true");
  drawerBackdrop.dataset.open = "false";
}

btnSettings.addEventListener("click", openDrawer);
btnCloseDrawer.addEventListener("click", closeDrawer);
drawerBackdrop.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && drawer.dataset.open === "true") closeDrawer();
});

btnCopyConfig.addEventListener("click", async () => {
  const raw = configCode.dataset.raw ?? configCode.textContent ?? "";
  try {
    await navigator.clipboard.writeText(raw);

    btnCopyConfig.dataset.state = "copied";
    while (btnCopyConfig.firstChild) btnCopyConfig.removeChild(btnCopyConfig.firstChild);
    btnCopyConfig.appendChild(buildCheckIcon());
    btnCopyConfig.appendChild(document.createTextNode(" Copié"));
    modalStatus.textContent = "Configuration copiée";

    setTimeout(() => {
      btnCopyConfig.removeAttribute("data-state");
      while (btnCopyConfig.firstChild) btnCopyConfig.removeChild(btnCopyConfig.firstChild);
      // Restore the original SVG + label
      const s = svg("0 0 16 16", {
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "1.4",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      });
      svgPath(s, "M11 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2");
      // Inner rect via path is awkward — use rect element instead.
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", "5");
      rect.setAttribute("y", "5");
      rect.setAttribute("width", "9");
      rect.setAttribute("height", "9");
      rect.setAttribute("rx", "1.2");
      s.appendChild(rect);
      btnCopyConfig.appendChild(s);
      btnCopyConfig.appendChild(document.createTextNode(" Copier"));

      if (modalStatus.textContent === "Configuration copiée") modalStatus.textContent = "";
    }, 1800);
  } catch {
    modalStatus.textContent = "Échec de la copie";
  }
});

// Updates
function setUpdateControls(): void {
  btnCheckUpdates.disabled = isCheckingUpdates || isInstallingUpdate;
  btnInstallUpdate.disabled = !availableUpdate || isCheckingUpdates || isInstallingUpdate;
  installRow.style.display = availableUpdate ? "" : "none";
  btnCheckUpdates.textContent = isCheckingUpdates ? "Vérification…" : "Rechercher";
  btnInstallUpdate.textContent = isInstallingUpdate ? "Installation…" : "Installer";
}

function setUpdateDisplay(summary: string, meta: string, progress = ""): void {
  updateSummary.textContent = summary;
  updateMeta.textContent = meta;
  updateProgress.textContent = progress;
  setUpdateControls();
}

async function checkForUpdates(userInitiated: boolean): Promise<void> {
  if (isCheckingUpdates || isInstallingUpdate) return;

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
      setUpdateDisplay(
        `Version ${update.version} disponible`,
        update.body?.trim() || `Version actuelle ${update.currentVersion}. Installation en un clic.`,
        lastUpdateCheckLabel,
      );
    } else if (userInitiated) {
      setUpdateDisplay(
        "Application à jour",
        "Vous utilisez déjà la dernière version publiée de SynapseHub.",
        lastUpdateCheckLabel,
      );
    } else {
      setUpdateDisplay(
        "Aucune mise à jour détectée",
        "SynapseHub est déjà synchronisé avec la dernière release publiée.",
        lastUpdateCheckLabel,
      );
    }
  } catch (err) {
    availableUpdate = null;
    setUpdateDisplay(
      "Vérification indisponible",
      "La mise à jour n'a pas pu être vérifiée. Vérifiez qu'une release GitHub publiée existe.",
      userInitiated ? "Réessayez dans quelques instants." : "",
    );
    console.error("Failed to check for updates:", err);
  } finally {
    isCheckingUpdates = false;
    setUpdateControls();
  }
}

async function installUpdate(): Promise<void> {
  if (isInstallingUpdate) return;
  if (!availableUpdate) {
    await checkForUpdates(true);
    if (!availableUpdate) return;
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
      switch (event.event) {
        case "Started":
          totalBytes = event.data.contentLength ?? 0;
          updateProgress.textContent =
            totalBytes > 0
              ? `Téléchargement: 0 / ${formatBytes(totalBytes)}`
              : "Téléchargement démarré";
          break;
        case "Progress":
          downloadedBytes += event.data.chunkLength;
          updateProgress.textContent =
            totalBytes > 0
              ? `Téléchargement: ${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`
              : `Téléchargement: ${formatBytes(downloadedBytes)}`;
          break;
        case "Finished":
          updateProgress.textContent = "Paquet reçu, installation locale en cours…";
          break;
      }
    });
    availableUpdate = null;
    setUpdateDisplay(
      "Mise à jour installée",
      "Relancez SynapseHub si le redémarrage n'est pas automatique sur votre machine.",
      lastUpdateCheckLabel,
    );
  } catch (err) {
    setUpdateDisplay(
      "Installation interrompue",
      "La mise à jour n'a pas pu être appliquée. La version actuelle reste intacte.",
      "Consultez la console pour le détail technique.",
    );
    console.error("Failed to install update:", err);
  } finally {
    isInstallingUpdate = false;
    setUpdateControls();
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

btnCheckUpdates.addEventListener("click", () => void checkForUpdates(true));
btnInstallUpdate.addEventListener("click", () => void installUpdate());

// Onboarding (3 slides, persisted in localStorage)
interface OnboardSlide {
  eyebrow: string;
  title: string;
  bodyLines: (string | { code: string })[];
}

const ONBOARD_SLIDES: OnboardSlide[] = [
  {
    eyebrow: "Étape 1 / 3 — Détection",
    title: "Vos sessions IA, à un coup d'œil",
    bodyLines: [
      "SynapseHub scanne en local Claude Code, Cursor, Codex, Antigravity, Windsurf et VS Code. Aucune télémétrie, tout reste sur votre machine.",
    ],
  },
  {
    eyebrow: "Étape 2 / 3 — Hook",
    title: "Pauses détectées en temps réel",
    bodyLines: [
      "Ajoutez le snippet ",
      { code: "settings.json" },
      " (depuis l'icône paramètres) pour que Claude Code remonte les pauses d'interaction. Le token reste local.",
    ],
  },
  {
    eyebrow: "Étape 3 / 3 — Focus",
    title: "Une carte = un saut vers l'IDE",
    bodyLines: [
      "Cliquez sur une session pour amener la fenêtre Windows Terminal / IDE au premier plan. SynapseHub se cache automatiquement après le focus.",
    ],
  },
];

let onboardIndex = 0;

function renderOnboardSlide(): void {
  const slide = ONBOARD_SLIDES[onboardIndex];
  onboardEyebrow.textContent = slide.eyebrow;
  onboardTitle.textContent = slide.title;

  while (onboardBody.firstChild) onboardBody.removeChild(onboardBody.firstChild);
  for (const part of slide.bodyLines) {
    if (typeof part === "string") {
      onboardBody.appendChild(document.createTextNode(part));
    } else {
      const code = document.createElement("code");
      code.textContent = part.code;
      onboardBody.appendChild(code);
    }
  }

  while (onboardGlyph.firstChild) onboardGlyph.removeChild(onboardGlyph.firstChild);
  onboardGlyph.appendChild(buildBrandGlyph());

  const dots = onboardDots.querySelectorAll<HTMLElement>(".onboard-dot");
  dots.forEach((dot, i) => {
    if (i === onboardIndex) dot.dataset.active = "true";
    else dot.removeAttribute("data-active");
  });

  btnOnboardPrev.style.visibility = onboardIndex === 0 ? "hidden" : "visible";
  btnOnboardNext.textContent =
    onboardIndex === ONBOARD_SLIDES.length - 1 ? "Terminer" : "Suivant →";
}

function openOnboarding(): void {
  onboardIndex = 0;
  renderOnboardSlide();
  onboardingBackdrop.classList.remove("is-hidden");
}

function closeOnboarding(persist: boolean): void {
  onboardingBackdrop.classList.add("is-hidden");
  if (persist) {
    try {
      localStorage.setItem(ONBOARDING_FLAG, "true");
    } catch {
      /* localStorage blocked — modal will reappear next launch but is dismissable */
    }
  }
}

btnOnboardSkip.addEventListener("click", () => closeOnboarding(true));

btnOnboardPrev.addEventListener("click", () => {
  if (onboardIndex > 0) {
    onboardIndex -= 1;
    renderOnboardSlide();
  }
});

btnOnboardNext.addEventListener("click", () => {
  if (onboardIndex < ONBOARD_SLIDES.length - 1) {
    onboardIndex += 1;
    renderOnboardSlide();
  } else {
    closeOnboarding(true);
  }
});

btnShowOnboarding.addEventListener("click", openOnboarding);

// Window controls
btnMinimize.addEventListener("click", () => {
  invoke("hide_window").catch(console.error);
});

btnClose.addEventListener("click", () => {
  invoke("quit_app").catch(console.error);
});

// Tauri events
listen<AgentSession[]>("agents-updated", (event) => {
  sessions = event.payload;
  render();
});

// Init
async function init(): Promise<void> {
  try {
    sessions = await invoke<AgentSession[]>("get_sessions");
  } catch (err) {
    console.error("Failed to load initial sessions:", err);
    sessions = [];
  }
  render();

  try {
    if (!localStorage.getItem(ONBOARDING_FLAG)) openOnboarding();
  } catch {
    /* localStorage blocked — skip onboarding gracefully */
  }

  void checkForUpdates(false);
}

void init();
