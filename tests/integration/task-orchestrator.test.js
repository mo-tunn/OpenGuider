const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const { SessionManager } = require("../../src/session/session-manager");
const { OpenGuiderPlugin } = require("../../src/plugins/plugin-interface");
const { registry } = require("../../src/core/plugin-registry");

class FakeBrowserPlugin extends OpenGuiderPlugin {
  constructor({ runGoal, abort } = {}) {
    super();
    this._runGoal = runGoal || (async () => ({
      success: true,
      summary: "Completed",
      stepsCompleted: 0,
      screenshotFinal: "",
    }));
    this._abort = abort || (async () => {});
  }

  get id() { return "browser"; }
  get name() { return "Fake Browser"; }
  get version() { return "1.0.0"; }
  get capabilities() { return ["browser_action"]; }
  async initialize() {}
  async shutdown() {}
  async executeStep() { return { stepId: "noop", success: true, screenshot: "", message: "", requiresHumanReview: false }; }
  async runGoal(goal, options = {}) { return this._runGoal(goal, options); }
  async pause() {}
  async resume() {}
  async abort() { return this._abort(); }
  getRiskScore() { return 2; }
  describeStep() { return "fake"; }
}

function resetRegistry() {
  registry._plugins.clear();
}

function createMockIpcMain() {
  const emitter = new EventEmitter();
  return {
    emit: emitter.emit.bind(emitter),
    on: emitter.on.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
  };
}

function withMockedTaskOrchestrator(moduleOverrides, callback) {
  const taskPath = require.resolve("../../src/agent/task-orchestrator");
  const electronPath = require.resolve("electron");
  const originalTaskModule = require.cache[taskPath];
  const originalElectronExports = require(electronPath);
  const restoredModules = [];
  const ipcMain = createMockIpcMain();

  try {
    require.cache[electronPath].exports = {
      ...originalElectronExports,
      ipcMain,
    };

    for (const [relativePath, exportsOverride] of Object.entries(moduleOverrides)) {
      const absolutePath = require.resolve(relativePath);
      const originalExports = require(absolutePath);
      require.cache[absolutePath].exports = {
        ...originalExports,
        ...exportsOverride,
      };
      restoredModules.push({ absolutePath, originalExports });
    }

    delete require.cache[taskPath];
    const { TaskOrchestrator: MockedTaskOrchestrator } = require(taskPath);
    return callback({ TaskOrchestrator: MockedTaskOrchestrator, ipcMain });
  } finally {
    delete require.cache[taskPath];
    require.cache[electronPath].exports = originalElectronExports;
    for (const { absolutePath, originalExports } of restoredModules) {
      require.cache[absolutePath].exports = originalExports;
    }
    if (originalTaskModule) {
      require.cache[taskPath] = originalTaskModule;
    }
  }
}

test("markStepDone completes single-step plan in manual confirmation flow", async () => {
  await withMockedTaskOrchestrator({}, async ({ TaskOrchestrator }) => {
    const sessionManager = new SessionManager();
    const orchestrator = new TaskOrchestrator({
      captureAllScreens: async () => [],
      sessionManager,
      prePostLayersEnabled: false,
    });

    sessionManager.setActivePlan({
      goal: "Single step flow",
      currentStepIndex: 0,
      steps: [
        {
          id: "step_1",
          title: "Only step",
          instruction: "Do one thing",
          successCriteria: "Done",
        },
      ],
      status: "active",
    });
    sessionManager.setManualConfirmation({ stepId: "step_1", reason: "test" });

    const result = await orchestrator.markStepDone({ settings: {}, signal: null });
    assert.equal(result.pointer, null);
    assert.match(result.assistantMessage, /complete/i);
    assert.equal(result.session.activePlan, null);
    assert.equal(result.session.status, "idle");
  });
});

