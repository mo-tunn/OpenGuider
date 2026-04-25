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

test("plugin runtime buttons do not enter shortcut recording mode", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../../renderer/settings.html"), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost" });
  installDomGlobals(dom);

  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const settingsModulePath = path.join(__dirname, "../../renderer/js/settings.js");
  const invokedChannels = [];

  global.setTimeout = (fn) => {
    if (typeof fn === "function") fn();
    return 0;
  };
  global.clearTimeout = () => {};

  window.openguider = {
    invoke: async (channel) => {
      invokedChannels.push(channel);
      if (channel === "get-settings") {
        return {
          aiProvider: "openai",
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
      if (channel === "get-browser-agent-status") return "stopped";
      if (channel === "get-performance-metrics") return { metrics: [], events: [], generatedAt: "now" };
      return { ok: true };
    },
    on() {
      return () => {};
    },
  };

  delete require.cache[require.resolve(settingsModulePath)];

  try {
    require(settingsModulePath);
    await new Promise((resolve) => setImmediate(resolve));

    const downloadButton = dom.window.document.getElementById("btn-download-agent");
    assert.ok(downloadButton);
    assert.equal(downloadButton.textContent, "Download Runtime");

    downloadButton.click();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(downloadButton.textContent, "Download Runtime");
    assert.ok(invokedChannels.includes("download-browser-agent"));
  } finally {
    delete require.cache[require.resolve(settingsModulePath)];
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    cleanupDomGlobals(dom);
  }
});
