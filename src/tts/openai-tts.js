async function speakText(text, settings) {
  // Use the dedicated TTS key, fallback to the global OpenAI key
  const apiKey = settings.openaiTtsApiKey || settings.openaiApiKey;
  if (!apiKey) {
    throw new Error("OpenAI API key is required for OpenAI TTS.");
  }

  const baseUrl = (settings.openaiTtsBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  
  // Decide endpoint dynamically. If it already has an action path (like /generate or /speech), leave it alone.
  let endpoint = baseUrl;
  if (!endpoint.endsWith("/audio/speech") && !endpoint.includes("/generate") && !endpoint.includes("/audio/tts")) {
    endpoint = `${baseUrl}/audio/speech`;
  }

  // Construct payload. Hypereal uses a nested "input" object.
  let payload;
  if (baseUrl.includes("hypereal") || endpoint.includes("/generate")) {
    payload = {
      model: settings.openaiTtsModel || "audio-tts",
      voice: settings.openaiTtsVoice,
      input: {
        text: text,
        format: "mp3"
      }
    };
  } else {
    // Standard OpenAI payload
    payload = {
      model: settings.openaiTtsModel || "tts-1",
      input: text,
      voice: settings.openaiTtsVoice || "nova",
      response_format: "mp3"
    };
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`OpenAI TTS Error ${response.status}: ${await response.text()}`);
  }

  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

module.exports = { speakText };
