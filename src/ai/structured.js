const { streamAIResponse } = require("./index");
const { createLogger } = require("../logger");

const logger = createLogger("structured");

function debugStructuredLog(stage, details = {}) {
  logger.debug(stage, details);
}

function formatStructuredUserError(error) {
  const message = error?.message || String(error || "Unknown error");

  if (/401|403|api key|unauthorized|forbidden/i.test(message)) {
    return "AI provider authentication failed. Check the selected provider, model, and API key in Settings.";
  }

  if (/429|rate limit|quota/i.test(message)) {
    return "The AI provider rate-limited this request. Please wait a moment and try again.";
  }

  if (/402|more credits|can only afford|insufficient credits/i.test(message)) {
    return "OpenRouter credits are not enough for the current response size. Add credits or lower the model output size and try again.";
  }

  if (/500|internal server error/i.test(message)) {
    return "The AI provider had a temporary server error while generating the plan. Please try again.";
  }

  if (/Model did not return a JSON object|JSON|Unexpected token|parse/i.test(message)) {
    return "The AI returned an invalid planning response. Please try again.";
  }

  return "The planning workflow failed before the next step could be generated. Please try again.";
}

async function invokeStructuredResponse({
  text,
  images = [],
  history = [],
  settings,
  systemPrompt,
  signal,
  operationName = "structured_call",
}) {
  const requestSettings = systemPrompt
    ? {
        ...settings,
        systemPromptOverride: systemPrompt,
      }
    : settings;

  const provider = settings?.aiProvider || "unknown";
  const model = settings?.aiModel || "default";
  let fullText = "";
  debugStructuredLog("request:start", {
    operationName,
    provider,
    model,
    imageCount: images.length,
    historyCount: history.length,
    promptLength: text.length,
  });

  try {
    fullText = await streamAIResponse({
      text,
      images,
      history,
      settings: requestSettings,
      signal,
      onChunk: (chunk) => {
        fullText += chunk;
      },
    });
    debugStructuredLog("request:success", {
      operationName,
      provider,
      model,
      responseLength: fullText.length,
    });
  } catch (error) {
    debugStructuredLog("request:error", {
      operationName,
      provider,
      model,
      message: error?.message || String(error),
    });
    throw new Error(`[${provider}/${model}] ${error.message}`);
  }

  return fullText;
}

module.exports = {
  formatStructuredUserError,
  invokeStructuredResponse,
};
