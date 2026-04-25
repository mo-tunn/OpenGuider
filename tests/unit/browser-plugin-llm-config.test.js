const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveBrowserPluginLlmConfig } = require("../../src/plugins/browser/llm-config");

test("maps active OpenAI settings into browser plugin config", () => {
  const result = resolveBrowserPluginLlmConfig({
    aiProvider: "openai",
    aiModel: "gpt-4o-mini",
    openaiApiKey: "sk-openai",
    openaiModelCustom: "ignored-when-aiModel-present",
  });

  assert.deepEqual(result, {
    activeProvider: "openai",
    llmProvider: "openai",
    llmApiKey: "sk-openai",
    llmModel: "gpt-4o-mini",
    requestedModel: "gpt-4o-mini",
    warning: "",
  });
});

test("maps Claude settings to Anthropic for the browser plugin", () => {
  const result = resolveBrowserPluginLlmConfig({
    aiProvider: "claude",
    claudeApiKey: "sk-ant",
    claudeModelCustom: "claude-3-5-sonnet-latest",
  });

  assert.deepEqual(result, {
    activeProvider: "claude",
    llmProvider: "anthropic",
    llmApiKey: "sk-ant",
    llmModel: "claude-3-5-sonnet-latest",
    requestedModel: "claude-3-5-sonnet-latest",
    warning: "",
  });
});

test("uses provider-specific model fallback when aiModel is blank", () => {
  const result = resolveBrowserPluginLlmConfig({
    aiProvider: "openrouter",
    aiModel: "",
    openrouterApiKey: "sk-or",
    openrouterModelCustom: "google/gemini-2.0-flash-lite-preview-02-05:free",
  });

  assert.deepEqual(result, {
    activeProvider: "openrouter",
    llmProvider: "openrouter",
    llmApiKey: "sk-or",
    llmModel: "google/gemini-2.0-flash-lite-preview-02-05:free",
    requestedModel: "google/gemini-2.0-flash-lite-preview-02-05:free",
    warning: "",
  });
});

test("falls back to provider default when the selected model is an incompatible preview model", () => {
  const result = resolveBrowserPluginLlmConfig({
    aiProvider: "openrouter",
    aiModel: "google/gemini-3.1-flash-image-preview",
    openrouterApiKey: "sk-or",
    openrouterModelCustom: "google/gemini-3.1-flash-image-preview",
  });

  assert.deepEqual(result, {
    activeProvider: "openrouter",
    llmProvider: "openrouter",
    llmApiKey: "sk-or",
    llmModel: "",
    requestedModel: "google/gemini-3.1-flash-image-preview",
    warning: 'Browser automation ignored incompatible preview model "google/gemini-3.1-flash-image-preview" and fell back to a safer default.',
  });
});

test("falls back to a safer Groq default when the selected model does not support browser structured output", () => {
  const result = resolveBrowserPluginLlmConfig({
    aiProvider: "groq",
    aiModel: "qwen/qwen3-32b",
    groqApiKey: "sk-groq",
    groqModelCustom: "qwen/qwen3-32b",
  });

  assert.deepEqual(result, {
    activeProvider: "groq",
    llmProvider: "groq",
    llmApiKey: "sk-groq",
    llmModel: "",
    requestedModel: "qwen/qwen3-32b",
    warning: 'Browser automation ignored Groq model "qwen/qwen3-32b" because it does not support the structured output mode required by browser automation, and fell back to a safer default.',
  });
});

test("falls back to a safer Groq default when the selected model is too large for browser automation prompts", () => {
  const result = resolveBrowserPluginLlmConfig({
    aiProvider: "groq",
    aiModel: "openai/gpt-oss-120b",
    groqApiKey: "sk-groq",
    groqModelCustom: "openai/gpt-oss-120b",
  });

  assert.deepEqual(result, {
    activeProvider: "groq",
    llmProvider: "groq",
    llmApiKey: "sk-groq",
    llmModel: "",
    requestedModel: "openai/gpt-oss-120b",
    warning: 'Browser automation ignored Groq model "openai/gpt-oss-120b" because it commonly exceeds Groq token-per-minute limits for browser automation prompts, and fell back to a safer default.',
  });
});