test("browser execution start and substep updates populate browserExecution in session", async () => {
  await withMockedTaskOrchestrator({}, async ({ TaskOrchestrator }) => {
    resetRegistry();
    registry.register(new FakeBrowserPlugin({
      runGoal: async (_goal, options) => {
        await options.onSubStep({
          event: "substep_start",
          stepNumber: 1,
          actionType: "go_to_url",
          description: "Open the site",
          riskScore: 2,
          timestamp: Date.parse("2026-04-24T10:00:01.000Z"),
        });
        await options.onSubStep({
          event: "substep_end",
          stepNumber: 1,
          actionType: "go_to_url",
          description: "Open the site",
          riskScore: 2,
          success: true,
          message: "Loaded successfully",
          timestamp: Date.parse("2026-04-24T10:00:03.000Z"),
        });

        return {
          success: true,
          summary: "Browser task completed.",
          stepsCompleted: 1,
          screenshotFinal: "",
        };
      },
    }));

    const sessionManager = new SessionManager();
    const orchestrator = new TaskOrchestrator({
      captureAllScreens: async () => [],
      sessionManager,
      prePostLayersEnabled: false,
    });
    orchestrator._intentRouter.route = async () => ({
      pluginId: "browser",
      goal: "Open checkout",
      suggestedTrustLevel: "autopilot",
      trust: "autopilot",
    });

    const result = await orchestrator.startGoalSession({
      text: "Open checkout",
      images: [],
      settings: { executionMode: "auto" },
      signal: null,
    });

    assert.match(result.assistantMessage, /completed/i);
    const snapshot = sessionManager.getSnapshot();
    assert.equal(snapshot.browserExecution.goal, "Open checkout");
    assert.equal(snapshot.browserExecution.mode, "auto");
    assert.equal(snapshot.browserExecution.status, "success");
    assert.equal(snapshot.browserExecution.finalMessage, "Browser task completed.");
    assert.equal(snapshot.messages.at(-1)?.role, "assistant");
    assert.equal(snapshot.messages.at(-1)?.content, "Browser task completed.");
    assert.equal(snapshot.browserExecution.substeps.length, 1);
    assert.equal(snapshot.browserExecution.substeps[0].status, "done");
    assert.equal(snapshot.browserExecution.substeps[0].actionType, "go_to_url");
  });
});

test("canceling an active browser task finalizes browserExecution as aborted", async () => {
  await withMockedTaskOrchestrator({}, async ({ TaskOrchestrator }) => {
    resetRegistry();

    let resolveGoal = null;
    let abortCalled = false;
    registry.register(new FakeBrowserPlugin({
      runGoal: async () => new Promise((resolve) => {
        resolveGoal = resolve;
      }),
      abort: async () => {
        abortCalled = true;
        resolveGoal?.({
          success: false,
          summary: "Aborted by user",
          stepsCompleted: 0,
          screenshotFinal: "",
        });
      },
    }));

    const sessionManager = new SessionManager();
    const orchestrator = new TaskOrchestrator({
      captureAllScreens: async () => [],
      sessionManager,
      prePostLayersEnabled: false,
    });
    orchestrator._intentRouter.route = async () => ({
      pluginId: "browser",
      goal: "Open account settings",
      suggestedTrustLevel: "autopilot",
      trust: "autopilot",
    });

    const startPromise = orchestrator.startGoalSession({
      text: "Open account settings",
      images: [],
      settings: { executionMode: "auto" },
      signal: null,
    });

    await Promise.resolve();
    const cancelResult = orchestrator.cancelActivePlan();
    const result = await startPromise;

    assert.match(cancelResult.assistantMessage, /cancelled/i);
    assert.match(result.assistantMessage, /aborted/i);
    assert.equal(abortCalled, true);
    assert.equal(sessionManager.getSnapshot().browserExecution.status, "aborted");
    assert.match(sessionManager.getSnapshot().browserExecution.finalMessage, /aborted/i);
  });
});

