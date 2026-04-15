const test = require("node:test");
const assert = require("node:assert/strict");

const { streamAIResponse, fetchOllamaModels } = require("../../src/ai/index");

function buildStreamFromText(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function sseResponseFromDataObjects(objects, { includeDone = true, trailingNewline = true } = {}) {
  const lines = objects.map((obj) => `data: ${JSON.stringify(obj)}`);
  if (includeDone) {
    lines.push("data: [DONE]");
  }
  const payload = lines.join("\n") + (trailingNewline ? "\n" : "");
  return new Response(buildStreamFromText(payload), { status: 200 });
}

test("all AI providers stream correctly with mocked fetch (no API keys)", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    const stringUrl = String(url);
    calls.push(stringUrl);

    if (stringUrl.includes("api.anthropic.com")) {
      return sseResponseFromDataObjects([
        { delta: { type: "text_delta", text: "claude-" } },
        { delta: { text: "ok" } },
      ], { trailingNewline: false });
    }
    if (stringUrl.includes("api.openai.com/v1/chat/completions")) {
      return sseResponseFromDataObjects([
        { choices: [{ delta: { content: "openai-" } }] },
        { choices: [{ delta: { content: "ok" } }] },
      ], { trailingNewline: false });
    }
    if (stringUrl.includes("openrouter.ai/api/v1/chat/completions")) {
      return sseResponseFromDataObjects([
        { choices: [{ delta: { content: "openrouter-" } }] },
        { choices: [{ delta: { content: "ok" } }] },
      ], { trailingNewline: false });
    }
    if (stringUrl.includes("generativelanguage.googleapis.com")) {
      return sseResponseFromDataObjects([
        { candidates: [{ content: { parts: [{ text: "gemini-" }] } }] },
        { candidates: [{ content: { parts: [{ text: "ok" }] } }] },
      ], { includeDone: false, trailingNewline: false });
    }
    if (stringUrl.includes("api.groq.com/openai/v1/chat/completions")) {
      return sseResponseFromDataObjects([
        { choices: [{ delta: { content: "groq-" } }] },
        { choices: [{ delta: { content: "ok" } }] },
      ], { trailingNewline: false });
    }
    if (stringUrl.includes("/api/chat")) {
      const ndjson = `${JSON.stringify({ message: { content: "ollama-" } })}\n${JSON.stringify({ message: { content: "ok" } })}`;
      return new Response(buildStreamFromText(ndjson), { status: 200 });
    }

    return new Response("unknown mock url", { status: 500 });
  };

  try {
    const providers = [
      ["claude", "claude-ok"],
      ["openai", "openai-ok"],
      ["openrouter", "openrouter-ok"],
      ["gemini", "gemini-ok"],
      ["groq", "groq-ok"],
      ["ollama", "ollama-ok"],
    ];

    for (const [provider, expected] of providers) {
      let streamed = "";
      const result = await streamAIResponse({
        text: "hello",
        images: [],
        history: [],
        settings: {
          aiProvider: provider,
          aiModel: "",
          ollamaUrl: "http://localhost:11434",
        },
        onChunk: (chunk) => {
          streamed += chunk;
        },
        signal: undefined,
      });

      assert.equal(result, expected, `${provider} full response mismatch`);
      assert.equal(streamed, expected, `${provider} streamed chunks mismatch`);
    }

    assert.ok(calls.some((url) => url.includes("api.anthropic.com")));
    assert.ok(calls.some((url) => url.includes("api.openai.com/v1/chat/completions")));
    assert.ok(calls.some((url) => url.includes("openrouter.ai/api/v1/chat/completions")));
    assert.ok(calls.some((url) => url.includes("generativelanguage.googleapis.com")));
    assert.ok(calls.some((url) => url.includes("api.groq.com/openai/v1/chat/completions")));
    assert.ok(calls.some((url) => url.includes("/api/chat")));
  } finally {
    global.fetch = originalFetch;
  }
});

test("openrouter retries once with lower max_tokens on affordable 402 response", async () => {
  const originalFetch = global.fetch;
  let fetchCount = 0;
  global.fetch = async (_url, options) => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Response("You can only afford 512 tokens", { status: 402 });
    }

    const body = JSON.parse(String(options?.body || "{}"));
    assert.ok(body.max_tokens <= 2048);
    assert.ok(body.max_tokens >= 256);

    return sseResponseFromDataObjects([
      { choices: [{ delta: { content: "retry-ok" } }] },
    ], { trailingNewline: false });
  };

  try {
    let streamed = "";
    const result = await streamAIResponse({
      text: "hello",
      images: [],
      history: [],
      settings: {
        aiProvider: "openrouter",
        aiModel: "",
        openrouterMaxTokens: 2048,
      },
      onChunk: (chunk) => {
        streamed += chunk;
      },
      signal: undefined,
    });

    assert.equal(fetchCount, 2);
    assert.equal(result, "retry-ok");
    assert.equal(streamed, "retry-ok");
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetchOllamaModels returns model names and falls back to empty on error", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify({ models: [{ name: "llama3.2" }, { name: "qwen2.5" }] }), { status: 200 });

  try {
    const models = await fetchOllamaModels("http://localhost:11434");
    assert.deepEqual(models, ["llama3.2", "qwen2.5"]);
  } finally {
    global.fetch = originalFetch;
  }

  global.fetch = async () => {
    throw new Error("offline");
  };
  try {
    const models = await fetchOllamaModels("http://localhost:11434");
    assert.deepEqual(models, []);
  } finally {
    global.fetch = originalFetch;
  }
});
