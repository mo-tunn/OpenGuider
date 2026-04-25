const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

const { ExecutionLog } = require("../../renderer/components/execution-log/ExecutionLog.js");

test("execution log renders a finished substep even when no start event was received", () => {
  const dom = new JSDOM("<!doctype html><body><div id=\"execution-log\"></div></body>");
  const listeners = new Map();

  global.window = dom.window;
  global.document = dom.window.document;
  global.openguider = {
    on(channel, cb) {
      listeners.set(channel, cb);
      return () => listeners.delete(channel);
    },
  };

  try {
    const container = document.getElementById("execution-log");
    new ExecutionLog(container);

    const onSubstepProgress = listeners.get("execution:substep-progress");
    assert.equal(typeof onSubstepProgress, "function");

    onSubstepProgress({
      event: "substep_end",
      stepNumber: 4,
      actionType: "go_to_url",
      description: "go_to_url: https://www.amazon.com",
      riskScore: 2,
      timestamp: 1710000000000,
      screenshotAfter: "",
      message: "",
      error: null,
    });

    assert.match(container.textContent, /Execution Log/);
    assert.match(container.textContent, /1 step/);
    assert.match(container.textContent, /amazon\.com/i);
  } finally {
    delete global.window;
    delete global.document;
    delete global.openguider;
    dom.window.close();
  }
});
