const PROVIDER_ALIASES = Object.freeze({
  claude: "anthropic",
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openrouter",
  gemini: "gemini",
  google: "google",
  groq: "groq",
  ollama: "ollama",
});

const PROVIDER_MODEL_FIELDS = Object.freeze({
  claude: "claudeModelCustom",
  anthropic: "claudeModelCustom",
  openai: "openaiModelCustom",
  openrouter: "openrouterModelCustom",
  gemini: "geminiModelCustom",
  google: "geminiModelCustom",
  groq: "groqModelCustom",
  ollama: "ollamaModelCustom",
});

const PROVIDER_API_KEY_FIELDS = Object.freeze({
  claude: "claudeApiKey",
  anthropic: "claudeApiKey",
  openai: "openaiApiKey",
  openrouter: "openrouterApiKey",
  gemini: "geminiApiKey",
  google: "geminiApiKey",
  groq: "groqApiKey",
});

const BROWSER_MODEL_BLOCKLIST = [
  /image-preview/i,
  /audio-preview/i,
  /search-preview/i,
  /^gpt-4-vision-preview$/i,
];

const GROQ_BROWSER_MODEL_BLOCKLIST = [
  {
    pattern: /^qwen\/qwen3-32b$/i,
    reason: "it does not support the structured output mode required by browser automation",
  },
  {
    pattern: /^openai\/gpt-oss-120b$/i,
    reason: "it commonly exceeds Groq token-per-minute limits for browser automation prompts",
  },
];

function normalizeProvider(provider) {
  const normalized = String(provider || "").trim().toLowerCase();
  if (!normalized) {
    return "claude";
  }
  return normalized;
}

function sanitizeBrowserPluginModel(model, provider = "") {
  const normalized = String(model || "").trim();
  if (!normalized) {
    return { llmModel: "", warning: "" };
  }

  if (String(provider || "").toLowerCase() === "groq") {
    const blockedGroqModel = GROQ_BROWSER_MODEL_BLOCKLIST.find(({ pattern }) => pattern.test(normalized));
    if (blockedGroqModel) {
      return {
        llmModel: "",
        warning: `Browser automation ignored Groq model "${normalized}" because ${blockedGroqModel.reason}, and fell back to a safer default.`,
      };
    }
  }

  const isBlocked = BROWSER_MODEL_BLOCKLIST.some((pattern) => pattern.test(normalized));
  if (!isBlocked) {
    return { llmModel: normalized, warning: "" };
  }

  return {
    llmModel: "",
    warning: `Browser automation ignored incompatible preview model "${normalized}" and fell back to a safer default.`,
  };
}

function resolveBrowserPluginLlmConfig(settings = {}) {
  const activeProvider = normalizeProvider(settings.aiProvider);
  const provider = PROVIDER_ALIASES[activeProvider] || activeProvider;
  const modelField = PROVIDER_MODEL_FIELDS[activeProvider];
  const apiKeyField = PROVIDER_API_KEY_FIELDS[activeProvider];

  const requestedModel = String(settings.aiModel || (modelField ? settings[modelField] : "") || "").trim();
  const sanitizedModel = sanitizeBrowserPluginModel(requestedModel, provider);
  const llmApiKey = String((apiKeyField ? settings[apiKeyField] : "") || "").trim();

  return {
    activeProvider,
    llmProvider: provider,
    llmApiKey,
    llmModel: sanitizedModel.llmModel,
    requestedModel,
    warning: sanitizedModel.warning,
  };
}

module.exports = {
  resolveBrowserPluginLlmConfig,
};
