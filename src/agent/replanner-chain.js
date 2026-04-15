const { normalizePlan } = require("../session/session-schema");
const { invokeStructuredChain } = require("./llm-client");
const { PlannerResultSchema } = require("./schemas");

const REPLANNER_SYSTEM_PROMPT = [
  "You repair task plans for a human-guidance desktop assistant.",
  "When the user is off-path or blocked, rewrite the remaining plan so it matches the apparent screen state.",
  "Do not repeat already-completed steps.",
  "Always return valid JSON only.",
].join(" ");

const REPLANNER_TEMPLATE = `
Original goal:
{{goal}}

Current active step:
{{currentStep}}

Current plan:
{{currentPlan}}

Latest evaluator output:
{{evaluation}}

Return JSON with this shape:
{
  "goal": "string",
  "assistantResponse": "Explain that the plan has been updated.",
  "assumptions": ["string"],
  "steps": [
    {
      "id": "snake_case_id",
      "title": "short title",
      "instruction": "single step instruction",
      "successCriteria": "how success is detected",
      "guidanceMode": "point_and_explain or explain_only",
      "requiresScreenshotCheck": true,
      "canUserMarkDone": true,
      "fallbackHints": ["hint"]
    }
  ]
}
`;

async function replanGoal({ plan, step, evaluation, images, settings, signal }) {
  const result = await invokeStructuredChain({
    settings,
    systemPrompt: REPLANNER_SYSTEM_PROMPT,
    template: REPLANNER_TEMPLATE,
    operationName: "replanner",
    input: {
      goal: plan?.goal || "",
      currentStep: step ? `${step.title}: ${step.instruction}` : "No active step.",
      currentPlan: JSON.stringify(plan || {}, null, 2),
      evaluation: JSON.stringify(evaluation || {}, null, 2),
    },
    images,
    history: [],
    schema: PlannerResultSchema,
    signal,
  });

  return {
    assistantResponse: result.value.assistantResponse,
    plan: normalizePlan({
      goal: result.value.goal,
      assumptions: result.value.assumptions,
      steps: result.value.steps,
      currentStepIndex: 0,
      status: "active",
    }),
  };
}

module.exports = {
  replanGoal,
};
