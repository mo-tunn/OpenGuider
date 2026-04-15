const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeCoordinate,
  resolveCalibrationForDisplay,
} = require("../../src/agent/tools/pointer-tool");

test("normalizeCoordinate maps normalized 0-1000 to display bounds", () => {
  const displayBounds = { x: 0, y: 0, width: 1920, height: 1080 };
  const result = normalizeCoordinate({ x: 500, y: 500 }, displayBounds, null);
  assert.deepEqual(result, { x: 960, y: 540 });
});

test("normalizeCoordinate respects calibration scale for high-res screenshots", () => {
  const displayBounds = { x: 0, y: 0, width: 1920, height: 1080 };
  const calibration = {
    sourceWidth: 3840,
    sourceHeight: 2160,
    scaleX: 0.5,
    scaleY: 0.5,
  };
  const result = normalizeCoordinate({ x: 500, y: 500 }, displayBounds, calibration);
  assert.deepEqual(result, { x: 960, y: 540 });
});

test("resolveCalibrationForDisplay prefers requested screenNumber", () => {
  const calibration = resolveCalibrationForDisplay({
    pointer: { screenNumber: 2 },
    targetDisplay: { id: "primary" },
    pointerCalibration: {
      byScreenNumber: {
        2: { sourceWidth: 2560, sourceHeight: 1440, scaleX: 1, scaleY: 1 },
      },
      byDisplayId: {},
    },
  });
  assert.equal(calibration.sourceWidth, 2560);
});
