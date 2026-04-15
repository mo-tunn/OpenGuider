const { z } = require("zod");

const StepSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  instruction: z.string().min(1),
  successCriteria: z.string().min(1),
  guidanceMode: z.enum(["point_and_explain", "explain_only"]).default("point_and_explain"),
  requiresScreenshotCheck: z.boolean().default(true),
  canUserMarkDone: z.boolean().default(true),
  fallbackHints: z.array(z.string()).default([]),
});

const PlannerResultSchema = z.object({
  goal: z.string().min(1),
  assistantResponse: z.string().min(1),
  assumptions: z.array(z.string()).default([]),
  steps: z.array(StepSchema).min(1),
});

const StepPointerSchema = z.object({
  coordinate: z
    .object({
      x: z.number().min(0).max(1000),
      y: z.number().min(0).max(1000),
    })
    .nullable()
    .default(null),
  label: z.string().nullable().default(null),
  explanation: z.string().default(""),
  shouldPoint: z.boolean().default(false),
});

const EvaluationSchema = z.object({
  status: z.enum(["done", "not_done", "blocked", "uncertain"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  suggestedAction: z.enum(["repeat_guidance", "advance", "replan"]),
  assistantResponse: z.string().min(1),
});

function extractJSONObject(rawText = "") {
  const fencedMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1] : rawText;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model did not return a JSON object.");
  }

  return JSON.parse(candidate.slice(start, end + 1));
}

function parseStructuredJSON(rawText, schema) {
  const parsed = extractJSONObject(rawText);
  return schema.parse(parsed);
}

module.exports = {
  EvaluationSchema,
  PlannerResultSchema,
  StepPointerSchema,
  extractJSONObject,
  parseStructuredJSON,
};
