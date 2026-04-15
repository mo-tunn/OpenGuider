export function createPlanView({ doc = document, dom }) {
  function renderPlan(plan) {
    if (!dom.planPanel || !dom.planSteps || !dom.planGoal || !dom.planProgress) {
      return;
    }

    if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
      dom.planPanel.classList.add("hidden");
      dom.planSteps.innerHTML = "";
      dom.planGoal.textContent = "";
      dom.planProgress.textContent = "";
      return;
    }

    dom.planPanel.classList.remove("hidden");
    dom.planGoal.textContent = plan.goal || "Active plan";
    dom.planProgress.textContent = `${Math.min(plan.currentStepIndex + 1, plan.steps.length)}/${plan.steps.length}`;
    dom.planSteps.innerHTML = "";

    plan.steps.forEach((step, index) => {
      const item = doc.createElement("div");
      item.className = `plan-step ${step.status || "pending"}`;

      const badge = doc.createElement("span");
      badge.className = "plan-step-badge";
      badge.textContent = `${index + 1}`;

      const body = doc.createElement("div");
      body.className = "plan-step-body";

      const title = doc.createElement("div");
      title.className = "plan-step-title";
      title.textContent = step.title;

      const instruction = doc.createElement("div");
      instruction.className = "plan-step-instruction";
      instruction.textContent = step.instruction;

      body.appendChild(title);
      body.appendChild(instruction);
      item.appendChild(badge);
      item.appendChild(body);
      dom.planSteps.appendChild(item);
    });
  }

  return {
    renderPlan,
  };
}
