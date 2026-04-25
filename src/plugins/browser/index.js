/**
 * @file index.js  (Browser Plugin)
 * Implements OpenGuiderPlugin for browser automation.
 * Delegates execution to the Python sidecar via BrowserBridge.
 */

const http = require('http');
const { OpenGuiderPlugin } = require('../plugin-interface');
const { Sidecar }          = require('./sidecar');
const { BrowserBridge }    = require('../../ipc/browser-bridge');
const { getBrowserRiskScore } = require('./risk-scorer');
const { createLogger }     = require('../../logger');

const logger = createLogger('browser-plugin');

class BrowserPlugin extends OpenGuiderPlugin {
  constructor() {
    super();
    /** @type {Sidecar|null} */
    this._sidecar = null;
    /** @type {BrowserBridge|null} */
    this._bridge  = null;
    /** @type {((err: Error) => void)|null} */
    this._crashHandler = null;
    /** @type {http.Server|null} */
    this._callbackServer = null;
    /** @type {((subStep: import('../plugin-interface').SubStep) => Promise<'continue'|'skip'|'replan'|'abort'>)|null} */
    this._substepHandler = null;
    /** @type {Map<number, { startedAt: number, actionType: string, description: string, riskScore: number }>} */
    this._substepState = new Map();
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  get id()      { return 'browser'; }
  get name()    { return 'Browser Automation'; }
  get version() { return '1.0.0'; }

  get capabilities() {
    return [
      // Typed actions (for future granular steps)
      'navigate', 'click', 'type', 'input', 'scroll', 'submit',
      'screenshot', 'select', 'upload', 'download', 'delete',
      'logout', 'purchase', 'confirm_dialog', 'evaluate',
      'go_back', 'wait', 'extract', 'find_text', 'search',
      'send_keys', 'hover', 'focus', 'switch', 'close',
      'write_file', 'replace_file', 'fill_form',
      // Pass-through free-form
      'browser_action',
    ];
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * @param {object} config
   * @param {boolean} [config.headless]
   * @param {string}  [config.llmProvider]
   * @param {string}  [config.llmApiKey]
   * @param {string}  [config.llmModel]
   * @param {Function} [config.onCrash] - called if sidecar crashes mid-task
   * @returns {Promise<void>}
   */
  async initialize(config = {}) {
    if (this._sidecar?.isRunning) {
      logger.info('browser-plugin-already-running');
      return;
    }

    this._sidecar = new Sidecar();

    // Pass LLM credentials as environment variables into the Python process
    const envOverrides = {};
    if (config.llmProvider)  envOverrides.OPENGUIDER_LLM_PROVIDER = config.llmProvider;
    if (config.llmApiKey)    envOverrides.OPENGUIDER_LLM_API_KEY  = config.llmApiKey;
    if (config.llmModel)     envOverrides.OPENGUIDER_LLM_MODEL    = config.llmModel;
    if (config.headless === false) envOverrides.BROWSER_HEADLESS  = 'false';

    // Forward crash events
    this._crashHandler = (err) => {
      logger.error('sidecar-crash', { error: err?.message });
      if (typeof config.onCrash === 'function') {
        config.onCrash(err);
      }
    };
    this._sidecar.on('crashed', this._crashHandler);

    await this._sidecar.start(envOverrides);
    this._bridge = new BrowserBridge(this._sidecar);
    await this._startCallbackServer(this._sidecar.callbackPort);
    logger.info('browser-plugin-initialized', { port: this._sidecar.port });
  }

  /** @returns {Promise<void>} */
  async shutdown() {
    this._substepHandler = null;
    this._substepState.clear();
    await this._stopCallbackServer();
    if (this._sidecar) {
      try {
        await this._sidecar.shutdown();
      } catch (err) {
        logger.warn('browser-plugin-shutdown-error', { error: err?.message });
      }
      this._sidecar = null;
      this._bridge  = null;
    }
  }

  // ── Execution ─────────────────────────────────────────────────────────────

  /**
   * @param {import('../plugin-interface').Step} step
   * @returns {Promise<import('../plugin-interface').StepResult>}
   */
  async executeStep(step) {
    this._assertReady();
    logger.info('execute-step', { stepId: step.id, type: step.type });
    return this._bridge.executeStep(step);
  }

  /**
   * @param {string} goal
   * @param {import('../plugin-interface').RunGoalOptions} options
   * @returns {Promise<import('../plugin-interface').GoalResult>}
   */
  async runGoal(goal, options = {}) {
    this._assertReady();
    const trustLevel = options.trustLevel || 'balanced';
    const onSubStep = typeof options.onSubStep === 'function' ? options.onSubStep : null;
    const signal = options.signal;

    let abortListener = null;
    if (signal && typeof signal.addEventListener === 'function') {
      abortListener = () => {
        void this.abort();
      };
      if (signal.aborted) {
        abortListener();
      } else {
        signal.addEventListener('abort', abortListener, { once: true });
      }
    }

    this._substepHandler = onSubStep;
    this._substepState.clear();
    logger.info('run-goal-start', { goalPreview: String(goal || '').slice(0, 160), trustLevel });
    try {
      const result = await this._bridge.runGoal(goal, { trustLevel });
      const summary = String(result?.summary || '');
      const error = result?.error ? String(result.error) : '';
      logger.info('run-goal-complete', {
        success: Boolean(result?.success),
        stepsCompleted: Number(result?.stepsCompleted) || 0,
        summary,
        error,
      });
      return {
        success: Boolean(result?.success),
        summary,
        stepsCompleted: Number(result?.stepsCompleted) || 0,
        screenshotFinal: String(result?.screenshotFinal || ''),
        error: error || undefined,
      };
    } finally {
      this._substepHandler = null;
      if (signal && abortListener) {
        signal.removeEventListener('abort', abortListener);
      }
    }
  }

  async pause()  { if (this._bridge) await this._bridge.pause(); }
  async resume() { if (this._bridge) await this._bridge.resume(); }

  async abort() {
    if (this._bridge) {
      try { await this._bridge.abort(); } catch (_) {}
    }
    // Keep the sidecar alive for future tasks; abort only the active browser run.
    logger.info('browser-plugin-abort-current-run');
  }

  // ── Sync helpers ──────────────────────────────────────────────────────────

  /**
   * @param {import('../plugin-interface').Step} step
   * @returns {number} 1–5
   */
  getRiskScore(step) {
    return getBrowserRiskScore(step);
  }

  /**
   * Produce a plain-English one-liner for the approval card.
   * @param {import('../plugin-interface').Step} step
   * @returns {string}
   */
  describeStep(step) {
    const p = step?.payload || {};
    switch ((step?.type || '').toLowerCase()) {
      case 'navigate':
        return `Navigate to ${p.url || 'a URL'}`;
      case 'click':
        return `Click the ${p.label || p.selector || 'element'}`;
      case 'type':
      case 'input':
        return `Type "${p.text || p.value || '...'}" into ${p.selector || 'a field'}`;
      case 'submit':
        return `Submit the form on ${p.url || 'the current page'}`;
      case 'upload':
        return `Upload file to ${p.selector || 'the current page'}`;
      case 'download':
        return `Download file from ${p.url || 'the current page'}`;
      case 'scroll':
        return `Scroll ${p.direction || 'down'} on the page`;
      case 'screenshot':
        return 'Take a screenshot of the current page';
      case 'select':
      case 'select_dropdown':
        return `Select "${p.value || '...'}" from ${p.selector || 'a dropdown'}`;
      case 'delete':
        return `Delete ${p.target || 'item'} (irreversible)`;
      case 'logout':
        return 'Log out of the current session';
      case 'purchase':
        return `Complete purchase on ${p.url || 'the current page'}`;
      case 'confirm_dialog':
        return `Confirm the dialog: "${p.message || '...'}"`;
      case 'evaluate':
        return `Execute JavaScript: ${(p.script || '').slice(0, 60)}${(p.script || '').length > 60 ? '…' : ''}`;
      case 'browser_action':
        return p.instruction
          ? p.instruction.slice(0, 120) + (p.instruction.length > 120 ? '…' : '')
          : 'Perform browser action';
      default:
        return `${step.type} on ${p.url || 'the current page'}`;
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _assertReady() {
    if (!this._sidecar?.isRunning || !this._bridge) {
      throw new Error('Browser plugin is not initialized. Call initialize() first.');
    }
  }

  async _startCallbackServer(port) {
    if (!port) return;
    if (this._callbackServer) return;

    this._callbackServer = http.createServer((req, res) => {
      void this._handleCallbackRequest(req, res);
    });

    await new Promise((resolve, reject) => {
      this._callbackServer.once('error', reject);
      this._callbackServer.listen(port, '127.0.0.1', () => {
        this._callbackServer.removeListener('error', reject);
        resolve();
      });
    });
  }

  async _stopCallbackServer() {
    if (!this._callbackServer) return;
    await new Promise((resolve) => {
      this._callbackServer.close(() => resolve());
    });
    this._callbackServer = null;
  }

  async _handleCallbackRequest(req, res) {
    if (req.method !== 'POST' || req.url !== '/substep') {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    let payload;
    try {
      payload = await this._readJsonBody(req);
    } catch (err) {
      logger.warn('substep-callback-invalid-json', { error: err?.message });
      res.statusCode = 400;
      res.end('Invalid JSON');
      return;
    }

    let decision = 'continue';
    try {
      decision = await this._handleSubstepPayload(payload);
    } catch (err) {
      logger.warn('substep-callback-handler-error', { error: err?.message });
      decision = 'continue';
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, decision }));
  }

  _readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        if (!raw) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  async _handleSubstepPayload(payload) {
    const event = payload?.event === 'substep_end' ? 'substep_end' : 'substep_start';
    const stepNumber = Number(payload?.stepNumber) || 0;
    const action = this._normalizeSubstepAction(payload?.action);
    const actionType = payload?.actionType || this._getActionType(action);
    const description = payload?.description || this._describeSubstepAction(actionType, action);
    const riskScore = Number(payload?.riskScore) || this._estimateSubstepRisk(actionType);
    const screenshotBefore = event === 'substep_start' && this._bridge
      ? await this._bridge.getScreenshot()
      : '';
    const screenshotAfter = event === 'substep_end' && this._bridge
      ? await this._bridge.getScreenshot()
      : '';

    const subStep = {
      event,
      stepNumber,
      actionType,
      action,
      description,
      screenshotBefore,
      screenshotAfter,
      riskScore,
      success: payload?.success,
      message: payload?.message ? String(payload.message) : '',
      error: payload?.error ? String(payload.error) : null,
      timestamp: Date.now(),
    };

    this._logSubstepEvent(subStep);

    if (!this._substepHandler) {
      return 'continue';
    }

    const decision = await this._substepHandler(subStep);
    if (event === 'substep_end') {
      return 'continue';
    }
    if (decision === 'abort') {
      return 'abort';
    }
    if (decision === 'replan') {
      return 'replan';
    }
    if (decision === 'skip') {
      return 'skip';
    }
    return 'continue';
  }

  _logSubstepEvent(subStep) {
    const stepNumber = Number(subStep?.stepNumber) || 0;
    const event = String(subStep?.event || 'substep_start');
    const actionType = String(subStep?.actionType || 'action');
    const description = String(subStep?.description || 'Browser action');
    const riskScore = Number(subStep?.riskScore) || 3;

    if (event === 'substep_start') {
      this._substepState.set(stepNumber, {
        startedAt: Date.now(),
        actionType,
        description,
        riskScore,
      });
      logger.info('browser-substep-start', {
        stepNumber,
        actionType,
        description,
        riskScore,
      });
      return;
    }

    const previous = this._substepState.get(stepNumber);
    this._substepState.delete(stepNumber);
    logger.info('browser-substep-end', {
      stepNumber,
      actionType: previous?.actionType || actionType,
      description: previous?.description || description,
      riskScore: previous?.riskScore || riskScore,
      durationMs: previous?.startedAt ? Date.now() - previous.startedAt : undefined,
    });
  }

  _normalizeSubstepAction(action) {
    if (Array.isArray(action)) {
      return this._normalizeSubstepAction(action.find(Boolean) || {});
    }
    if (action && typeof action === 'object') {
      if (Array.isArray(action.action)) {
        return this._normalizeSubstepAction(action.action);
      }
      return action;
    }
    if (typeof action === 'string') {
      return { raw: action };
    }
    return {};
  }

  _getActionType(action) {
    const keys = Object.keys(action || {});
    if (keys.length === 0 || (keys.length === 1 && keys[0] === 'raw')) return 'action';
    return keys[0];
  }

  _describeSubstepAction(actionType, action) {
    const raw = typeof action?.raw === 'string' ? action.raw.trim() : '';
    if (raw) {
      return raw.slice(0, 140);
    }

    const payload = action?.[actionType];
    if (payload && typeof payload === 'object') {
      const text = payload.url || payload.selector || payload.text || payload.value || payload.query || payload.target || payload.title || payload.goal;
      if (text) {
        return `${actionType}: ${String(text).slice(0, 140)}`;
      }
    }

    if (action && typeof action === 'object') {
      const text = action.url || action.selector || action.text || action.value || action.query || action.target || action.title || action.goal;
      if (text) {
        return `${actionType}: ${String(text).slice(0, 140)}`;
      }
    }
    return actionType || 'browser action';
  }

  _estimateSubstepRisk(actionType) {
    const t = String(actionType || '').toLowerCase();
    if (!t) return 3;
    if (['navigate', 'go_to_url', 'open_url', 'open_tab', 'go_back', 'wait', 'scroll', 'scroll_down', 'scroll_up', 'extract', 'extract_content', 'find_text', 'hover', 'search_google'].includes(t)) return 2;
    if (['click', 'click_element', 'click_element_by_index', 'type', 'input', 'input_text', 'send_keys', 'select', 'focus'].includes(t)) return 3;
    if (['submit', 'upload', 'download', 'write_file', 'replace_file', 'delete', 'purchase', 'confirm_dialog'].includes(t)) return 4;
    return 3;
  }
}

module.exports = { BrowserPlugin };
