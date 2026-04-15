const { invokeStructuredChain } = require("./llm-client");
const { StepPointerSchema } = require("./schemas");

const LOCATOR_SYSTEM_PROMPT = [
  "You help users complete the current UI step on their screen.",
  "If the target is visible, return normalized coordinates on a 0-1000 scale.",
  "If the target is not visible, return shouldPoint=false and explain what the user should do next.",
  "Always return valid JSON only.",
].join(" ");

const STRICT_LOCATOR_SYSTEM_PROMPT = [
  "You are in strict pointing mode for a desktop guidance assistant.",
  "You MUST return one best-guess click coordinate on a 0-1000 scale.",
  "Never return null coordinates in strict mode.",
  "Even if uncertain, provide the most likely click target and state uncertainty in explanation.",
  "Always set shouldPoint=true in strict mode.",
  "Always return valid JSON only.",
].join(" ");

const LOCATOR_TEMPLATE = `
Goal:
{{goal}}

Current step title:
{{stepTitle}}

Current step instruction:
{{instruction}}

Step success criteria:
{{successCriteria}}

Optional user note:
{{userNote}}

Return JSON with this shape:
{
  "coordinate": { "x": 0, "y": 0 } | null,
  "label": "short target label or null",
  "explanation": "brief helper text for the user",
  "shouldPoint": true
}
`;

async function locateStepTarget({
  plan,
  step,
  images,
  settings,
  userNote,
  signal,
  forcePointing = false,
}) {
  if (!step) {
    return {
      coordinate: null,
      label: null,
      explanation: "",
      shouldPoint: false,
    };
  }

  const result = await invokeStructuredChain({
    settings,
    systemPrompt: LOCATOR_SYSTEM_PROMPT,
    template: LOCATOR_TEMPLATE,
    operationName: "locator",
    input: {
      goal: plan?.goal || "",
      stepTitle: step.title,
      instruction: step.instruction,
      successCriteria: step.successCriteria,
      userNote: userNote || "No note.",
    },
    images,
    history: [],
    schema: StepPointerSchema,
    signal,
  });

  if (
    forcePointing &&
    (!result.value.coordinate || typeof result.value.coordinate.x !== "number" || typeof result.value.coordinate.y !== "number")
  ) {
    const strictResult = await invokeStructuredChain({
      settings,
      systemPrompt: STRICT_LOCATOR_SYSTEM_PROMPT,
      template: LOCATOR_TEMPLATE,
      operationName: "locator_strict",
      input: {
        goal: plan?.goal || "",
        stepTitle: step.title,
        instruction: step.instruction,
        successCriteria: step.successCriteria,
        userNote: `${userNote || "No note."} Strict mode: return the best click coordinate now.`,
      },
      images,
      history: [],
      schema: StepPointerSchema,
      signal,
    });

    return {
      ...strictResult.value,
      shouldPoint: true,
    };
  }

  return result.value;
}

module.exports = {
  locateStepTarget,
};
