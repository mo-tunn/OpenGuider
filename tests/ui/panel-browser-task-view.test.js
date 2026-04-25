const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

function createApiMock({ settings, session }) {
  const listeners = new Map();

  return {
    api: {
      invoke: async (channel) => {
        if (channel === "get-settings") return settings;
        if (channel === "get-active-session") return session;
        if (channel === "ensure-runtime-permissions") return {};
        if (channel === "get-ollama-models") return [];
        return true;
      },
      on(channel, cb) {
        if (!listeners.has(channel)) {
          listeners.set(channel, []);
        }
        listeners.get(channel).push(cb);
        return () => {
          const next = (listeners.get(channel) || []).filter((entry) => entry !== cb);
          listeners.set(channel, next);
        };
      },
      send() {},
    },
    emit(channel, payload) {
      for (const listener of listeners.get(channel) || []) {
        listener(payload);
      }
    },
  };
}

async function importModule(relativePath) {
  return import(pathToFileURL(path.join(__dirname, relativePath)).href);
}

function installDomGlobals(dom) {
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.SpeechSynthesisUtterance = function SpeechSynthesisUtterance(text) {
    this.text = text;
  };
  global.navigator.clipboard = {
    writeText: async () => {},
  };
  dom.window.speechSynthesis = {
    cancel() {},
    pending: false,
    speaking: false,
    speak() {},
  };
}

function cleanupDomGlobals(dom) {
  delete global.window;
  delete global.document;
  delete global.navigator;
  delete global.SpeechSynthesisUtterance;
  dom.window.close();
}

test("panel controller hides guide actions during browser execution and restores them afterward", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../../renderer/index.html"), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost" });
  installDomGlobals(dom);

  const browserExecution = {
    taskId: "task-1",
    goal: "Open checkout",
    mode: "auto",
    trustLevel: "autopilot",
    status: "running",
    startedAt: "2026-04-24T10:00:00.000Z",
    finishedAt: null,
    finalMessage: "",
    substeps: [],
  };
  const settings = {
    assistantMode: "planning",
    onboardingCompleted: true,
    aiProvider: "openai",
    aiModel: "gpt-4o-mini",
    includeScreenshotByDefault: false,
  };
  const session = {
    messages: [],
    activePlan: null,
    browserExecution,
    status: "executing",
  };
  const { api, emit } = createApiMock({ settings, session });
  const { createPanelController } = await importModule("../../renderer/js/panel/bootstrap.js");

  try {
    const controller = createPanelController({ api, doc: dom.window.document, win: dom.window });
    await controller.init();

    const panelActions = dom.window.document.getElementById("panel-actions");
    const browserTaskView = dom.window.document.getElementById("browser-task-view");
    const panelRoot = dom.window.document.querySelector(".panel");
    const modeBar = dom.window.document.getElementById("mode-bar");

    assert.equal(panelActions.classList.contains("hidden"), true);
    assert.equal(browserTaskView.classList.contains("hidden"), false);
    assert.equal(panelRoot.classList.contains("browser-task-active"), true);
    assert.equal(modeBar.classList.contains("hidden"), false);
    assert.match(modeBar.textContent, /BROWSER EXECUTING/);
    assert.match(modeBar.textContent, /AUTOPILOT/);
    assert.match(browserTaskView.textContent, /Open checkout/);
    assert.doesNotMatch(browserTaskView.textContent, /Autopilot\s*·\s*Autopilot/i);

    emit("session-updated", {
      messages: [],
      activePlan: {
        goal: "Guide mode plan",
        currentStepIndex: 0,
        steps: [
          { id: "step_1", title: "Step one", instruction: "Do the thing", status: "active" },
        ],
      },
      browserExecution: null,
      status: "waiting_user",
    });

    assert.equal(panelActions.classList.contains("hidden"), false);
    assert.equal(browserTaskView.classList.contains("hidden"), true);
    assert.equal(panelRoot.classList.contains("browser-task-active"), false);
    assert.equal(modeBar.getAttribute("aria-hidden"), "true");
  } finally {
    cleanupDomGlobals(dom);
  }
});

