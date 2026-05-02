import {
  buildAlertIcon,
  buildBranchIcon,
  buildCheckIcon,
  buildCloseIcon,
  buildFocusIcon,
  buildMaximizeIcon,
  buildRestoreIcon,
} from "./icons";

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

/**
 * Minimal contract the renderer needs from `@tauri-apps/api/core`. Defining
 * it here lets us inject a mock in unit tests without pulling Tauri into
 * the test environment.
 */
export type InvokeFn = <T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/** Persisted user preference for the "always on top" window flag. */
export const ALWAYS_ON_TOP_KEY = "synapsehub_always_on_top";

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

// ─── DOM rendering & interaction ────────────────────────────────────────────

/**
 * Builds the DOM tree for one session card. Returns a fresh `<article>` —
 * **no event listeners attached**. Wire interactions via
 * `attachFocusHandler` so the two concerns (markup vs. behaviour) stay
 * independently testable.
 */
export function renderSessionCard(session: AgentSession): HTMLElement {
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
  focusBtn.className = "icon-btn card-focus";
  focusBtn.type = "button";
  focusBtn.dataset.action = "focus";
  focusBtn.setAttribute("aria-label", "Focus IDE");
  focusBtn.title = "Mettre la fenêtre IDE au premier plan";
  if (!canFocus) focusBtn.disabled = true;
  focusBtn.appendChild(buildFocusIcon());
  actions.appendChild(focusBtn);
  card.appendChild(actions);

  return card;
}

/**
 * Wires the focus action on a previously rendered session card.
 *
 * Behaviour (matches v0.2.0 fix focus-UX, see handoff
 * `2026-04-30-1530-v0-2-0-fix-focus-ux-before-tag.md` §5):
 *
 * 1. Click on `BUTTON[data-action="focus"]` (or Enter/Space when the card
 *    has keyboard focus) only triggers the IDE focus flow. **A click on
 *    the rest of the card body is intentionally a no-op** so the user
 *    doesn't accidentally hide the dashboard while reading session info.
 * 2. If the session is `Waiting`, an `acknowledge_waiting` invoke is fired
 *    first so the waiting marker is cleared regardless of whether the
 *    focus succeeds.
 * 3. On `focus_window === true` we invoke `set_always_on_top(false)` so
 *    the IDE window the user just asked for can come to the foreground
 *    even when the user has the alwaysOnTop toggle ON. The
 *    `onFocusChanged` listener in `main.ts` re-applies the toggle when
 *    the dashboard regains focus.
 * 4. On `focus_window === false` we keep the dashboard visible and emit a
 *    `console.warn` so the user can tell the action did nothing (typical
 *    when the terminal closed between detection and click).
 */
export function attachFocusHandler(
  card: HTMLElement,
  session: AgentSession,
  invokeFn: InvokeFn,
): void {
  const focusBtn = card.querySelector<HTMLButtonElement>('button[data-action="focus"]');
  if (!focusBtn) return;

  const trigger = (event: Event) => {
    event.stopPropagation();

    if (session.status.type === "Waiting") {
      void invokeFn("acknowledge_waiting", { projectPath: session.project_path }).catch(
        (err) => console.error(`acknowledge_waiting(${session.project_path}) failed:`, err),
      );
    }

    if (session.pid <= 0) return;

    void invokeFn<boolean>("focus_window", { pid: session.pid })
      .then((focused) => {
        if (focused) {
          // Temporarily release alwaysOnTop so the IDE window actually
          // appears in front. The settings toggle (if user-enabled) is
          // re-applied via the focus-changed listener in main.ts.
          void invokeFn("set_always_on_top", { onTop: false }).catch((err) =>
            console.error("set_always_on_top(false) failed:", err),
          );
        } else {
          console.warn(
            `focus_window(${session.pid}) → no window found in parent chain (terminal may have closed)`,
          );
        }
      })
      .catch((err) => console.error(`focus_window(${session.pid}) failed:`, err));
  };

  focusBtn.addEventListener("click", trigger);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      trigger(event);
    }
  });
}

/**
 * Persists the user preference and pushes it to the Rust side. Called from
 * the settings drawer toggle.
 */
export function setAlwaysOnTopToggle(on: boolean, invokeFn: InvokeFn): void {
  try {
    localStorage.setItem(ALWAYS_ON_TOP_KEY, String(on));
  } catch {
    /* localStorage blocked — preference won't persist across launches but the
       runtime call below still applies for the current session */
  }
  void invokeFn("set_always_on_top", { onTop: on }).catch((err) =>
    console.error("set_always_on_top failed:", err),
  );
}

/**
 * Reads the persisted preference at app start and pushes it to Rust if (and
 * only if) the user explicitly enabled it. Default = OFF (matches
 * `tauri.conf.json` `alwaysOnTop: false`); we therefore skip the invoke when
 * the value is missing or "false" to avoid touching the window state for a
 * no-op.
 */
