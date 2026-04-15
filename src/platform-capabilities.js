function getPlatformCapabilities(platform = process.platform) {
  const isWindows = platform === "win32";
  const isMacOS = platform === "darwin";
  const isLinux = platform === "linux";

  return {
    platform,
    isWindows,
    isMacOS,
    isLinux,
    tts: {
      google: true,
      openai: true,
      elevenlabs: true,
    },
    stt: {
      webspeech: true,
      assemblyai: true,
      whisper: true,
    },
    ai: {
      claude: true,
      openai: true,
      gemini: true,
      groq: true,
      openrouter: true,
      ollama: true,
    },
  };
}

function normalizeSettingsForPlatform(settings = {}, capabilities = getPlatformCapabilities()) {
  const nextSettings = { ...settings };
  const warnings = [];
  const supportedTtsProviders = new Set(["google", "openai", "elevenlabs"]);

  if (nextSettings.ttsProvider && !supportedTtsProviders.has(nextSettings.ttsProvider)) {
    nextSettings.ttsProvider = "google";
    warnings.push("Unsupported TTS provider requested. Falling back to Google Translate TTS.");
  }

  return {
    settings: nextSettings,
    warnings,
  };
}

function resolveEffectiveTtsProvider(ttsProvider, capabilities = getPlatformCapabilities()) {
  const _capabilities = capabilities;
  void _capabilities;
  const supportedTtsProviders = new Set(["google", "openai", "elevenlabs"]);
  if (!supportedTtsProviders.has(ttsProvider)) {
    return {
      provider: "google",
      warning: "Unsupported TTS provider requested; using Google Translate TTS.",
    };
  }

  return {
    provider: ttsProvider || "google",
    warning: null,
  };
}

module.exports = {
  getPlatformCapabilities,
  normalizeSettingsForPlatform,
  resolveEffectiveTtsProvider,
};