test("panel controller shows the full run-goal-complete summary in the terminal notice", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../../renderer/index.html"), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost" });
  installDomGlobals(dom);

  const browserExecution = {
    taskId: "task-1",
    goal: "Go to Google, search for merhaba, and return the first result",
    mode: "auto",
    trustLevel: "autopilot",
    status: "running",
    startedAt: "2026-04-24T10:00:00.000Z",
    finishedAt: null,
    finalMessage: "",
    substeps: [
      { id: "1", stepNumber: 1, status: "done" },
    ],
  };
  const settings = {
    assistantMode: "planning",
    onboardingCompleted: true,
    aiProvider: "openai",
    aiModel: "gpt-4o-mini",
    includeScreenshotByDefault: false,
  };
  const session = {
    messages: [],
    activePlan: null,
    browserExecution,
    status: "executing",
  };
  const { api, emit } = createApiMock({ settings, session });
  const { createPanelController } = await importModule("../../renderer/js/panel/bootstrap.js");

  try {
    const controller = createPanelController({ api, doc: dom.window.document, win: dom.window });
    await controller.init();

    const finalSummary = "**First search result for 'merhaba':** https://open.spotify.com/intl-tr/track/2Nytn1rR2UmUTkhQwqMZKg - Merhaba - muzik ve sarki sozleri: Ahmet Kaya";
    emit("session-updated", {
      messages: [],
      activePlan: null,
      browserExecution: {
        ...browserExecution,
        status: "success",
        finishedAt: "2026-04-24T10:01:00.000Z",
        finalMessage: finalSummary,
        substeps: [
          { id: "1", stepNumber: 1, status: "done" },
          { id: "2", stepNumber: 2, status: "done" },
        ],
      },
      status: "idle",
    });

    const notices = Array.from(dom.window.document.querySelectorAll(".system-notice"));
    const doneNotice = notices.at(-1);
    assert.ok(doneNotice);
    assert.equal(doneNotice.classList.contains("system-notice-rich"), true);
    assert.match(doneNotice.textContent, /⬡ Done · 2 steps · First search result for 'merhaba': https:\/\/open\.spotify\.com\/intl-tr\/track\/2Nytn1rR2UmUTkhQwqMZKg - Merhaba - muzik ve sarki sozleri: Ahmet Kaya/);
    assert.doesNotMatch(doneNotice.textContent, /Go to Google, search for merhaba/);
    assert.doesNotMatch(doneNotice.textContent, /…/);
    assert.doesNotMatch(doneNotice.textContent, /\*\*/);
    assert.match(doneNotice.querySelector(".system-notice-text").innerHTML, /<strong>First search result for 'merhaba':<\/strong>/);
    assert.equal(
      doneNotice.querySelector('a[data-external-link="1"]')?.getAttribute("href"),
      "https://open.spotify.com/intl-tr/track/2Nytn1rR2UmUTkhQwqMZKg",
    );
  } finally {
    cleanupDomGlobals(dom);
  }
});

test("panel controller keeps the completed browser task summary visible in the task view", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../../renderer/index.html"), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost" });
  installDomGlobals(dom);

  const browserExecution = {
    taskId: "task-1",
    goal: "Perform a Google search for Open Guider and return the first result",
    mode: "auto",
    trustLevel: "autopilot",
    status: "running",
    startedAt: "2026-04-24T10:00:00.000Z",
    finishedAt: null,
    finalMessage: "",
    substeps: [
      { id: "1", stepNumber: 1, actionType: "search", description: "Search Google", status: "done" },
    ],
  };
  const settings = {
    assistantMode: "planning",
    onboardingCompleted: true,
    aiProvider: "openai",
    aiModel: "gpt-4o-mini",
    includeScreenshotByDefault: false,
  };
  const session = {
    messages: [],
    activePlan: null,
    browserExecution,
    status: "executing",
  };
  const { api, emit } = createApiMock({ settings, session });
  const { createPanelController } = await importModule("../../renderer/js/panel/bootstrap.js");

  try {
    const controller = createPanelController({ api, doc: dom.window.document, win: dom.window });
    await controller.init();

    emit("session-updated", {
      messages: [],
      activePlan: null,
      browserExecution: {
        ...browserExecution,
        status: "success",
        finishedAt: "2026-04-24T10:01:00.000Z",
        finalMessage: "First search result for 'Open Guider': Title: Acik Kaynak Rehberleri, URL: https://opensource.guide/tr/",
        substeps: [
          { id: "1", stepNumber: 1, actionType: "search", description: "Search Google", status: "done" },
          { id: "2", stepNumber: 2, actionType: "extract", description: "Read the first result", status: "done" },
        ],
      },
      status: "idle",
    });

    const browserTaskView = dom.window.document.getElementById("browser-task-view");
    const browserTaskSummary = dom.window.document.querySelector(".browser-task-summary");
    const panelRoot = dom.window.document.querySelector(".panel");

    assert.equal(browserTaskView.classList.contains("hidden"), false);
    assert.ok(browserTaskSummary);
    assert.match(browserTaskSummary.textContent, /First search result for 'Open Guider'/);
    assert.match(browserTaskView.textContent, /Read the first result/);
    assert.equal(panelRoot.classList.contains("browser-task-active"), false);
  } finally {
    cleanupDomGlobals(dom);
  }
});

