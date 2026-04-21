const DEFAULT_SYSTEM_PROMPT = `You are OpenGuider, a helpful AI companion that lives in the Windows system tray.
You can see the user's screen when they share it. Keep replies concise unless asked to elaborate.
Be direct and conversational. When the user asks about something on screen, reference what you see.

CRITICAL INSTRUCTION FOR ELEMENT POINTING:
If the user asks you to show, point to, or find a specific UI element on the screen, YOU MUST append a special tag to your answer.
Format: [POINT:x,y:label]
IMPORTANT COORDINATE RULES:
1. You MUST provide coordinates on a normalized 0 to 1000 scale.
2. X=0, Y=0 is the TOP-LEFT corner.
3. X=1000, Y=1000 is the BOTTOM-RIGHT corner.
4. Do NOT output absolute pixels. ONLY output numbers between 0 and 1000.
Example: "Here is the submit button. [POINT:850,450:Submit Button]" (meaning 85% right, 45% down from top)
If no pointing is needed, DO NOT invent coordinates, just reply normally or append [POINT:none].
NEVER provide coordinates in regular text like "(x, y)". ONLY use the [POINT:x,y:label] tag format.

MULTI-SCREEN RULE:
When you receive screenshots from multiple screens (e.g. [Screen 1 (primary)], [Screen 2]), you MUST append the screen number to the POINT tag.
Format: [POINT:x,y:label:screenN]  — where N matches the number in the [Screen N] label of the image that contains the target element.
Example (element is on Screen 2): [POINT:750,300:Settings Button:screen2]
If there is only one screen, you may omit :screenN.
Coordinates are always on the 0-1000 scale relative to that specific screen's image.
`;

