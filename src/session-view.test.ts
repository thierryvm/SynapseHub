import { describe, expect, it } from "vitest";
import {
  formatDuration,
  projectNameFromPath,
  sortSessions,
  summarizeSessions,
  type AgentSession,
} from "./session-view";

function makeSession(overrides: Partial<AgentSession>): AgentSession {
  return {
    pid: 42,
    project_name: "SynapseHub",
    project_path: "F:/PROJECTS/Apps/SynapseHub",
    ide_name: "Claude Code",
    git_branch: "main",
    status: { type: "Running", since_secs: 120 },
    lock_file: "lock",
    ...overrides,
  };
}

describe("formatDuration", () => {
  it("formats short durations", () => {
    expect(formatDuration(42)).toBe("42s");
  });

  it("formats mixed minutes and seconds", () => {
    expect(formatDuration(125)).toBe("2m5s");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(3720)).toBe("1h2m");
  });
});

describe("projectNameFromPath", () => {
  it("extracts the last segment from Windows paths", () => {
    expect(projectNameFromPath("F:\\PROJECTS\\Apps\\SynapseHub")).toBe("SynapseHub");
  });
});

describe("sortSessions", () => {
  it("prioritizes waiting sessions, then running, then idle", () => {
    const sessions = sortSessions([
      makeSession({ pid: 1, status: { type: "Idle" } }),
      makeSession({ pid: 2, status: { type: "Running", since_secs: 12 } }),
      makeSession({ pid: 3, status: { type: "Waiting", since_secs: 6 } }),
    ]);

    expect(sessions.map((session) => session.status.type)).toEqual(["Waiting", "Running", "Idle"]);
  });
});

describe("summarizeSessions", () => {
  it("returns a calm summary with no active sessions", () => {
    const summary = summarizeSessions([makeSession({ status: { type: "Idle" } })]);

    expect(summary.activeCount).toBe(0);
    expect(summary.title).toContain("Prêt");
  });

  it("returns an attention summary when waiting sessions exist", () => {
    const summary = summarizeSessions([
      makeSession({ status: { type: "Waiting", since_secs: 18 } }),
      makeSession({ pid: 2, project_path: "F:/PROJECTS/Apps/Other", status: { type: "Running", since_secs: 52 } }),
    ]);

    expect(summary.waitingCount).toBe(1);
    expect(summary.title).toContain("attention");
    expect(summary.trackedProjects).toBe(2);
  });
});
