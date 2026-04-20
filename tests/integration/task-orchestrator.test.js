const test = require("node:test");
const assert = require("node:assert/strict");

const { SessionManager } = require("../../src/session/session-manager");
const { TaskOrchestrator } = require("../../src/agent/task-orchestrator");

test("markStepDone completes single-step plan in manual confirmation flow", async () => {
  const sessionManager = new SessionManager();
  const orchestrator = new TaskOrchestrator({
    captureAllScreens: async () => [],
    sessionManager,
    prePostLayersEnabled: false,
  });

  sessionManager.setActivePlan({
    goal: "Single step flow",
    currentStepIndex: 0,
    steps: [
      {
        id: "step_1",
        title: "Only step",
        instruction: "Do one thing",
        successCriteria: "Done",
      },
    ],
    status: "active",
  });
  sessionManager.setManualConfirmation({ stepId: "step_1", reason: "test" });

  const result = await orchestrator.markStepDone({ settings: {}, signal: null });
  assert.equal(result.pointer, null);
  assert.match(result.assistantMessage, /complete/i);
  assert.equal(result.session.activePlan, null);
  assert.equal(result.session.status, "idle");
});
