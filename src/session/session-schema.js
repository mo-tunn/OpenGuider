const { randomUUID } = require("crypto");

function createEmptySession() {
  return {
    sessionId: randomUUID(),
    messages: [],
    goalIntent: "",
    activePlan: null,
    currentStepId: null,
    manualConfirmation: null,
    lastScreenshots: [],
    evaluationHistory: [],
    status: "idle",
    lastPointer: null,
    updatedAt: new Date().toISOString(),
  };
}

function cloneStep(step = {}, index = 0) {
  return {
    id: step.id || `step_${index + 1}`,
    title: step.title || `Step ${index + 1}`,
    instruction: step.instruction || "",
    successCriteria: step.successCriteria || "",
    guidanceMode: step.guidanceMode || "point_and_explain",
    requiresScreenshotCheck: step.requiresScreenshotCheck !== false,
    canUserMarkDone: step.canUserMarkDone !== false,
    fallbackHints: Array.isArray(step.fallbackHints) ? step.fallbackHints : [],
    status: step.status || "pending",
    coordinate: step.coordinate || null,
    label: step.label || null,
    explanation: step.explanation || "",
  };
}

function normalizePlan(plan = {}) {
  const steps = Array.isArray(plan.steps)
    ? plan.steps.map((step, index) => cloneStep(step, index))
    : [];

  const currentStepIndex = Math.max(
    0,
    Math.min(plan.currentStepIndex || 0, Math.max(steps.length - 1, 0)),
  );

  steps.forEach((step, index) => {
    if (step.status === "completed") {
      return;
    }

    if (index < currentStepIndex) {
      step.status = "completed";
    } else if (index === currentStepIndex) {
      step.status = "active";
    } else {
      step.status = "pending";
    }
  });

  return {
    planId: plan.planId || randomUUID(),
    goal: plan.goal || "",
    assumptions: Array.isArray(plan.assumptions) ? plan.assumptions : [],
    steps,
    currentStepIndex,
    status: plan.status || (steps.length ? "active" : "idle"),
    createdAt: plan.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function getCurrentStep(plan) {
  if (!plan || !Array.isArray(plan.steps)) {
    return null;
  }

  return plan.steps[plan.currentStepIndex] || null;
}

module.exports = {
  cloneStep,
  createEmptySession,
  getCurrentStep,
  normalizePlan,
};
