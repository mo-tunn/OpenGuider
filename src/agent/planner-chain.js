const { normalizePlan } = require("../session/session-schema");
const { invokeStructuredChain } = require("./llm-client");
const { PlannerResultSchema } = require("./schemas");

const PLANNER_SYSTEM_PROMPT = [
  "You are an expert task planner for a screen-aware assistant.",
  "The user's goal is the source of truth. Never replace it with a different goal from screenshots.",
  "Use screenshots only to adapt step details and UI path, not to change the goal.",
  "Break the user's goal into actionable UI steps.",
  "Return concise, user-facing instructions that can be shown one step at a time in a todo widget.",
  "Avoid combining multiple UI actions into one step when they should be verified separately.",
  "Always return valid JSON only.",
].join(" ");

const PLANNER_TEMPLATE = `
User goal:
{{goal}}

Recent session context:
{{recentMessages}}

Current screen hints:
{{screenHints}}

Rule:
- Keep the plan aligned to User goal exactly.
- If screenshots conflict with the goal, still plan for the goal and list assumptions.

Return JSON with this shape:
{
  "goal": "string",
  "assistantResponse": "Short message explaining that you created a plan.",
  "assumptions": ["string"],
  "steps": [
    {
      "id": "snake_case_id",
      "title": "short title",
      "instruction": "single step instruction",
      "successCriteria": "how the evaluator can tell this is done",
      "guidanceMode": "point_and_explain or explain_only",
      "requiresScreenshotCheck": true,
      "canUserMarkDone": true,
      "fallbackHints": ["hint 1", "hint 2"]
    }
  ]
}
`;

function summarizeScreenshots(images = []) {
  if (!images.length) {
    return "No screenshot attached.";
  }

  return images
    .map((image, index) => `Screen ${index + 1}: ${image.label || "Unknown"} (${image.width || "?"}x${image.height || "?"})`)
    .join("\n");
}

async function planGoal({ goal, images, sessionSnapshot, settings, signal }) {
  const recentMessages = (sessionSnapshot?.messages || [])
    .slice(-6)
    .map((item) => `${item.role}: ${item.content}`)
    .join("\n");

  const result = await invokeStructuredChain({
    settings,
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    template: PLANNER_TEMPLATE,
    operationName: "planner",
    input: {
      goal,
      recentMessages: recentMessages || "No earlier messages.",
      screenHints: summarizeScreenshots(images),
    },
    images,
    history: sessionSnapshot?.messages?.slice(-6) || [],
    schema: PlannerResultSchema,
    signal,
  });

  return normalizePlan({
    goal: result.value.goal,
    assumptions: result.value.assumptions,
    steps: result.value.steps,
    currentStepIndex: 0,
    status: "active",
  });
}

module.exports = {
  planGoal,
};
