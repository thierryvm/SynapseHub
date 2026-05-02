import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { getCurrentWindow } from "@tauri-apps/api/window";
import packageJson from "../package.json";
import {
  type AgentSession,
  ALWAYS_ON_TOP_KEY,
  attachFocusHandler,
  attachUpdateConfirmHandlers,
  getAlwaysOnTopPreference,
  handleQuitAndInstall,
  notifyUpdateSuccessIfNeeded,
  renderSessionCard,
  restoreAlwaysOnTopFromStorage,
  setAlwaysOnTopToggle,
  showToast,
  sortSessions,
} from "./session-view";
import { buildBrandGlyph, buildCheckIcon, buildCopyIcon } from "./icons";

// State
let sessions: AgentSession[] = [];
let availableUpdate: Update | null = null;
let lastUpdateCheckLabel = "Aucune vérification récente";
let isCheckingUpdates = false;
let isInstallingUpdate = false;

const APP_VERSION_LABEL = `v${packageJson.version}`;
const ONBOARDING_FLAG = "synapsehub_onboarding_completed_v0.2.0";
const DENSITY_COMPACT_THRESHOLD = 10;

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
const btnToggleAlwaysOnTop = document.getElementById("btn-toggle-always-on-top") as HTMLButtonElement;

const updateSummary = document.getElementById("update-summary") as HTMLElement;
const updateMeta = document.getElementById("update-meta") as HTMLElement;
const updateProgress = document.getElementById("update-progress") as HTMLElement;
const installRow = document.getElementById("install-row") as HTMLDivElement;
const btnCheckUpdates = document.getElementById("btn-check-updates") as HTMLButtonElement;
const btnInstallUpdate = document.getElementById("btn-install-update") as HTMLButtonElement;

const updateConfirmBackdrop = document.getElementById("update-confirm-backdrop") as HTMLElement;
const updateConfirmTitle = document.getElementById("update-confirm-title") as HTMLElement;
const updateConfirmBody = document.getElementById("update-confirm-body") as HTMLElement;
const btnUpdateCancel = document.getElementById("btn-update-cancel") as HTMLButtonElement;
const btnUpdateConfirm = document.getElementById("btn-update-confirm") as HTMLButtonElement;
const toastRegion = document.getElementById("toast-region") as HTMLElement;

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

// ─── Stats / footer / density ───────────────────────────────────────────────

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
    for (const s of sorted) {
      const card = renderSessionCard(s);
      attachFocusHandler(card, s, invoke);
      sessionList.appendChild(card);
    }
  }

  updateStats();
  document.title =
    sessions.length > 0
      ? `SynapseHub — ${sessions.length} session${sessions.length > 1 ? "s" : ""}`
      : "SynapseHub";
}

// ─── Settings drawer ────────────────────────────────────────────────────────

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

function syncAlwaysOnTopButton(): void {
  if (!btnToggleAlwaysOnTop) return;
  const on = getAlwaysOnTopPreference();
  btnToggleAlwaysOnTop.setAttribute("aria-pressed", String(on));
}

function openDrawer(): void {
  drawer.dataset.open = "true";
  drawer.setAttribute("aria-hidden", "false");
  drawerBackdrop.dataset.open = "true";
  syncAlwaysOnTopButton();
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
  if (event.key !== "Escape") return;
  if (drawer.dataset.open === "true") closeDrawer();
  if (!updateConfirmBackdrop.classList.contains("is-hidden")) closeUpdateConfirmModal();
});

if (btnToggleAlwaysOnTop) {
  btnToggleAlwaysOnTop.addEventListener("click", () => {
    const next = btnToggleAlwaysOnTop.getAttribute("aria-pressed") !== "true";
    btnToggleAlwaysOnTop.setAttribute("aria-pressed", String(next));
    setAlwaysOnTopToggle(next, invoke);
  });
}

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
      btnCopyConfig.appendChild(buildCopyIcon());
      btnCopyConfig.appendChild(document.createTextNode(" Copier"));
      if (modalStatus.textContent === "Configuration copiée") modalStatus.textContent = "";
    }, 1800);
  } catch {
    modalStatus.textContent = "Échec de la copie";
  }
});

// ─── Updates ────────────────────────────────────────────────────────────────

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

/**
 * v0.2.1 update flow (#39): the "Installer" button no longer launches the
 * install pipeline directly. It opens a confirmation modal that explains
 * the app must quit before the installer can swap the binary, and only the
 * "Quitter et installer" button in that modal triggers the actual download
 * + install + clean exit sequence.
 */
function openUpdateConfirmModal(): void {
  if (!availableUpdate) {
    return;
  }
  updateConfirmTitle.textContent = `SynapseHub v${availableUpdate.version} est prêt`;
  updateConfirmBody.textContent =
    "SynapseHub doit se fermer pour que l'installeur puisse remplacer le binaire. Tes sessions Claude détectées seront re-scannées au redémarrage.";
  updateConfirmBackdrop.classList.remove("is-hidden");
}

