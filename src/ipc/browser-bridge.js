/**
 * @file browser-bridge.js
 * Thin HTTP client wrapper in the Node.js main process.
 * Translates typed method calls into HTTP requests to the Python sidecar.
 * The renderer never talks to Python directly — all communication routes here.
 */

const { createLogger } = require('../logger');

const logger = createLogger('browser-bridge');

const EXECUTE_TIMEOUT_MS = 180_000; // 3 min — browser tasks can be slow
const RUN_GOAL_TIMEOUT_MS = 900_000; // 15 min — full autonomous goal
const DEFAULT_TIMEOUT_MS = 5_000;

class BridgeNotReadyError extends Error {
  constructor() {
    super('BrowserBridge: sidecar is not running');
    this.name = 'BridgeNotReadyError';
  }
}

class BridgeError extends Error {
  /**
   * @param {number} status
   * @param {string} body
   */
  constructor(status, body) {
    super(`Sidecar responded with HTTP ${status}: ${body}`);
    this.name = 'BridgeError';
    this.status = status;
    this.body = body;
  }
}

class BrowserBridge {
  /**
   * @param {import('../plugins/browser/sidecar').Sidecar} sidecar
   */
  constructor(sidecar) {
    this._sidecar = sidecar;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Execute a step via the Python sidecar.
   * @param {import('../../plugins/plugin-interface').Step} step
   * @returns {Promise<import('../../plugins/plugin-interface').StepResult>}
   */
  async executeStep(step) {
    const result = await this._request('POST', '/execute', step, EXECUTE_TIMEOUT_MS);
    return result;
  }

  /**
   * Run a complete goal in one autonomous agent invocation.
   * @param {string} goal
   * @param {{ trustLevel?: string, maxSteps?: number }} options
   * @returns {Promise<object>}
   */
  async runGoal(goal, options = {}) {
    return this._request(
      'POST',
      '/run-goal',
      {
        goal,
        trustLevel: options.trustLevel || 'balanced',
        maxSteps: Number(options.maxSteps) || 50,
      },
      RUN_GOAL_TIMEOUT_MS,
    );
  }

  /** @returns {Promise<void>} */
  async pause() {
    await this._request('POST', '/pause', null, DEFAULT_TIMEOUT_MS);
  }

  /** @returns {Promise<void>} */
  async resume() {
    await this._request('POST', '/resume', null, DEFAULT_TIMEOUT_MS);
  }

  /** @returns {Promise<void>} */
  async abort() {
    await this._request('POST', '/abort', null, DEFAULT_TIMEOUT_MS);
  }

  /**
   * Get the current browser screenshot as a base64 PNG string.
   * Returns empty string on failure.
   * @returns {Promise<string>}
   */
  async getScreenshot() {
    try {
      const result = await this._request('GET', '/screenshot', null, DEFAULT_TIMEOUT_MS);
      return result?.screenshot || '';
    } catch (_) {
      return '';
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * @param {'GET'|'POST'} method
   * @param {string} path
   * @param {object|null} body
   * @param {number} timeoutMs
   * @returns {Promise<object>}
   */
  async _request(method, path, body, timeoutMs) {
    if (!this._sidecar.isRunning) {
      throw new BridgeNotReadyError();
    }

    const url = `http://127.0.0.1:${this._sidecar.port}${path}`;
    logger.debug('bridge-request', { method, path });

    const init = {
      method,
      signal: AbortSignal.timeout(timeoutMs),
    };

    if (body !== null && body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body    = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw new BridgeError(0, `Network error: ${err.message}`);
    }

    const text = await res.text();

    if (!res.ok) {
      throw new BridgeError(res.status, text);
    }

    try {
      return JSON.parse(text);
    } catch (_) {
      return { raw: text };
    }
  }
}

module.exports = { BrowserBridge, BridgeNotReadyError, BridgeError };
