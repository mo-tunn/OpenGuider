const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizePlan } = require("../../src/session/session-schema");

test("normalizePlan marks current step as active and previous as completed", () => {
  const plan = normalizePlan({
    goal: "Test goal",
    currentStepIndex: 1,
    steps: [
      { title: "Step 1", instruction: "One", successCriteria: "Done 1" },
      { title: "Step 2", instruction: "Two", successCriteria: "Done 2" },
      { title: "Step 3", instruction: "Three", successCriteria: "Done 3" },
    ],
  });

  assert.equal(plan.steps[0].status, "completed");
  assert.equal(plan.steps[1].status, "active");
  assert.equal(plan.steps[2].status, "pending");
});
