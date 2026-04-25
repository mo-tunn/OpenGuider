const test = require("node:test");
const assert = require("node:assert/strict");

const { SessionManager } = require("../../src/session/session-manager");

test("session manager tracks browser execution lifecycle and clones snapshots", () => {
  const sessionManager = new SessionManager();

  sessionManager.startBrowserExecution({
    taskId: "task-1",
    goal: "Open checkout",
    mode: "auto",
    trustLevel: "autopilot",
    status: "running",
    startedAt: "2026-04-24T10:00:00.000Z",
  });

  sessionManager.upsertBrowserExecutionSubstepStart({
    id: "1",
    stepNumber: 1,
    actionType: "go_to_url",
    description: "Open the site",
    riskScore: 2,
    startedAt: "2026-04-24T10:00:01.000Z",
  });

  sessionManager.upsertBrowserExecutionSubstepEnd({
    id: "1",
    stepNumber: 1,
    actionType: "go_to_url",
    description: "Open the site",
    riskScore: 2,
    status: "done",
    message: "Loaded",
    finishedAt: "2026-04-24T10:00:03.000Z",
  });

  sessionManager.finishBrowserExecution({
    status: "success",
    finalMessage: "Completed successfully",
    finishedAt: "2026-04-24T10:01:00.000Z",
  });

  const snapshot = sessionManager.getSnapshot();
  assert.equal(snapshot.browserExecution.goal, "Open checkout");
  assert.equal(snapshot.browserExecution.status, "success");
  assert.equal(snapshot.browserExecution.finalMessage, "Completed successfully");
  assert.equal(snapshot.browserExecution.substeps.length, 1);
  assert.equal(snapshot.browserExecution.substeps[0].status, "done");
  assert.equal(snapshot.browserExecution.substeps[0].message, "Loaded");

  snapshot.browserExecution.substeps[0].status = "failed";
  assert.equal(sessionManager.getSnapshot().browserExecution.substeps[0].status, "done");

  sessionManager.clearBrowserExecution();
  assert.equal(sessionManager.getSnapshot().browserExecution, null);
});

test("clearSession resets browser execution state", () => {
  const sessionManager = new SessionManager();

  sessionManager.startBrowserExecution({
    taskId: "task-2",
    goal: "Search products",
    mode: "supervised",
    trustLevel: "balanced",
    status: "running",
  });

  assert.ok(sessionManager.getSnapshot().browserExecution);
  sessionManager.clearSession();
  assert.equal(sessionManager.getSnapshot().browserExecution, null);
});
