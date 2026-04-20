const { clampToBounds, getPrimaryDisplay } = require("../validation/bounds-validator");

class FallbackManager {
  constructor() {
    this.history = [];
    this.maxHistory = 10;
    this.lastValidCoordinate = null;
  }

  clear() {
    this.history = [];
    this.lastValidCoordinate = null;
  }

  record(coordinate, reason = "unknown") {
    if (!coordinate) return;
    const record = {
      coordinate: { ...coordinate },
      reason,
      timestamp: Date.now(),
    };
    this.history.push(record);
    this.lastValidCoordinate = coordinate;
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  getLastValid() {
    return this.lastValidCoordinate;
  }

  getHistory() {
    return this.history.slice();
  }

  getFallbackCoordinate(options = {}) {
    const { useLastValid = true, defaultCenter = false, bounds = null } = options;
    if (useLastValid && this.lastValidCoordinate) {
      const fallback = { ...this.lastValidCoordinate };
      if (bounds) {
        return clampToBounds(fallback, bounds);
      }
      return fallback;
    }
    if (defaultCenter) {
      const display = getPrimaryDisplay();
      const displayBounds = display.bounds;
      return {
        x: Math.round(displayBounds.x + displayBounds.width / 2),
        y: Math.round(displayBounds.y + displayBounds.height / 2),
      };
    }
    return { x: 500, y: 500 };
  }

  analyzeJump(current, options = {}) {
    const { maxJumpDistance = 500 } = options;
    if (!current || !this.lastValidCoordinate) {
      return { suspicious: false, reason: "no reference" };
    }
    const last = this.lastValidCoordinate;
    const dx = current.x - last.x;
    const dy = current.y - last.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > maxJumpDistance) {
      return {
        suspicious: true,
        reason: `large jump (${distance.toFixed(0)}px)`,
        distance,
        lastCoordinate: last,
        currentCoordinate: current,
      };
    }
    return { suspicious: false, distance, reason: "normal" };
  }

  shouldRecheck(options = {}) {
    const { coordinate, threshold = 0.5 } = options;
    if (!coordinate) return true;
    const jumpAnalysis = this.analyzeJump(coordinate);
    if (jumpAnalysis.suspicious) return true;
    if (!this.lastValidCoordinate) return true;
    return false;
  }
}

function createFallbackManager() {
  return new FallbackManager();
}

module.exports = {
  FallbackManager,
  createFallbackManager,
};