// ── Claude ────────────────────────────────────────────────────────────────────
async function streamClaude({ text, images, history, settings, onChunk, signal }) {
  // Allow a custom base URL so users can point to a proxy or a compatible API.
  // Falls back to the official Anthropic endpoint when not configured.
  const baseUrl = (settings.claudeBaseUrl || "https://api.anthropic.com").replace(/\/$/, "");
  const url = `${baseUrl}/v1/messages`;
  const messages = buildClaudeMessages(text, images, history);
  const systemPrompt = settings.systemPromptOverride || DEFAULT_SYSTEM_PROMPT;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.claudeApiKey,
      "anthropic-version": "2023-06-01",
    },
    signal,
    body: JSON.stringify({
      model: settings.aiModel || "claude-sonnet-4-5",
      max_tokens: 4096,
      stream: true,
      system: systemPrompt,
      messages,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Claude API error ${resp.status}: ${errText}`);
  }

  let fullText = "";
  for await (const line of readSSELines(resp.body)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") break;
    try {
      const parsed = JSON.parse(data);
      const chunk = parsed?.delta?.text || parsed?.delta?.type === "text_delta" && parsed.delta.text || "";
      if (chunk) { fullText += chunk; onChunk(chunk); }
    } catch {}
  }
  return fullText;
}

function buildClaudeMessages(text, images, history) {
  const msgs = [];
  for (const { role, content } of (history || [])) {
    msgs.push({ role, content });
  }
  const userContent = [];
  for (const img of (images || [])) {
    userContent.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: img.base64Jpeg },
    });
    userContent.push({ type: "text", text: `[${img.label}]` });
  }
  userContent.push({ type: "text", text });
  msgs.push({ role: "user", content: userContent });
  return msgs;
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
async function streamOpenAI({ text, images, history, settings, onChunk, signal }) {
  // Allow a custom base URL so users can point to Azure OpenAI or a local proxy.
  // Falls back to the official OpenAI endpoint when not configured.
  const baseUrl = (settings.openaiBaseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const url = `${baseUrl}/chat/completions`;

  const systemPrompt = settings.systemPromptOverride || DEFAULT_SYSTEM_PROMPT;
  const messages = [{ role: "system", content: systemPrompt }];
  for (const h of (history || [])) messages.push({ role: h.role, content: h.content });

  const userContent = [];
  for (const img of (images || [])) {
    userContent.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${img.base64Jpeg}` } });
    userContent.push({ type: "text", text: `[${img.label}]` });
  }
  userContent.push({ type: "text", text });
  messages.push({ role: "user", content: userContent.length === 1 ? text : userContent });

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.openaiApiKey}`,
    },
    signal,
    body: JSON.stringify({ model: settings.aiModel || "gpt-4o", stream: true, messages }),
  });

  if (!resp.ok) throw new Error(`OpenAI error ${resp.status}: ${await resp.text()}`);

  let fullText = "";
  for await (const line of readSSELines(resp.body)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") break;
    try {
      const parsed = JSON.parse(data);
      const chunk = parsed?.choices?.[0]?.delta?.content || "";
      if (chunk) { fullText += chunk; onChunk(chunk); }
    } catch {}
  }
  return fullText;
}

// ── OpenRouter ────────────────────────────────────────────────────────────────
async function streamOpenRouter({ text, images, history, settings, onChunk, signal }) {
  const OPENROUTER_MIN_TOKENS = 32;
  const OPENROUTER_MAX_TOKENS = 4096;
  // Allow a custom base URL for OpenRouter-compatible endpoints.
  // Falls back to the official OpenRouter endpoint when not configured.
  const baseUrl = (settings.openrouterBaseUrl || "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const url = `${baseUrl}/chat/completions`;

  const systemPrompt = settings.systemPromptOverride || DEFAULT_SYSTEM_PROMPT;
  const messages = [{ role: "system", content: systemPrompt }];
  for (const h of (history || [])) messages.push({ role: h.role, content: h.content });

  const userContent = [];
  for (const img of (images || [])) {
    userContent.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${img.base64Jpeg}` } });
    userContent.push({ type: "text", text: `[${img.label}]` });
  }
  userContent.push({ type: "text", text });
  messages.push({ role: "user", content: userContent.length === 1 ? text : userContent });

  const requestHeaders = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${settings.openrouterApiKey}`,
    "X-Title": "OpenGuider AI Companion",
  };

  const requestModel = settings.aiModel || "google/gemini-2.0-flash-lite-preview-02-05:free";
  const requestedMaxTokens = Number.isFinite(Number(settings.openrouterMaxTokens))
    ? Math.max(OPENROUTER_MIN_TOKENS, Math.min(OPENROUTER_MAX_TOKENS, Number(settings.openrouterMaxTokens)))
    : 2048;

  async function requestOpenRouter(maxTokens) {
    return fetch(url, {
      method: "POST",
      headers: requestHeaders,
      signal,
      body: JSON.stringify({
        model: requestModel,
        stream: true,
        messages,
        max_tokens: maxTokens,
      }),
    });
  }

  let resp = await requestOpenRouter(requestedMaxTokens);
  if (!resp.ok) {
    let errText = await resp.text();
    if (resp.status === 402) {
      const affordableMatch = errText.match(/can only afford\s+(\d+)/i);
      const affordableTokens = affordableMatch
        ? Number.parseInt(affordableMatch[1], 10)
        : Number.NaN;
      const fallbackCandidates = [
        affordableTokens,
        Math.floor(requestedMaxTokens * 0.5),
        Math.floor(requestedMaxTokens * 0.25),
        128,
        64,
        OPENROUTER_MIN_TOKENS,
      ]
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.max(OPENROUTER_MIN_TOKENS, Math.min(OPENROUTER_MAX_TOKENS, Number(value))))
        .filter((value) => value < requestedMaxTokens);
      const retryCandidates = [...new Set(fallbackCandidates)];

      for (const retryMaxTokens of retryCandidates) {
        resp = await requestOpenRouter(retryMaxTokens);
        if (resp.ok) {
          break;
        }
        errText = await resp.text();
      }

      if (!resp.ok) {
        throw new Error(`OpenRouter error ${resp.status}: ${errText}`);
      }
    } else {
      throw new Error(`OpenRouter error ${resp.status}: ${errText}`);
    }
  }

  let fullText = "";
  for await (const line of readSSELines(resp.body)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") break;
    try {
      const parsed = JSON.parse(data);
      const chunk = parsed?.choices?.[0]?.delta?.content || "";
      if (chunk) { fullText += chunk; onChunk(chunk); }
    } catch {}
  }
  return fullText;
}

// ── Gemini ────────────────────────────────────────────────────────────────────
async function streamGemini({ text, images, history, settings, onChunk, signal }) {
  const model = settings.aiModel || "gemini-2.0-flash";
  // Allow a custom base URL for Gemini-compatible endpoints.
  // Falls back to the official Google Generative Language API when not configured.
  const baseUrl = (settings.geminiBaseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  const url = `${baseUrl}/models/${model}:streamGenerateContent?alt=sse&key=${settings.geminiApiKey}`;

  const systemPrompt = settings.systemPromptOverride || DEFAULT_SYSTEM_PROMPT;
  const contents = [];
  for (const h of (history || [])) {
    contents.push({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.content }] });
  }
  const parts = [];
  for (const img of (images || [])) {
    parts.push({ inlineData: { mimeType: "image/jpeg", data: img.base64Jpeg } });
    parts.push({ text: `[${img.label} - Resolution: ${img.width}x${img.height}]` });
  }
  parts.push({ text });
  contents.push({ role: "user", parts });

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: { maxOutputTokens: 4096 },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify(body),
  });

  if (!resp.ok) throw new Error(`Gemini error ${resp.status}: ${await resp.text()}`);

  let fullText = "";
  for await (const line of readSSELines(resp.body)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    try {
      const parsed = JSON.parse(data);
      const chunk = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (chunk) { fullText += chunk; onChunk(chunk); }
    } catch {}
  }
  return fullText;
}

// ── Groq ──────────────────────────────────────────────────────────────────────
// Groq uses an OpenAI-compatible API with very fast inference.
// Vision models: llama-3.2-11b-vision-preview, llama-3.2-90b-vision-preview
async function streamGroq({ text, images, history, settings, onChunk, signal }) {
  // Allow a custom base URL for Groq-compatible endpoints.
  // Falls back to the official Groq endpoint when not configured.
  const baseUrl = (settings.groqBaseUrl || "https://api.groq.com/openai/v1").replace(/\/$/, "");
  const url = `${baseUrl}/chat/completions`;
  const systemPrompt = settings.systemPromptOverride || DEFAULT_SYSTEM_PROMPT;

  const messages = [{ role: "system", content: systemPrompt }];
  for (const h of (history || [])) messages.push({ role: h.role, content: h.content });

  // Groq vision models accept images in the same format as OpenAI
  const userContent = [];
  for (const img of (images || [])) {
    userContent.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${img.base64Jpeg}` },
    });
    userContent.push({ type: "text", text: `[${img.label}]` });
  }
  userContent.push({ type: "text", text });

  messages.push({
    role: "user",
    // If no images, send plain text (non-vision models don't accept array content)
    content: (images && images.length > 0) ? userContent : text,
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.groqApiKey}`,
    },
    signal,
    body: JSON.stringify({
      model: settings.aiModel || "llama-3.2-11b-vision-preview",
      stream: true,
      messages,
      max_tokens: 4096,
    }),
  });

  if (!resp.ok) throw new Error(`Groq error ${resp.status}: ${await resp.text()}`);

  let fullText = "";
  for await (const line of readSSELines(resp.body)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") break;
    try {
      const parsed = JSON.parse(data);
      const chunk = parsed?.choices?.[0]?.delta?.content || "";
      if (chunk) { fullText += chunk; onChunk(chunk); }
    } catch {}
  }
  return fullText;
}



// ── Ollama ────────────────────────────────────────────────────────────────────
async function streamOllama({ text, images, history, settings, onChunk, signal }) {
  const baseUrl = settings.ollamaUrl || "http://localhost:11434";
  const model = settings.aiModel || "llama3.2";
  const systemPrompt = settings.systemPromptOverride || DEFAULT_SYSTEM_PROMPT;

  const messages = [{ role: "system", content: systemPrompt }];
  for (const h of (history || [])) messages.push({ role: h.role, content: h.content });

  const userMsg = { role: "user", content: text };
  if (images && images.length > 0) {
    userMsg.images = images.map(i => i.base64Jpeg);
  }
  messages.push(userMsg);

  const resp = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ model, messages, stream: true }),
  });

  if (!resp.ok) throw new Error(`Ollama error ${resp.status}: ${await resp.text()}`);

  let fullText = "";
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const processOllamaLine = (line) => {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line);
      const chunk = parsed?.message?.content || "";
      if (chunk) { fullText += chunk; onChunk(chunk); }
    } catch {}
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      processOllamaLine(line);
    }
  }
  // Flush final UTF-8 decoder state + trailing unterminated JSON line.
  buffer += decoder.decode();
  processOllamaLine(buffer);
  return fullText;
}

// ── SSE helper (Node.js ReadableStream) ──────────────────────────────────────
async function* readSSELines(readableStream) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) yield line;
  }
  // Flush final UTF-8 decoder state and emit any remaining SSE line.
  buffer += decoder.decode();
  if (buffer) {
    for (const line of buffer.split("\n")) {
      if (line) yield line;
    }
  }
}

// ── Point tag parser ──────────────────────────────────────────────────────────
function parsePointTag(fullText) {
  const regex = /\[POINT:(?:none|([\d.]+)\s*,\s*([\d.]+)(?::([^\]:]+))?(?::screen(\d+))?)\]/gi;
  let firstValidCoord = null;
  let firstValidLabel = "element";
  let firstScreen = null;

  const cleanText = fullText.replace(regex, (match, x, y, label, screenStr) => {
    if (x && y && !firstValidCoord) {
      firstValidCoord = { x: parseFloat(x), y: parseFloat(y) };
      if (label) firstValidLabel = label;
      if (screenStr) firstScreen = parseInt(screenStr);
    }
    return "";
  }).trim();

  if (!firstValidCoord) {
    // Fallback: If model ignored format and responded with "(870, 725)"
    const fallbackMatch = fullText.match(/\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/);
    if (fallbackMatch) {
      return {
        spokenText: fullText.replace(fallbackMatch[0], "").trim(),
        coordinate: { x: parseFloat(fallbackMatch[1]), y: parseFloat(fallbackMatch[2]) },
        label: "element",
        screenNumber: null
      };
    }
    return { spokenText: cleanText, coordinate: null, label: null, screenNumber: null };
  }

  return {
    spokenText: cleanText,
    coordinate: firstValidCoord,
    label: firstValidLabel,
    screenNumber: firstScreen,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────
async function streamAIResponse({ text, images, history, settings, onChunk, signal }) {
  switch (settings.aiProvider) {
    case "openai":     return streamOpenAI({ text, images, history, settings, onChunk, signal });
    case "openrouter": return streamOpenRouter({ text, images, history, settings, onChunk, signal });
    case "gemini":     return streamGemini({ text, images, history, settings, onChunk, signal });
    case "groq":       return streamGroq({ text, images, history, settings, onChunk, signal });
    case "ollama":     return streamOllama({ text, images, history, settings, onChunk, signal });
    default:           return streamClaude({ text, images, history, settings, onChunk, signal });
  }
}

async function fetchOllamaModels(ollamaUrl) {
  try {
    const resp = await fetch(`${ollamaUrl || "http://localhost:11434"}/api/tags`);
    const data = await resp.json();
    return (data.models || []).map(m => m.name);
  } catch {
    return [];
  }
}

module.exports = { streamAIResponse, parsePointTag, fetchOllamaModels };
