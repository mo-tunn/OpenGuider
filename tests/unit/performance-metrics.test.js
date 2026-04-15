const test = require("node:test");
const assert = require("node:assert/strict");

const { PerformanceMetrics } = require("../../src/performance-metrics");

test("performance metrics aggregates duration statistics", () => {
  const metrics = new PerformanceMetrics();
  metrics.recordDuration("ipc.capture-screenshot", 120, { ok: true, meta: { fromCache: false } });
  metrics.recordDuration("ipc.capture-screenshot", 80, { ok: true });
  metrics.recordDuration("ipc.capture-screenshot", 200, { ok: false, meta: { errorName: "TimeoutError" } });

  const snapshot = metrics.getSnapshot();
  const entry = snapshot.metrics.find((item) => item.name === "ipc.capture-screenshot");
  assert.ok(entry);
  assert.equal(entry.count, 3);
  assert.equal(entry.successCount, 2);
  assert.equal(entry.errorCount, 1);
  assert.ok(entry.avgDurationMs > 0);
  assert.ok(entry.p95DurationMs >= 80);
});

test("performance metrics reset clears all entries", () => {
  const metrics = new PerformanceMetrics();
  metrics.recordDuration("ipc.send-message", 500, { ok: true });
  metrics.reset();
  const snapshot = metrics.getSnapshot();
  assert.equal(snapshot.metrics.length, 0);
});
