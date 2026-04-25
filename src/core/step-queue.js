/**
 * @file step-queue.js
 * Async FIFO queue that ensures steps execute one at a time.
 * Supports pause, resume, and drain.
 * Depends only on Node.js built-ins.
 */

const { EventEmitter } = require('events');

class StepQueue extends EventEmitter {
  /**
   * @param {(step: import('../plugins/plugin-interface').Step) => Promise<import('../plugins/plugin-interface').StepResult>} processStep
   */
  constructor(processStep) {
    super();
    if (typeof processStep !== 'function') {
      throw new TypeError('StepQueue requires a processStep function');
    }
    this._processStep = processStep;
    /** @type {import('../plugins/plugin-interface').Step[]} */
    this._queue = [];
    this._paused = false;
    this._processing = false;
    this._aborted = false;
    /** @type {(() => void)[]} drainWaiters */
    this._drainWaiters = [];
  }

  // ── State getters ─────────────────────────────────────────────────────────

  get length() { return this._queue.length; }
  get isPaused() { return this._paused; }
  get isProcessing() { return this._processing; }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Add a step to the end of the queue and trigger processing if idle.
   * @param {import('../plugins/plugin-interface').Step} step
   */
  enqueue(step) {
    if (this._aborted) return;
    this._queue.push(step);
    this.emit('step-added', step);
    void this._processNext();
  }

  /** Suspend processing. The current step finishes; next step waits. */
  pause() {
    if (this._paused) return;
    this._paused = true;
    this.emit('paused');
  }

  /** Resume after a pause. */
  resume() {
    if (!this._paused) return;
    this._paused = false;
    this.emit('resumed');
    void this._processNext();
  }

  /**
   * Clear the queue and prevent new steps from running.
   * Does NOT abort the currently-running step — call plugin.abort() for that.
   */
  abort() {
    this._aborted = true;
    this._queue = [];
    this._paused = false;
    this._notifyDrainWaiters();
  }

  /**
   * Reset abort flag so the queue can be reused.
   */
  reset() {
    this._aborted = false;
    this._queue = [];
    this._paused = false;
    this._processing = false;
  }

  /**
   * Returns a Promise that resolves when the queue is empty and not processing.
   * @returns {Promise<void>}
   */
  drain() {
    if (!this._processing && this._queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this._drainWaiters.push(resolve);
    });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /** Start processing the next step if conditions allow. */
  async _processNext() {
    if (this._processing || this._paused || this._aborted || this._queue.length === 0) {
      return;
    }
    const step = this._queue.shift();
    this._processing = true;
    this.emit('step-started', step);

    try {
      const result = await this._processStep(step);
      this.emit('step-complete', result);
    } catch (err) {
      this.emit('step-error', step, err);
    } finally {
      this._processing = false;
      if (this._queue.length === 0) {
        this.emit('drained');
        this._notifyDrainWaiters();
      }
      // Schedule next tick to avoid deep call stacks with many steps
      setImmediate(() => {
        void this._processNext();
      });
    }
  }

  _notifyDrainWaiters() {
    const waiters = this._drainWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

/**
 * Factory function.
 * @param {Function} processStep
 * @returns {StepQueue}
 */
function createStepQueue(processStep) {
  return new StepQueue(processStep);
}

module.exports = { StepQueue, createStepQueue };
