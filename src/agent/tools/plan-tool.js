function updatePlanTool({ sessionManager, plan }) {
  sessionManager.setActivePlan(plan);
  return sessionManager.getSnapshot().activePlan;
}

function requestUserInputTool({ step }) {
  return {
    kind: "user_input_required",
    stepId: step?.id || null,
    message: step?.instruction || "Please complete the current step and let me re-check the screen.",
  };
}

module.exports = {
  requestUserInputTool,
  updatePlanTool,
};
