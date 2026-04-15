const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("widget html contains plan action controls", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "../../renderer/widget.html"),
    "utf8",
  );

  assert.match(html, /id="btn-prev"/);
  assert.match(html, /id="btn-done"/);
  assert.match(html, /id="btn-skip"/);
  assert.match(html, /id="btn-regenerate"/);
  assert.match(html, /id="btn-recheck"/);
  assert.match(html, /id="btn-cancel-plan"/);
});