export function restoreAlwaysOnTopFromStorage(invokeFn: InvokeFn): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(ALWAYS_ON_TOP_KEY);
  } catch {
    return;
  }
  if (stored === "true") {
    void invokeFn("set_always_on_top", { onTop: true }).catch((err) =>
      console.error("set_always_on_top failed:", err),
    );
  }
}

/** Reads the current persisted preference. Returns `false` when missing. */
export function getAlwaysOnTopPreference(): boolean {
  try {
    return localStorage.getItem(ALWAYS_ON_TOP_KEY) === "true";
  } catch {
    return false;
  }
}

// ─── v0.3.0 Vague 1 (#34) — keep-in-taskbar toggle ───────────────────────────

/** Persisted user preference for the "Garder dans la barre des tâches" toggle. */
export const KEEP_TASKBAR_KEY = "synapsehub_keep_taskbar";

/**
 * Persists the user preference and pushes it to the Rust side. Mirrors
 * {@link setAlwaysOnTopToggle} so the two settings rows behave identically.
 *
 * Default OFF preserves the tray-companion pattern: SynapseHub stays out of
 * the taskbar / Dock, minimize sends to tray. When ON, the window appears in
 * the OS taskbar (Windows) or Dock (macOS), and the minimize button switches
 * to OS-native minimize (handled in main.ts).
 */
export function setKeepTaskbarToggle(keep: boolean, invokeFn: InvokeFn): void {
  try {
    localStorage.setItem(KEEP_TASKBAR_KEY, String(keep));
  } catch {
    /* localStorage blocked — preference won't persist across launches but the
       runtime call below still applies for the current session */
  }
  void invokeFn("set_keep_taskbar", { keep }).catch((err) =>
    console.error("set_keep_taskbar failed:", err),
  );
}

/**
 * Reads the persisted preference at app start and pushes it to Rust if (and
 * only if) the user explicitly enabled it. Default = OFF (matches
 * `tauri.conf.json` `skipTaskbar: true`); we therefore skip the invoke when
 * the value is missing or "false" to avoid touching the window state for a
 * no-op.
 */
export function restoreKeepTaskbarFromStorage(invokeFn: InvokeFn): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEEP_TASKBAR_KEY);
  } catch {
    return;
  }
  if (stored === "true") {
    void invokeFn("set_keep_taskbar", { keep: true }).catch((err) =>
      console.error("set_keep_taskbar failed:", err),
    );
  }
}

/** Reads the current persisted preference. Returns `false` when missing. */
export function getKeepTaskbarPreference(): boolean {
  try {
    return localStorage.getItem(KEEP_TASKBAR_KEY) === "true";
  } catch {
    return false;
  }
}

// ─── v0.3.0 Vague 1 (#33) — maximize/restore button state ────────────────────

/**
 * Swaps the maximize button SVG between "maximize" (single rounded square)
 * and "restore" (two overlapping squares) and updates the accessible label.
 * Drives both visual feedback and screen reader state.
 *
 * Built via `document.createElementNS` (no innerHTML, security hook compliant);
 * the button's existing children are removed and the new SVG appended.
 *
 * The `data-maximized` attribute mirrors the state so CSS can theme the
 * button differently if needed and tests can assert on it without inspecting
 * the SVG markup directly.
 */
export function setMaximizeButtonState(button: HTMLButtonElement, maximized: boolean): void {
  while (button.firstChild) button.removeChild(button.firstChild);
  button.appendChild(maximized ? buildRestoreIcon() : buildMaximizeIcon());
  const label = maximized ? "Restaurer" : "Agrandir";
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.dataset.maximized = String(maximized);
}

// ─── v0.2.1 — update flow (#39 single-instance + clean update) ──────────────

/** Persisted key that lets us detect "the version on disk just changed". */
export const LAST_VERSION_KEY = "synapsehub_last_version";

/** Default release page used as the fallback in update-failure toasts. */
export const RELEASES_URL = "https://github.com/thierryvm/SynapseHub/releases";

/** Subset of {@link Storage} we actually touch. Lets tests inject a fake. */
export type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Toast payload — a small, intentionally minimal object so the helper stays
 * easy to assert on in unit tests. */
export interface ToastOptions {
  /** Visual + semantic tone. `info` is the default if omitted. */
  tone?: "info" | "success" | "error";
  title: string;
  /** Optional second line. May contain `<a>` links via {@link link}. */
  message?: string;
  /** Auto-dismiss in ms. `0` means sticky (user closes via the X button). */
  duration?: number;
  /** Optional anchor displayed inside the message line. */
  link?: { href: string; label: string };
}

/**
 * Renders a toast inside `region` and (unless `duration === 0`) auto-dismisses
 * it. Returns the created element so callers / tests can inspect it.
 *
 * Built entirely with `document.createElement` — no innerHTML, no DOM
 * sanitiser dependency. The CSS lives in `src/styles/components/toast.css`.
 */