function closeUpdateConfirmModal(): void {
  updateConfirmBackdrop.classList.add("is-hidden");
}

async function confirmInstallAndQuit(): Promise<void> {
  closeUpdateConfirmModal();
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
    // Download + spawn installer via the Tauri updater plugin. On Windows
    // the NSIS installer needs the running binary to release its file lock,
    // so we follow up with `quit_and_install_update` to make our exit
    // explicit (logged + app.exit(0)) instead of relying on the plugin
    // doing it implicitly.
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
          updateProgress.textContent = "Paquet reçu, redémarrage…";
          break;
      }
    });
    // If we get here, the installer has been spawned. Ask Rust to exit
    // cleanly so the file lock is released before NSIS proceeds.
    await handleQuitAndInstall(invoke, toastRegion);
  } catch (err) {
    setUpdateDisplay(
      "Installation interrompue",
      "La mise à jour n'a pas pu être appliquée. La version actuelle reste intacte.",
      "Consultez la console pour le détail technique.",
    );
    showToast(toastRegion, {
      tone: "error",
      title: "Mise à jour échouée",
      message: "Tu peux télécharger manuellement la dernière version sur",
      link: {
        href: "https://github.com/thierryvm/SynapseHub/releases",
        label: "github.com/thierryvm/SynapseHub/releases",
      },
      duration: 8000,
    });
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
btnInstallUpdate.addEventListener("click", () => openUpdateConfirmModal());

attachUpdateConfirmHandlers(btnUpdateCancel, btnUpdateConfirm, {
  onCancel: closeUpdateConfirmModal,
  onConfirm: () => void confirmInstallAndQuit(),
});

// Esc + backdrop click also dismiss the modal (consistency with the drawer
// and onboarding modal patterns).
updateConfirmBackdrop.addEventListener("click", (event) => {
  if (event.target === updateConfirmBackdrop) closeUpdateConfirmModal();
});

// ─── Onboarding (3 slides, persisted in localStorage) ─────────────────

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
      "Cliquez sur le bouton flèche d'une session pour amener la fenêtre Windows Terminal / IDE au premier plan. Le bouton ",
      { code: "Toujours au premier plan" },
      " des paramètres garde SynapseHub par-dessus si vous le souhaitez.",
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

// ─── Window controls ────────────────────────────────────────────────────────

btnMinimize.addEventListener("click", () => {
  invoke("hide_window").catch(console.error);
});

btnClose.addEventListener("click", () => {
  invoke("quit_app").catch(console.error);
});

// ─── Tauri events ───────────────────────────────────────────────────────────

listen<AgentSession[]>("agents-updated", (event) => {
  sessions = event.payload;
  render();
});

/**
 * Re-applies the persisted alwaysOnTop preference whenever the dashboard
 * regains focus. The focus action temporarily disables alwaysOnTop so the
 * IDE window can come to the foreground; once the user comes back to
 * SynapseHub (tray click, Alt+Tab, etc.) we honour their toggle preference
 * again.
 */
async function setupFocusListener(): Promise<void> {
  try {
    const win = getCurrentWindow();
    await win.onFocusChanged(({ payload: focused }) => {
      if (focused && getAlwaysOnTopPreference()) {
        invoke("set_always_on_top", { onTop: true }).catch((err) =>
          console.error("set_always_on_top(true) on focus failed:", err),
        );
      }
    });
  } catch (err) {
    console.error("Failed to wire onFocusChanged listener:", err);
  }
}

// ─── Init ───────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  // Restore the user's alwaysOnTop preference (handoff §5 — Fix 3).
  // Default OFF; only invokes Rust when the user explicitly enabled it.
  restoreAlwaysOnTopFromStorage(invoke);
  syncAlwaysOnTopButton();
  void setupFocusListener();

  try {
    sessions = await invoke<AgentSession[]>("get_sessions");
  } catch (err) {
    console.error("Failed to load initial sessions:", err);
    sessions = [];
  }
  render();

  // v0.2.1 update flow (#39): if the previous run stamped a different
  // version in localStorage, surface a quiet "updated to vX" toast and
  // refresh the stored value. First launch silently stamps without toasting.
  notifyUpdateSuccessIfNeeded(packageJson.version, toastRegion);

  try {
    if (!localStorage.getItem(ONBOARDING_FLAG)) openOnboarding();
  } catch {
    /* localStorage blocked — skip onboarding gracefully */
  }

  void checkForUpdates(false);
}

void init();

// Re-export the storage key so callers (and tests) can clear the toggle
// without hard-coding the literal.
export { ALWAYS_ON_TOP_KEY };