test("guide-mode start clears stale browser execution state", async () => {
  await withMockedTaskOrchestrator({
    "../../src/agent/planner-chain": {
      planGoal: async ({ goal }) => ({
        goal,
        currentStepIndex: 0,
        steps: [
          {
            id: "step_1",
            title: "First step",
            instruction: "Click the first thing",
            successCriteria: "Done",
          },
        ],
        status: "active",
      }),
    },
    "../../src/agent/executor-chain": {
      locateStepTarget: async () => ({
        coordinate: { x: 10, y: 20 },
        label: "Button",
        explanation: "Mocked pointer",
      }),
    },
    "../../src/agent/tools/capture-screen-tool": {
      captureScreenTool: async () => [],
    },
  }, async ({ TaskOrchestrator }) => {
    const sessionManager = new SessionManager();
    sessionManager.startBrowserExecution({
      taskId: "stale-task",
      goal: "Stale browser task",
      mode: "auto",
      trustLevel: "autopilot",
      status: "success",
      finalMessage: "Old task",
      startedAt: "2026-04-24T09:00:00.000Z",
      finishedAt: "2026-04-24T09:10:00.000Z",
    });

    const orchestrator = new TaskOrchestrator({
      captureAllScreens: async () => [],
      sessionManager,
      prePostLayersEnabled: false,
    });

    await orchestrator.startGoalSession({
      text: "Guide me through this",
      images: [],
      settings: { executionMode: "guide" },
      signal: null,
    });

    const snapshot = sessionManager.getSnapshot();
    assert.equal(snapshot.browserExecution, null);
    assert.ok(snapshot.activePlan);
    assert.equal(snapshot.activePlan.goal, "Guide me through this");
  });
});

test("aware assistance can be toggled live for fallback guidance layers", async () => {
  let preprocessCalls = 0;
  let distillCalls = 0;
  let postprocessCalls = 0;
  let clearCalls = 0;
  let setEnabledCalls = [];

  await withMockedTaskOrchestrator({
    "../../src/agent/interaction-pipeline": {
      createInteractionPipeline: () => ({
        setEnabled(enabled) {
          setEnabledCalls.push(enabled);
        },
        clear() {
          clearCalls += 1;
        },
        async preprocess() {
          preprocessCalls += 1;
          return {
            ocrResult: { lines: [{ text: "Submit" }] },
            windowInfo: { focusedWindow: { title: "Demo" } },
            matchedElements: [],
          };
        },
        async distillContext(text) {
          distillCalls += 1;
          return `${text}\n[AWARE]`;
        },
        async postprocess({ coordinate }) {
          postprocessCalls += 1;
          return {
            coordinate: { x: coordinate.x + 10, y: coordinate.y + 20 },
            reason: "verified",
            confidence: 0.9,
          };
        },
        shouldRecheck() {
          return false;
        },
        getFallbackCoordinate() {
          return null;
        },
      }),
    },
    "../../src/ai/index": {
      streamAIResponse: async ({ text }) => text,
      parsePointTag: () => ({
        coordinate: { x: 5, y: 6 },
        label: "Submit",
        spokenText: "Done",
      }),
    },
  }, async ({ TaskOrchestrator }) => {
    const sessionManager = new SessionManager();
    const orchestrator = new TaskOrchestrator({
      captureAllScreens: async () => [],
      sessionManager,
      prePostLayersEnabled: false,
    });
    const images = [{ base64Jpeg: Buffer.from("fake-image").toString("base64") }];

    assert.equal(orchestrator.isAwareAssistanceEnabled(), false);
    assert.deepEqual(setEnabledCalls, [false]);

    const disabledResult = await orchestrator.runSingleTurnFallback({
      text: "Click submit",
      images,
      settings: {},
      signal: null,
    });

    assert.equal(preprocessCalls, 0);
    assert.equal(distillCalls, 0);
    assert.equal(postprocessCalls, 0);
    assert.deepEqual(disabledResult.pointer.coordinate, { x: 5, y: 6 });

    orchestrator.setAwareAssistanceEnabled(true);
    assert.equal(orchestrator.isAwareAssistanceEnabled(), true);

    const enabledResult = await orchestrator.runSingleTurnFallback({
      text: "Click submit",
      images,
      settings: {},
      signal: null,
    });

    assert.equal(preprocessCalls, 1);
    assert.equal(distillCalls, 1);
    assert.equal(postprocessCalls, 1);
    assert.deepEqual(enabledResult.pointer.coordinate, { x: 15, y: 26 });

    orchestrator.setAwareAssistanceEnabled(false);
    assert.equal(orchestrator.isAwareAssistanceEnabled(), false);
    assert.equal(clearCalls, 2);
    assert.deepEqual(setEnabledCalls, [false, true, false]);
  });
});
