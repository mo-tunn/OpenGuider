const test = require("node:test");
const assert = require("node:assert/strict");

const { extractJSONObject } = require("../../src/agent/schemas");

test("extractJSONObject parses fenced json response", () => {
  const payload = extractJSONObject("```json\n{\"ok\":true,\"count\":2}\n```");
  assert.equal(payload.ok, true);
  assert.equal(payload.count, 2);
});

test("extractJSONObject throws when model does not return json", () => {
  assert.throws(() => extractJSONObject("plain text only"), {
    message: /Model did not return a JSON object/,
  });
});