export function showToast(region: HTMLElement, opts: ToastOptions): HTMLElement {
  const tone = opts.tone ?? "info";
  const duration = opts.duration ?? 4000;

  const el = document.createElement("div");
  el.className = "toast";
  el.dataset.tone = tone;
  el.setAttribute("role", "status");

  const iconWrap = document.createElement("div");
  iconWrap.className = "toast-icon";
  iconWrap.appendChild(tone === "success" ? buildCheckIcon() : buildAlertIcon());
  el.appendChild(iconWrap);

  const body = document.createElement("div");
  body.className = "toast-body";
  const titleEl = document.createElement("div");
  titleEl.className = "toast-title";
  titleEl.textContent = opts.title;
  body.appendChild(titleEl);
  if (opts.message || opts.link) {
    const msg = document.createElement("div");
    msg.className = "toast-msg";
    if (opts.message) msg.appendChild(document.createTextNode(opts.message));
    if (opts.link) {
      if (opts.message) msg.appendChild(document.createTextNode(" "));
      const a = document.createElement("a");
      a.href = opts.link.href;
      a.textContent = opts.link.label;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      msg.appendChild(a);
    }
    body.appendChild(msg);
  }
  el.appendChild(body);

  const close = document.createElement("button");
  close.className = "toast-close";
  close.type = "button";
  close.setAttribute("aria-label", "Fermer");
  close.appendChild(buildCloseIcon());
  close.addEventListener("click", () => el.remove());
  el.appendChild(close);

  region.appendChild(el);

  if (duration > 0) {
    setTimeout(() => el.remove(), duration);
  }

  return el;
}

/**
 * Click-handlers for the "Quitter et installer" modal.
 *
 * Wired separately from {@link openUpdateConfirmModal} (which is a thin
 * CSS-class toggle in main.ts) so that the *behaviour* can be exercised by
 * vitest without needing the full app shell mounted.
 */
export interface UpdateConfirmHandlers {
  onCancel: () => void;
  onConfirm: () => void;
}

/** Wires the cancel + confirm buttons of the update-confirm modal. */
export function attachUpdateConfirmHandlers(
  cancelBtn: HTMLButtonElement,
  confirmBtn: HTMLButtonElement,
  handlers: UpdateConfirmHandlers,
): void {
  cancelBtn.addEventListener("click", handlers.onCancel);
  confirmBtn.addEventListener("click", handlers.onConfirm);
}

/**
 * Surfaces the canonical "update failed" toast: a fallback that points the
 * user at the public Releases page so they can download manually. Shared
 * between `handleQuitAndInstall` (the exit/install command failed) and the
 * `confirmInstallAndQuit` catch block in `main.ts` (the download itself
 * failed). Centralised so the wording and the link stay in sync.
 */
export function showUpdateFailedToast(toastRegion: HTMLElement): void {
  showToast(toastRegion, {
    tone: "error",
    title: "Mise à jour échouée",
    message: "Tu peux télécharger manuellement la dernière version sur",
    link: { href: RELEASES_URL, label: "github.com/thierryvm/SynapseHub/releases" },
    duration: 8000,
  });
}

/**
 * Triggers the Tauri-side `quit_and_install_update` command and surfaces a
 * toast on failure. Caller is responsible for downloading the update first
 * (via `availableUpdate.downloadAndInstall(...)` from `@tauri-apps/plugin-updater`):
 * this helper exists to make the *exit* step itself testable in isolation.
 */
export async function handleQuitAndInstall(
  invokeFn: InvokeFn,
  toastRegion: HTMLElement,
): Promise<void> {
  try {
    await invokeFn("quit_and_install_update");
  } catch (err) {
    console.error("quit_and_install_update failed:", err);
    showUpdateFailedToast(toastRegion);
  }
}

/**
 * Compares the version remembered in `storage` (defaults to `localStorage`)
 * with the running version. If they differ, surfaces a "Mise à jour réussie"
 * toast and persists the new value. First-launch state (no stored value) is
 * silent — we only stamp the storage so the *next* upgrade is detected.
 *
 * Returns `true` if the toast was shown, `false` otherwise (first launch,
 * unchanged version, or storage unavailable).
 */
export function notifyUpdateSuccessIfNeeded(
  currentVersion: string,
  toastRegion: HTMLElement,
  storage: StorageLike = localStorage,
): boolean {
  let stored: string | null;
  try {
    stored = storage.getItem(LAST_VERSION_KEY);
  } catch {
    return false;
  }

  if (stored && stored !== currentVersion) {
    showToast(toastRegion, {
      tone: "success",
      title: "Mise à jour réussie",
      message: `SynapseHub v${currentVersion} est maintenant actif.`,
      duration: 3000,
    });
    try {
      storage.setItem(LAST_VERSION_KEY, currentVersion);
    } catch {
      /* storage might be partially blocked — toast still showed, that's fine */
    }
    return true;
  }

  // First launch (stored === null) or unchanged: stamp the version so the
  // next true upgrade is detected, but stay silent.
  try {
    storage.setItem(LAST_VERSION_KEY, currentVersion);
  } catch {
    /* no-op */
  }
  return false;
}
