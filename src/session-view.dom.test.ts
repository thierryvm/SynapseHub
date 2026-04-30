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
  ALWAYS_ON_TOP_KEY,
  attachFocusHandler,
  renderSessionCard,
  restoreAlwaysOnTopFromStorage,
  setAlwaysOnTopToggle,
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
