const { invokeStructuredChain } = require("./llm-client");
const { StepPointerSchema } = require("./schemas");
const { analyzeContext } = require("../context/context-analyzer");

const LOCATOR_SYSTEM_PROMPT = [
  "You help users complete the current UI step on their screen.",
  "If the target is visible, append a tag formatted exactly as [POINT:x,y:label] anywhere in your JSON explanation field.",
  "Where x and y are normalized coordinates from 0 to 1000.",
  "If the target is not visible, return shouldPoint=false.",
  "Always return valid JSON only.",
].join(" ");

const STRICT_LOCATOR_SYSTEM_PROMPT = [
  "You are in strict pointing mode for a desktop guidance assistant.",
  "You MUST return one best-guess click coordinate using the [POINT:x,y:label] tag in your explanation.",
  "Never return null coordinates or omit the tag in strict mode.",
  "Even if uncertain, provide the most likely click target and state uncertainty in explanation.",
  "Always set shouldPoint=true in strict mode.",
  "Always return valid JSON only.",
].join(" ");

const BASE_LOCATOR_TEMPLATE = `
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

{{#extraContext}}
---
ADDITIONAL CONTEXT (use this to improve accuracy):
{{extraContext}}
{{/extraContext}}

Return JSON with this shape:
{
  "coordinate": null,
  "label": "short target label or null",
  "explanation": "brief helper text. If pointing, you MUST include [POINT:x,y:label] here.",
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
  preprocessing = null,
}) {
  if (!step) {
    return {
      coordinate: null,
      label: null,
      explanation: "",
      shouldPoint: false,
    };
  }

  let extraContext = null;
  if (preprocessing && (preprocessing.ocrResult || preprocessing.windowInfo || preprocessing.matchedElements?.length > 0)) {
    extraContext = await analyzeContext(step.instruction, preprocessing, settings);
  }

  const input = {
    goal: plan?.goal || "",
    stepTitle: step.title,
    instruction: step.instruction,
    successCriteria: step.successCriteria,
    userNote: userNote || "No note.",
    extraContext: extraContext || "",
  };

  const result = await invokeStructuredChain({
    settings,
    systemPrompt: LOCATOR_SYSTEM_PROMPT,
    template: BASE_LOCATOR_TEMPLATE,
    operationName: "locator",
    input,
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
      template: BASE_LOCATOR_TEMPLATE,
      operationName: "locator_strict",
      input: {
        ...input,
        userNote: `${input.userNote} Strict mode: return the best click coordinate now.`,
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
