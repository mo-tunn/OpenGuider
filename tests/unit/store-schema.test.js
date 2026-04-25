const test = require("node:test");
const assert = require("node:assert/strict");

const { schema } = require("../../src/store");

test("store schema defaults aware assistance to disabled", () => {
  assert.ok(schema.awareAssistanceEnabled);
  assert.equal(schema.awareAssistanceEnabled.type, "boolean");
  assert.equal(schema.awareAssistanceEnabled.default, false);
});
