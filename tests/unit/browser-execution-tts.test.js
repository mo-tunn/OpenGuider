const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createBrowserExecutionTtsController,
  getBrowserExecutionSubstepTtsText,
} = require("../../src/tts/browser-execution-tts");

test("browser execution substep tts extracts only start description text", () => {
  assert.equal(getBrowserExecutionSubstepTtsText({
    event: "substep_start",
    description: "  Navigate   to google.com  ",
  }), "Navigate to google.com");

  assert.equal(getBrowserExecutionSubstepTtsText({
    event: "substep_end",
    description: "Should not speak",
  }), "");

  assert.equal(getBrowserExecutionSubstepTtsText({
    event: "substep_start",
    description: "",
  }), "");
});

test("browser execution tts controller speaks latest substep only", async () => {
  const spoken = [];
  let releaseFirstSpeak;
  const firstSpeakStarted = new Promise((resolve) => {
    releaseFirstSpeak = resolve;
  });

  const controller = createBrowserExecutionTtsController({
    getSettings: async () => ({ ttsEnabled: true }),
    getSender: () => ({ id: "panel" }),
    speak: async (text, settings, sender, options = {}) => {
      spoken.push({ text, settings, sender, abortedAtStart: options.shouldAbort?.() === true });
      if (text === "Step one") {
        await firstSpeakStarted;
        spoken.push({ text: "Step one final", abortedBeforeSend: options.shouldAbort?.() === true });
      }
    },
  });

  const firstPromise = controller.handleSubstepProgress({
    event: "substep_start",
    stepNumber: 1,
    description: "Step one",
  });

  await Promise.resolve();

  const secondPromise = controller.handleSubstepProgress({
    event: "substep_start",
    stepNumber: 2,
    description: "Step two",
  });

  releaseFirstSpeak();
  await Promise.all([firstPromise, secondPromise]);

  assert.equal(spoken[0].text, "Step one");
  assert.equal(spoken[0].abortedAtStart, false);
  assert.equal(spoken[1].text, "Step two");
  assert.equal(spoken[1].abortedAtStart, false);
  assert.equal(spoken[2].text, "Step one final");
  assert.equal(spoken[2].abortedBeforeSend, true);
});

test("browser execution tts controller ignores non-start events", async () => {
  let speakCalls = 0;

  const controller = createBrowserExecutionTtsController({
    getSettings: async () => ({ ttsEnabled: true }),
    speak: async () => {
      speakCalls += 1;
    },
  });

  const handled = await controller.handleSubstepProgress({
    event: "substep_end",
    stepNumber: 1,
    description: "Done",
  });

  assert.equal(handled, false);
  assert.equal(speakCalls, 0);
});