test("panel controller keeps guide actions hidden in planning mode until an active guide step exists", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../../renderer/index.html"), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost" });
  installDomGlobals(dom);

  const settings = {
    assistantMode: "planning",
    onboardingCompleted: true,
    aiProvider: "openai",
    aiModel: "gpt-4o-mini",
    includeScreenshotByDefault: false,
  };
  const session = {
    messages: [],
    activePlan: null,
    browserExecution: null,
    status: "idle",
  };
  const { api, emit } = createApiMock({ settings, session });
  const { createPanelController } = await importModule("../../renderer/js/panel/bootstrap.js");

  try {
    const controller = createPanelController({ api, doc: dom.window.document, win: dom.window });
    await controller.init();

    const panelActions = dom.window.document.getElementById("panel-actions");
    assert.equal(panelActions.classList.contains("hidden"), true);

    emit("session-updated", {
      messages: [],
      activePlan: {
        goal: "Guide mode plan",
        currentStepIndex: 0,
        steps: [
          { id: "step_1", title: "Step one", instruction: "Do the thing", status: "active" },
        ],
      },
      browserExecution: null,
      status: "waiting_user",
    });

    assert.equal(panelActions.classList.contains("hidden"), false);
  } finally {
    cleanupDomGlobals(dom);
  }
});

test("plan view updates browser substep rows in place and preserves the list container for long tasks", async () => {
  const dom = new JSDOM(`
    <!doctype html>
    <body>
      <div class="panel">
        <div id="browser-task-view" class="browser-task-view hidden"></div>
        <div id="plan-panel" class="plan-panel hidden"></div>
        <div id="plan-goal"></div>
        <div id="plan-progress"></div>
        <div id="plan-steps"></div>
      </div>
    </body>
  `);
  installDomGlobals(dom);
  const { createPlanView } = await importModule("../../renderer/js/panel/plan-view.js");

  try {
    const planView = createPlanView({
      doc: dom.window.document,
      dom: {
        browserTaskView: dom.window.document.getElementById("browser-task-view"),
        planPanel: dom.window.document.getElementById("plan-panel"),
        planGoal: dom.window.document.getElementById("plan-goal"),
        planProgress: dom.window.document.getElementById("plan-progress"),
        planSteps: dom.window.document.getElementById("plan-steps"),
      },
    });

    planView.renderBrowserExecution({
      taskId: "task-1",
      goal: "Open checkout",
      mode: "auto",
      trustLevel: "autopilot",
      status: "running",
      startedAt: "2026-04-24T10:00:00.000Z",
      substeps: [
        {
          id: "1",
          stepNumber: 1,
          actionType: "go_to_url",
          description: "Open the site",
          riskScore: 2,
          status: "running",
          message: "",
          error: null,
        },
      ],
    });

    const listBefore = dom.window.document.querySelector(".browser-task-list");
    const rowBefore = dom.window.document.querySelector('.browser-task-item[data-step-key="1"]');
    assert.ok(listBefore);
    assert.ok(rowBefore);
    assert.equal(rowBefore.classList.contains("is-running"), true);

    planView.renderBrowserExecution({
      taskId: "task-1",
      goal: "Open checkout",
      mode: "auto",
      trustLevel: "autopilot",
      status: "success",
      startedAt: "2026-04-24T10:00:00.000Z",
      finalMessage: "Task finished successfully.",
      substeps: [
        {
          id: "1",
          stepNumber: 1,
          actionType: "go_to_url",
          description: "Open the site",
          riskScore: 2,
          status: "done",
          message: "Loaded",
          error: null,
        },
        {
          id: "2",
          stepNumber: 2,
          actionType: "click",
          description: "Click checkout",
          riskScore: 3,
          status: "done",
          message: "Clicked",
          error: null,
        },
      ],
    });

    const listAfter = dom.window.document.querySelector(".browser-task-list");
    const rowAfter = dom.window.document.querySelector('.browser-task-item[data-step-key="1"]');

    assert.strictEqual(listAfter, listBefore);
    assert.strictEqual(rowAfter, rowBefore);
    assert.equal(rowAfter.classList.contains("is-done"), true);
    assert.match(dom.window.document.querySelector(".browser-task-summary").textContent, /Task finished successfully/);

    const longSubsteps = Array.from({ length: 51 }, (_, index) => ({
      id: String(index + 1),
      stepNumber: index + 1,
      actionType: "click",
      description: `Do step ${index + 1}`,
      riskScore: 2,
      status: "done",
      message: "",
      error: null,
    }));

    planView.renderBrowserExecution({
      taskId: "task-2",
      goal: "Long task",
      mode: "auto",
      trustLevel: "autopilot",
      status: "running",
      startedAt: "2026-04-24T11:00:00.000Z",
      substeps: longSubsteps,
    });

    const longList = dom.window.document.querySelector(".browser-task-list");
    longList.scrollTop = 120;

    planView.renderBrowserExecution({
      taskId: "task-2",
      goal: "Long task",
      mode: "auto",
      trustLevel: "autopilot",
      status: "running",
      startedAt: "2026-04-24T11:00:00.000Z",
      substeps: [
        ...longSubsteps,
        {
          id: "52",
          stepNumber: 52,
          actionType: "submit",
          description: "Submit the form",
          riskScore: 4,
          status: "running",
          message: "",
          error: null,
        },
      ],
    });

    assert.strictEqual(dom.window.document.querySelector(".browser-task-list"), longList);
    assert.equal(longList.scrollTop, 120);
    assert.equal(longList.querySelectorAll(".browser-task-item").length, 52);
  } finally {
    cleanupDomGlobals(dom);
  }
});
