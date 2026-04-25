const { randomUUID } = require("crypto");

function normalizeExecutionMode(mode) {
  if (mode === "auto") {
    return "auto";
  }
  if (mode === "hitl" || mode === "supervised" || mode === "guide" || mode === "human-in-the-loop") {
    return "hitl";
  }
  return "hitl";
}

function normalizeTrustLevel(trustLevel, mode = "hitl") {
  if (normalizeExecutionMode(mode) === "auto") {
    return "autopilot";
  }
  if (trustLevel === "paranoid") {
    return "paranoid";
  }
  return "balanced";
}

function createEmptySession() {
  return {
    sessionId: randomUUID(),
    messages: [],
    goalIntent: "",
    activePlan: null,
    browserExecution: null,
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

function normalizeBrowserExecutionSubstep(substep = {}, index = 0) {
  const stepNumber = Number(substep.stepNumber);
  return {
    id: substep.id || `browser_substep_${stepNumber || index + 1}`,
    stepNumber: Number.isFinite(stepNumber) && stepNumber > 0 ? stepNumber : index + 1,
    actionType: substep.actionType || "action",
    description: substep.description || "Browser action",
    riskScore: Number(substep.riskScore) || 3,
    status: substep.status || "running",
    message: substep.message || "",
    error: substep.error || null,
    startedAt: substep.startedAt || new Date().toISOString(),
    finishedAt: substep.finishedAt || null,
  };
}

function normalizeBrowserExecution(execution = {}) {
  const mode = normalizeExecutionMode(execution.mode);
  return {
    taskId: execution.taskId || "",
    goal: execution.goal || "",
    pluginId: execution.pluginId || "browser",
    pluginName: execution.pluginName || execution.pluginId || "Browser",
    mode,
    trustLevel: normalizeTrustLevel(execution.trustLevel, mode),
    status: execution.status || "running",
    startedAt: execution.startedAt || new Date().toISOString(),
    finishedAt: execution.finishedAt || null,
    finalMessage: execution.finalMessage || "",
    substeps: Array.isArray(execution.substeps)
      ? execution.substeps.map((substep, index) => normalizeBrowserExecutionSubstep(substep, index))
      : [],
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
  cloneBrowserExecution: normalizeBrowserExecution,
  cloneStep,
  createEmptySession,
  getCurrentStep,
  normalizeBrowserExecution,
  normalizeBrowserExecutionSubstep,
  normalizePlan,
};
