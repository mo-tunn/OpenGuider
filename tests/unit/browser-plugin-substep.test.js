const test = require("node:test");
const assert = require("node:assert/strict");

const { BrowserPlugin } = require("../../src/plugins/browser/index");

test("browser plugin derives descriptive substep data from end-only callback payloads", async () => {
  const plugin = new BrowserPlugin();
  plugin._bridge = {
    getScreenshot: async () => "after-shot",
  };

  let captured = null;
  plugin._substepHandler = async (subStep) => {
    captured = subStep;
    return "continue";
  };

  const decision = await plugin._handleSubstepPayload({
    event: "substep_end",
    stepNumber: 2,
    action: {
      go_to_url: {
        url: "https://www.amazon.com",
      },
    },
  });

  assert.equal(decision, "continue");
  assert.ok(captured);
  assert.equal(captured.event, "substep_end");
  assert.equal(captured.stepNumber, 2);
  assert.equal(captured.actionType, "go_to_url");
  assert.match(captured.description, /amazon\.com/i);
  assert.equal(captured.riskScore, 2);
  assert.equal(captured.screenshotAfter, "after-shot");
  assert.equal(typeof captured.timestamp, "number");
});
