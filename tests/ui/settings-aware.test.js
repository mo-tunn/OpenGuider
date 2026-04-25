const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

function installDomGlobals(dom) {
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.HTMLElement = dom.window.HTMLElement;
}

function cleanupDomGlobals(dom) {
  delete global.window;
  delete global.document;
  delete global.navigator;
  delete global.HTMLElement;
  dom.window.close();
}

test("settings aware tab loads saved state and persists the toggle", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../../renderer/settings.html"), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost" });
  installDomGlobals(dom);

  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const settingsModulePath = path.join(__dirname, "../../renderer/js/settings.js");
  let savedPayload = null;

  global.setTimeout = (fn) => {
    if (typeof fn === "function") fn();
    return 0;
  };
  global.clearTimeout = () => {};

  window.openguider = {
    invoke: async (channel, payload) => {
      if (channel === "get-settings") {
        return {
          aiProvider: "openai",
          aiModel: "gpt-4o-mini",
          openaiBaseUrl: "https://api.openai.com/v1",
          whisperBaseUrl: "https://api.openai.com/v1",
          whisperModel: "whisper-1",
          openaiTtsBaseUrl: "https://api.openai.com/v1",
          openaiTtsModel: "tts-1",
          openaiTtsVoice: "nova",
          executionMode: "hitl",
          trustLevel: "balanced",
          browserAgentEnabled: true,
          browserHeadless: false,
          awareAssistanceEnabled: false,
          ttsEnabled: true,
          ttsVolume: 1,
          ttsRate: 1.5,
          sttProvider: "assemblyai",
          ttsProvider: "google",
        };
      }
      if (channel === "save-settings") {
        savedPayload = payload;
        return { ok: true, warnings: [] };
      }
      if (channel === "get-browser-agent-status") return "running";
      if (channel === "get-performance-metrics") return { metrics: [], events: [], generatedAt: "now" };
      return true;
    },
    on() {
      return () => {};
    },
  };

  delete require.cache[require.resolve(settingsModulePath)];

  try {
    require(settingsModulePath);
    await new Promise((resolve) => setImmediate(resolve));

    const awareTab = dom.window.document.querySelector('[data-tab="aware"]');
    const awareToggle = dom.window.document.getElementById("awareAssistanceEnabled");
    const saveButton = dom.window.document.getElementById("btn-save");

    assert.ok(awareTab);
    assert.ok(awareToggle);
    assert.equal(awareToggle.checked, false);

    awareToggle.checked = true;
    saveButton.click();
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(savedPayload);
    assert.equal(savedPayload.awareAssistanceEnabled, true);
  } finally {
    delete require.cache[require.resolve(settingsModulePath)];
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    cleanupDomGlobals(dom);
  }
});
