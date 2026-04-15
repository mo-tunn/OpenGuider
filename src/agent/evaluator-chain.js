const { invokeStructuredChain } = require("./llm-client");
const { EvaluationSchema } = require("./schemas");

const EVALUATOR_SYSTEM_PROMPT = [
  "You evaluate whether a human has completed the current UI step on screen.",
  "Be conservative. If the screenshot does not clearly prove success, prefer not_done or uncertain.",
  "Recommend replan only when the user appears to be in a different flow or blocked.",
  "Always return valid JSON only.",
].join(" ");

const EVALUATOR_TEMPLATE = `
Goal:
{{goal}}

Step title:
{{stepTitle}}

Step instruction:
{{instruction}}

Success criteria:
{{successCriteria}}

Optional user note:
{{userNote}}

Return JSON:
{
  "status": "done" | "not_done" | "blocked" | "uncertain",
  "confidence": 0.0,
  "rationale": "short explanation",
  "suggestedAction": "repeat_guidance" | "advance" | "replan",
  "assistantResponse": "short user-facing feedback"
}
`;

async function evaluateStep({ plan, step, images, settings, userNote, signal }) {
  const result = await invokeStructuredChain({
    settings,
    systemPrompt: EVALUATOR_SYSTEM_PROMPT,
    template: EVALUATOR_TEMPLATE,
    operationName: "evaluator",
    input: {
      goal: plan?.goal || "",
      stepTitle: step?.title || "",
      instruction: step?.instruction || "",
      successCriteria: step?.successCriteria || "",
      userNote: userNote || "No note.",
    },
    images,
    history: [],
    schema: EvaluationSchema,
    signal,
  });

  return result.value;
}

module.exports = {
  evaluateStep,
};
