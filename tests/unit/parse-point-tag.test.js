const test = require("node:test");
const assert = require("node:assert/strict");

const { parsePointTag } = require("../../src/ai/index");

test("parsePointTag parses first point tag and removes it from spoken text", () => {
  const result = parsePointTag("Click there [POINT:800,500:Submit Button]");
  assert.deepEqual(result.coordinate, { x: 800, y: 500 });
  assert.equal(result.label, "Submit Button");
  assert.equal(result.spokenText, "Click there");
});

test("parsePointTag returns null coordinate when no tag", () => {
  const result = parsePointTag("No coordinates in this response.");
  assert.equal(result.coordinate, null);
  assert.equal(result.label, null);
  assert.equal(result.spokenText, "No coordinates in this response.");
});
