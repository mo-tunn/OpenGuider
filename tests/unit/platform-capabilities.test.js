const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getPlatformCapabilities,
  normalizeSettingsForPlatform,
  resolveEffectiveTtsProvider,
} = require("../../src/platform-capabilities");

test("tts capability map only exposes supported providers", () => {
  const caps = getPlatformCapabilities("linux");
  assert.equal(caps.tts.google, true);
  assert.equal(caps.tts.openai, true);
  assert.equal(caps.tts.elevenlabs, true);
  assert.equal("windows" in caps.tts, false);
  assert.equal("webspeech" in caps.tts, false);
});

test("normalize settings falls back unsupported tts provider to google", () => {
  const caps = getPlatformCapabilities("darwin");
  const result = normalizeSettingsForPlatform({ ttsProvider: "windows" }, caps);
  assert.equal(result.settings.ttsProvider, "google");
  assert.ok(result.warnings.length > 0);
});

test("resolve effective provider keeps openai when supported", () => {
  const caps = getPlatformCapabilities("win32");
  const resolved = resolveEffectiveTtsProvider("openai", caps);
  assert.equal(resolved.provider, "openai");
  assert.equal(resolved.warning, null);
});
