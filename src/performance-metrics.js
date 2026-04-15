const MAX_SAMPLES = 240;
const MAX_EVENTS = 40;

class PerformanceMetrics {
  constructor() {
    this.metrics = new Map();
    this.events = [];
  }

  recordDuration(name, durationMs, { ok = true, meta = {} } = {}) {
    const safeName = String(name || "unknown");
    const safeDuration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    const existing = this.metrics.get(safeName) || {
      name: safeName,
      count: 0,
      successCount: 0,
      errorCount: 0,
      totalDurationMs: 0,
      minDurationMs: Number.POSITIVE_INFINITY,
      maxDurationMs: 0,
      lastDurationMs: 0,
      lastMeta: {},
      samples: [],
      updatedAt: null,
    };

    existing.count += 1;
    if (ok) {
      existing.successCount += 1;
    } else {
      existing.errorCount += 1;
    }
    existing.totalDurationMs += safeDuration;
    existing.minDurationMs = Math.min(existing.minDurationMs, safeDuration);
    existing.maxDurationMs = Math.max(existing.maxDurationMs, safeDuration);
    existing.lastDurationMs = safeDuration;
    existing.lastMeta = meta;
    existing.updatedAt = new Date().toISOString();
    existing.samples.push(safeDuration);
    if (existing.samples.length > MAX_SAMPLES) {
      existing.samples.shift();
    }

    this.metrics.set(safeName, existing);
  }

  addEvent(name, payload = {}) {
    this.events.push({
      ts: new Date().toISOString(),
      name: String(name || "event"),
      payload,
    });
    if (this.events.length > MAX_EVENTS) {
      this.events.shift();
    }
  }

  reset() {
    this.metrics.clear();
    this.events = [];
  }

  getSnapshot() {
    const metricList = [...this.metrics.values()]
      .map((metric) => {
        const sortedSamples = metric.samples.slice().sort((a, b) => a - b);
        const p95Index = Math.max(0, Math.floor(sortedSamples.length * 0.95) - 1);
        const p95DurationMs = sortedSamples.length > 0 ? sortedSamples[p95Index] : 0;
        const avgDurationMs = metric.count > 0
          ? metric.totalDurationMs / metric.count
          : 0;
        return {
          name: metric.name,
          count: metric.count,
          successCount: metric.successCount,
          errorCount: metric.errorCount,
          avgDurationMs: Number(avgDurationMs.toFixed(2)),
          minDurationMs: Number((Number.isFinite(metric.minDurationMs) ? metric.minDurationMs : 0).toFixed(2)),
          maxDurationMs: Number(metric.maxDurationMs.toFixed(2)),
          p95DurationMs: Number(p95DurationMs.toFixed(2)),
          lastDurationMs: Number(metric.lastDurationMs.toFixed(2)),
          lastMeta: metric.lastMeta,
          updatedAt: metric.updatedAt,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      generatedAt: new Date().toISOString(),
      metrics: metricList,
      events: this.events.slice().reverse(),
    };
  }
}

module.exports = {
  PerformanceMetrics,
};
