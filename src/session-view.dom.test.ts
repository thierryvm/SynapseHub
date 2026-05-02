/**
 * @vitest-environment jsdom
 *
 * DOM-level interaction tests for session-view.ts. These complement the
 * pure-utility tests in session-view.test.ts (which run in node) and cover
 * the regressions surfaced during the v0.1.5 → v0.2.0 smoke tests:
 *
 * - Click on the focus button must invoke `focus_window`
 * - Click on the rest of the card must NOT invoke anything
 * - Successful focus must invoke `set_always_on_top(false)` (NOT
 *   `hide_window` like v0.1.5 used to do)
 * - Failed focus must NOT invoke `set_always_on_top`
 * - Waiting status acknowledges before focusing
 *
 * Plus the alwaysOnTop toggle helpers (set / restore / default).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  ACTIVE_FILTER_KEY,
  ALWAYS_ON_TOP_KEY,
  attachFocusHandler,
  attachUpdateConfirmHandlers,
  clearActiveFilter,
  filterSessions,
  getActiveFilter,
  getKeepTaskbarPreference,
  handleQuitAndInstall,
  KEEP_TASKBAR_KEY,
  LAST_VERSION_KEY,
  nextFilterAfterClick,
  notifyUpdateSuccessIfNeeded,
  renderSessionCard,
  restoreAlwaysOnTopFromStorage,
  restoreKeepTaskbarFromStorage,
  setActiveFilter,
  setAlwaysOnTopToggle,
  setKeepTaskbarToggle,
  setMaximizeButtonState,
  setStatsCardActiveStates,
  showToast,
  type ActiveFilter,
  type AgentSession,
} from "./session-view";

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    pid: 4242,
    project_name: "SynapseHub",
    project_path: "F:/PROJECTS/Apps/SynapseHub",
    ide_name: "Claude Code Terminal",
    git_branch: "main",
    status: { type: "Running", since_secs: 120 },
    lock_file: "process_F:/PROJECTS/Apps/SynapseHub",
    ...overrides,
  };
}

/**
 * Waits for any microtasks (`Promise.resolve().then(...)`) queued during a
 * click handler to flush before assertions run. Two `await Promise.resolve()`
 * cover the chained `.then(...)` of `focus_window` → `set_always_on_top`.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Session card focus interaction", () => {
  test("click on .card-focus button triggers focus_window invoke", async () => {
    const invokeMock = vi.fn().mockResolvedValue(true);
    const session = makeSession();
    const card = renderSessionCard(session);
    attachFocusHandler(card, session, invokeMock);

    const focusBtn = card.querySelector<HTMLButtonElement>('button[data-action="focus"]');
    expect(focusBtn).not.toBeNull();
    focusBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await flushMicrotasks();

    const focusCall = invokeMock.mock.calls.find((call) => call[0] === "focus_window");
    expect(focusCall).toBeDefined();
    expect(focusCall?.[1]).toEqual({ pid: session.pid });
  });

  test("click on neutral card area does NOT trigger focus_window", async () => {
    const invokeMock = vi.fn();
    const session = makeSession();
    const card = renderSessionCard(session);
    attachFocusHandler(card, session, invokeMock);

    // Click on the project label area (neutral zone, NOT inside the focus button)
    const project = card.querySelector(".session-project");
    expect(project).not.toBeNull();
    project?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // Click on the IDE glyph slot
    const ide = card.querySelector(".session-ide");
    expect(ide).not.toBeNull();
    ide?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // Click on the card itself
    card.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await flushMicrotasks();

    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("focus_window true triggers set_always_on_top(false)", async () => {
    const invokeMock = vi
      .fn()
      .mockImplementation((cmd: string) =>
        cmd === "focus_window" ? Promise.resolve(true) : Promise.resolve(undefined),
      );
    const session = makeSession();
    const card = renderSessionCard(session);
    attachFocusHandler(card, session, invokeMock);

    card
      .querySelector<HTMLButtonElement>('button[data-action="focus"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await flushMicrotasks();

    expect(invokeMock).toHaveBeenCalledWith("focus_window", { pid: session.pid });
    expect(invokeMock).toHaveBeenCalledWith("set_always_on_top", { onTop: false });
    // hide_window should NOT be called (regression check vs v0.1.5)
    expect(invokeMock).not.toHaveBeenCalledWith("hide_window", expect.anything());
  });

  test("focus_window false does NOT trigger set_always_on_top", async () => {
    const invokeMock = vi
      .fn()
      .mockImplementation((cmd: string) =>
        cmd === "focus_window" ? Promise.resolve(false) : Promise.resolve(undefined),
      );
    const session = makeSession();
    const card = renderSessionCard(session);
    attachFocusHandler(card, session, invokeMock);

    // Silence the expected console.warn so the test output stays clean.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    card
      .querySelector<HTMLButtonElement>('button[data-action="focus"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await flushMicrotasks();

    expect(invokeMock).toHaveBeenCalledWith("focus_window", { pid: session.pid });
    expect(invokeMock).not.toHaveBeenCalledWith("set_always_on_top", expect.anything());
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  test("Waiting status triggers acknowledge_waiting before focus", async () => {
    const invokeMock = vi
      .fn()
      .mockImplementation((cmd: string) =>
        cmd === "focus_window" ? Promise.resolve(true) : Promise.resolve(undefined),
      );
    const session = makeSession({ status: { type: "Waiting", since_secs: 30 } });
    const card = renderSessionCard(session);
    attachFocusHandler(card, session, invokeMock);

    card
      .querySelector<HTMLButtonElement>('button[data-action="focus"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await flushMicrotasks();

    const ackCall = invokeMock.mock.calls.findIndex((call) => call[0] === "acknowledge_waiting");
    const focusCall = invokeMock.mock.calls.findIndex((call) => call[0] === "focus_window");

    expect(ackCall).toBeGreaterThanOrEqual(0);
    expect(focusCall).toBeGreaterThanOrEqual(0);
    // Acknowledgement is fired first (synchronously) so the marker clears
    // even if the focus path errors out.
    expect(ackCall).toBeLessThan(focusCall);
    expect(invokeMock).toHaveBeenCalledWith("acknowledge_waiting", { projectPath: session.project_path });
  });
});

describe("AlwaysOnTop settings toggle", () => {
  test("toggle ON saves to localStorage and invokes set_always_on_top(true)", () => {
    const invokeMock = vi.fn().mockResolvedValue(undefined);

    setAlwaysOnTopToggle(true, invokeMock);

    expect(localStorage.getItem(ALWAYS_ON_TOP_KEY)).toBe("true");
    expect(invokeMock).toHaveBeenCalledWith("set_always_on_top", { onTop: true });
  });

  test("toggle OFF saves to localStorage and invokes set_always_on_top(false)", () => {
    const invokeMock = vi.fn().mockResolvedValue(undefined);
    localStorage.setItem(ALWAYS_ON_TOP_KEY, "true");

    setAlwaysOnTopToggle(false, invokeMock);

    expect(localStorage.getItem(ALWAYS_ON_TOP_KEY)).toBe("false");
    expect(invokeMock).toHaveBeenCalledWith("set_always_on_top", { onTop: false });
  });

  test("on app load, restores localStorage 'true' preference", () => {
    const invokeMock = vi.fn().mockResolvedValue(undefined);
    localStorage.setItem(ALWAYS_ON_TOP_KEY, "true");

    restoreAlwaysOnTopFromStorage(invokeMock);

    expect(invokeMock).toHaveBeenCalledWith("set_always_on_top", { onTop: true });
  });

  test("default is alwaysOnTop OFF when no localStorage value (no Rust call)", () => {
    const invokeMock = vi.fn().mockResolvedValue(undefined);

    restoreAlwaysOnTopFromStorage(invokeMock);

    // No invoke at all — the Tauri config already has alwaysOnTop=false,
    // so restoring "default" is a no-op and we must not flap the flag.
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

// ─── v0.2.1 hotfix (#39) — clean update flow ──────────────────────────────────

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

describe("Update confirm modal handlers", () => {
  function makeButtons(): { cancelBtn: HTMLButtonElement; confirmBtn: HTMLButtonElement } {
    const cancelBtn = document.createElement("button");
    cancelBtn.id = "btn-update-cancel";
    const confirmBtn = document.createElement("button");
    confirmBtn.id = "btn-update-confirm";
    document.body.appendChild(cancelBtn);
    document.body.appendChild(confirmBtn);
    return { cancelBtn, confirmBtn };
  }

  function makeToastRegion(): HTMLElement {
    const region = document.createElement("div");
    region.id = "toast-region";
    document.body.appendChild(region);
    return region;
  }

  afterEach(() => {
    clearBody();
  });

  test("attachUpdateConfirmHandlers wires both cancel and confirm buttons", () => {
    const { cancelBtn, confirmBtn } = makeButtons();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    attachUpdateConfirmHandlers(cancelBtn, confirmBtn, { onCancel, onConfirm });

    cancelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // cancel handler unaffected by the confirm click
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("handleQuitAndInstall invokes the quit_and_install_update command", async () => {
    const region = makeToastRegion();
    const invokeMock = vi.fn().mockResolvedValue(undefined);

    await handleQuitAndInstall(invokeMock, region);

    expect(invokeMock).toHaveBeenCalledWith("quit_and_install_update");
    // Success path: no toast rendered.
    expect(region.querySelectorAll(".toast").length).toBe(0);
  });

  test("handleQuitAndInstall surfaces an error toast when invoke rejects", async () => {
    const region = makeToastRegion();
    const invokeMock = vi.fn().mockRejectedValue(new Error("boom"));
    // Silence the expected error log to keep test output clean.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleQuitAndInstall(invokeMock, region);

    expect(invokeMock).toHaveBeenCalledWith("quit_and_install_update");
    const toasts = region.querySelectorAll(".toast");
    expect(toasts.length).toBe(1);
    const toast = toasts[0];
    expect(toast.getAttribute("data-tone")).toBe("error");
    expect(toast.textContent).toContain("Mise à jour échouée");
    // The fallback link must point at the public Releases page.
    const link = toast.querySelector("a");
    expect(link?.getAttribute("href")).toContain("github.com/thierryvm/SynapseHub/releases");
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("Post-update toast notification", () => {
  function makeToastRegion(): HTMLElement {
    const region = document.createElement("div");
    region.id = "toast-region";
    document.body.appendChild(region);
    return region;
  }

  afterEach(() => {
    clearBody();
  });

  test("shows success toast and stamps the new version when versions differ", () => {
    const region = makeToastRegion();
    localStorage.setItem(LAST_VERSION_KEY, "0.2.0");

    const shown = notifyUpdateSuccessIfNeeded("0.2.1", region);

    expect(shown).toBe(true);
    const toasts = region.querySelectorAll(".toast");
    expect(toasts.length).toBe(1);
    expect(toasts[0].getAttribute("data-tone")).toBe("success");
    expect(toasts[0].textContent).toContain("0.2.1");
    expect(localStorage.getItem(LAST_VERSION_KEY)).toBe("0.2.1");
  });

  test("first launch is silent but stamps the version for next time", () => {
    const region = makeToastRegion();
    expect(localStorage.getItem(LAST_VERSION_KEY)).toBeNull();

    const shown = notifyUpdateSuccessIfNeeded("0.2.1", region);

    expect(shown).toBe(false);
    expect(region.querySelectorAll(".toast").length).toBe(0);
    // Storage is stamped so the next true upgrade triggers the toast.
    expect(localStorage.getItem(LAST_VERSION_KEY)).toBe("0.2.1");
  });

  test("showToast renders the expected DOM shape (icon + body + close)", () => {
    const region = makeToastRegion();

    showToast(region, {
      tone: "success",
      title: "Test",
      message: "Body",
      duration: 0,
    });

    const toast = region.querySelector(".toast");
    expect(toast).not.toBeNull();
    expect(toast?.querySelector(".toast-icon")).not.toBeNull();
    expect(toast?.querySelector(".toast-body")).not.toBeNull();
    expect(toast?.querySelector(".toast-close")).not.toBeNull();
    // Title + message are rendered as text nodes.
    expect(toast?.querySelector(".toast-body")?.textContent).toContain("Test");
    expect(toast?.querySelector(".toast-body")?.textContent).toContain("Body");
  });
});

// ─── v0.3.0 Vague 1 (#34) — keep-in-taskbar toggle ───────────────────────────

describe("KeepTaskbar settings toggle", () => {
  test("toggle ON saves to localStorage and invokes set_keep_taskbar(keep: true)", () => {
    const invokeMock = vi.fn().mockResolvedValue(undefined);

    setKeepTaskbarToggle(true, invokeMock);

    expect(localStorage.getItem(KEEP_TASKBAR_KEY)).toBe("true");
    expect(invokeMock).toHaveBeenCalledWith("set_keep_taskbar", { keep: true });
  });

  test("toggle OFF saves to localStorage and invokes set_keep_taskbar(keep: false)", () => {
    const invokeMock = vi.fn().mockResolvedValue(undefined);
    localStorage.setItem(KEEP_TASKBAR_KEY, "true");

    setKeepTaskbarToggle(false, invokeMock);

    expect(localStorage.getItem(KEEP_TASKBAR_KEY)).toBe("false");
    expect(invokeMock).toHaveBeenCalledWith("set_keep_taskbar", { keep: false });
  });

  test("on app load, restores localStorage 'true' preference", () => {
    const invokeMock = vi.fn().mockResolvedValue(undefined);
    localStorage.setItem(KEEP_TASKBAR_KEY, "true");

    restoreKeepTaskbarFromStorage(invokeMock);

    expect(invokeMock).toHaveBeenCalledWith("set_keep_taskbar", { keep: true });
  });

  test("default is keepTaskbar OFF when no localStorage value (no Rust call)", () => {
    const invokeMock = vi.fn().mockResolvedValue(undefined);

    restoreKeepTaskbarFromStorage(invokeMock);

    // No invoke at all — the Tauri config already has skipTaskbar=true,
    // so restoring "default" is a no-op and we must not flap the flag.
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("getKeepTaskbarPreference returns false by default, true when stored", () => {
    expect(getKeepTaskbarPreference()).toBe(false);

    localStorage.setItem(KEEP_TASKBAR_KEY, "true");
    expect(getKeepTaskbarPreference()).toBe(true);

    localStorage.setItem(KEEP_TASKBAR_KEY, "false");
    expect(getKeepTaskbarPreference()).toBe(false);
  });
});

// ─── v0.3.0 Vague 1 (#33) — maximize/restore button state ────────────────────

describe("Maximize button state", () => {
  function makeButton(): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.id = "btn-maximize";
    btn.dataset.maximized = "false";
    document.body.appendChild(btn);
    return btn;
  }

  afterEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  });

  test("setMaximizeButtonState(true) swaps to restore icon + 'Restaurer' label", () => {
    const btn = makeButton();
    btn.appendChild(document.createTextNode("placeholder"));

    setMaximizeButtonState(btn, true);

    expect(btn.dataset.maximized).toBe("true");
    expect(btn.getAttribute("aria-label")).toBe("Restaurer");
    expect(btn.getAttribute("title")).toBe("Restaurer");
    // Restore icon is built with both a path (back-square) and a rect (front-square).
    const svg = btn.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.querySelector("path")).not.toBeNull();
    expect(svg?.querySelector("rect")).not.toBeNull();
    // Placeholder text node must be gone.
    expect(btn.textContent?.includes("placeholder")).toBe(false);
  });

  test("setMaximizeButtonState(false) swaps to maximize icon + 'Agrandir' label", () => {
    const btn = makeButton();
    setMaximizeButtonState(btn, true);
    expect(btn.dataset.maximized).toBe("true");

    setMaximizeButtonState(btn, false);

    expect(btn.dataset.maximized).toBe("false");
    expect(btn.getAttribute("aria-label")).toBe("Agrandir");
    expect(btn.getAttribute("title")).toBe("Agrandir");
    // Maximize icon = single rect, no extra path.
    const svg = btn.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.querySelectorAll("rect").length).toBe(1);
    expect(svg?.querySelectorAll("path").length).toBe(0);
  });

  test("setMaximizeButtonState toggles back and forth without leftover children", () => {
    const btn = makeButton();
    setMaximizeButtonState(btn, true);
    setMaximizeButtonState(btn, false);
    setMaximizeButtonState(btn, true);

    // Exactly one SVG child after each call (the previous content was cleared).
    expect(btn.children.length).toBe(1);
    expect(btn.children[0].tagName.toLowerCase()).toBe("svg");
  });
});

// ─── v0.3.0 Vague 2b (#35) — interactive stats cards filter ──────────────────

function makeSessions(): AgentSession[] {
  return [
    makeSession({ pid: 1, status: { type: "Running", since_secs: 10 }, project_name: "A" }),
    makeSession({ pid: 2, status: { type: "Running", since_secs: 20 }, project_name: "B" }),
    makeSession({ pid: 3, status: { type: "Waiting", since_secs: 30 }, project_name: "C" }),
    makeSession({ pid: 4, status: { type: "Idle" }, project_name: "D" }),
  ];
}

describe("Active filter persistence (sessionStorage)", () => {
  test("default filter is null when storage is empty", () => {
    expect(getActiveFilter()).toBeNull();
  });

  test("setActiveFilter writes to sessionStorage and getActiveFilter reads it back", () => {
    setActiveFilter("running");
    expect(sessionStorage.getItem(ACTIVE_FILTER_KEY)).toBe("running");
    expect(getActiveFilter()).toBe("running");

    setActiveFilter("waiting");
    expect(sessionStorage.getItem(ACTIVE_FILTER_KEY)).toBe("waiting");
    expect(getActiveFilter()).toBe("waiting");
  });

  test("setActiveFilter(null) removes the storage entry", () => {
    setActiveFilter("running");
    expect(sessionStorage.getItem(ACTIVE_FILTER_KEY)).toBe("running");

    setActiveFilter(null);
    expect(sessionStorage.getItem(ACTIVE_FILTER_KEY)).toBeNull();
    expect(getActiveFilter()).toBeNull();
  });

  test("clearActiveFilter removes the storage entry", () => {
    setActiveFilter("waiting");
    clearActiveFilter();
    expect(sessionStorage.getItem(ACTIVE_FILTER_KEY)).toBeNull();
    expect(getActiveFilter()).toBeNull();
  });

  test("getActiveFilter returns null on invalid stored value", () => {
    sessionStorage.setItem(ACTIVE_FILTER_KEY, "garbage");
    expect(getActiveFilter()).toBeNull();
  });

  test("getActiveFilter does NOT cross-contaminate with localStorage", () => {
    // Defence-in-depth: make sure we only read sessionStorage. If a future
    // refactor accidentally reaches into localStorage, this catches it.
    localStorage.setItem(ACTIVE_FILTER_KEY, "running");
    expect(getActiveFilter()).toBeNull();
  });
});

describe("filterSessions", () => {
  test("null filter is a passthrough", () => {
    const all = makeSessions();
    expect(filterSessions(all, null)).toEqual(all);
  });

  test("'running' filter keeps only Running sessions", () => {
    const all = makeSessions();
    const filtered = filterSessions(all, "running");
    expect(filtered).toHaveLength(2);
    expect(filtered.every((s) => s.status.type === "Running")).toBe(true);
  });

  test("'waiting' filter keeps only Waiting sessions", () => {
    const all = makeSessions();
    const filtered = filterSessions(all, "waiting");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].status.type).toBe("Waiting");
  });

  test("filter on empty sessions array returns empty array", () => {
    expect(filterSessions([], "running")).toEqual([]);
    expect(filterSessions([], "waiting")).toEqual([]);
    expect(filterSessions([], null)).toEqual([]);
  });
});

describe("nextFilterAfterClick toggle behavior (option θ)", () => {
  test("click on currently-active card clears the filter", () => {
    expect(nextFilterAfterClick("running", "running")).toBeNull();
    expect(nextFilterAfterClick("waiting", "waiting")).toBeNull();
  });

  test("click on a different card swaps the filter without intermediate null", () => {
    expect(nextFilterAfterClick("running", "waiting")).toBe("waiting");
    expect(nextFilterAfterClick("waiting", "running")).toBe("running");
  });

  test("click on either card from null filter activates that card", () => {
    expect(nextFilterAfterClick(null, "running")).toBe("running");
    expect(nextFilterAfterClick(null, "waiting")).toBe("waiting");
  });
});

describe("setStatsCardActiveStates aria-pressed", () => {
  function makeStatCards(): { running: HTMLButtonElement; waiting: HTMLButtonElement } {
    const running = document.createElement("button");
    running.id = "stat-card-active";
    running.setAttribute("aria-pressed", "false");
    const waiting = document.createElement("button");
    waiting.id = "stat-card-waiting";
    waiting.setAttribute("aria-pressed", "false");
    document.body.appendChild(running);
    document.body.appendChild(waiting);
    return { running, waiting };
  }

  afterEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  });

  test("running filter sets aria-pressed=true on running card only", () => {
    const cards = makeStatCards();
    setStatsCardActiveStates(cards, "running");
    expect(cards.running.getAttribute("aria-pressed")).toBe("true");
    expect(cards.waiting.getAttribute("aria-pressed")).toBe("false");
  });

  test("waiting filter sets aria-pressed=true on waiting card only", () => {
    const cards = makeStatCards();
    setStatsCardActiveStates(cards, "waiting");
    expect(cards.running.getAttribute("aria-pressed")).toBe("false");
    expect(cards.waiting.getAttribute("aria-pressed")).toBe("true");
  });

  test("null filter clears aria-pressed on both cards", () => {
    const cards = makeStatCards();
    cards.running.setAttribute("aria-pressed", "true");
    cards.waiting.setAttribute("aria-pressed", "true");
    setStatsCardActiveStates(cards, null);
    expect(cards.running.getAttribute("aria-pressed")).toBe("false");
    expect(cards.waiting.getAttribute("aria-pressed")).toBe("false");
  });

  test("toggle round-trip preserves the right card per filter", () => {
    const cards = makeStatCards();
    const sequence: ActiveFilter[] = ["running", "waiting", null, "running"];
    for (const f of sequence) {
      setStatsCardActiveStates(cards, f);
      expect(cards.running.getAttribute("aria-pressed")).toBe(String(f === "running"));
      expect(cards.waiting.getAttribute("aria-pressed")).toBe(String(f === "waiting"));
    }
  });
});
