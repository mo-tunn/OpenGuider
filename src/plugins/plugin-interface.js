/**
 * @file plugin-interface.js
 * Abstract base class that every OpenGuider plugin must extend.
 * All method stubs throw NotImplementedError to enforce implementation.
 */

// ── Custom error ──────────────────────────────────────────────────────────────
class NotImplementedError extends Error {
  constructor(methodName) {
    super(`Plugin must implement: ${methodName}`);
    this.name = 'NotImplementedError';
  }
}

// ── JSDoc type definitions ────────────────────────────────────────────────────

/**
 * @typedef {'paranoid'|'balanced'|'autopilot'} TrustLevel
 */

/**
 * @typedef {object} StepContext
 * @property {string} screenshot - base64 PNG of the screen before this step
 * @property {string} notes      - additional context for the agent
 */

/**
 * @typedef {object} Step
 * @property {string}     id         - unique step ID (e.g. UUID or plan step id)
 * @property {string}     type       - action type; must be in plugin.capabilities
 * @property {object}     payload    - action-specific parameters
 * @property {StepContext} context   - screen state before execution
 * @property {TrustLevel} trustLevel - trust preset active when this step was enqueued
 */

/**
 * @typedef {object} StepResult
 * @property {string}  stepId              - matches Step.id
 * @property {boolean} success             - whether the action succeeded
 * @property {string}  screenshot          - base64 PNG after execution
 * @property {string}  message             - human-readable outcome summary
 * @property {boolean} requiresHumanReview - plugin can force review even in autopilot
 * @property {string}  [error]             - error message if success === false
 */

/**
 * @typedef {object} SubStep
 * @property {'substep_start'|'substep_end'} event
 * @property {number} stepNumber
 * @property {string} actionType
 * @property {object} action
 * @property {string} description
 * @property {string} screenshotBefore
 * @property {number} riskScore
 */

/**
 * @typedef {object} RunGoalOptions
 * @property {TrustLevel} [trustLevel]
 * @property {(subStep: SubStep) => Promise<'continue'|'skip'|'replan'|'abort'>} [onSubStep]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} GoalResult
 * @property {boolean} success
 * @property {string} summary
 * @property {number} stepsCompleted
 * @property {string} screenshotFinal
 * @property {string} [error]
 */

// ── Abstract base class ───────────────────────────────────────────────────────

class OpenGuiderPlugin {
  // ── Identity (getters must be overridden) ─────────────────────────────────

  /**
   * Unique plugin ID, e.g. "browser".
   * @returns {string}
   */
  get id() {
    throw new NotImplementedError('id');
  }

  /**
   * Human-readable display name.
   * @returns {string}
   */
  get name() {
    throw new NotImplementedError('name');
  }

  /**
   * Semver version string.
   * @returns {string}
   */
  get version() {
    throw new NotImplementedError('version');
  }

  /**
   * List of action type strings this plugin can handle.
   * The execution engine checks that step.type is in this list.
   * @returns {string[]}
   */
  get capabilities() {
    throw new NotImplementedError('capabilities');
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Called once by the registry when the app starts.
   * Should start any background processes (e.g. Python sidecar).
   * @param {object} config - plugin-specific configuration from settings
   * @returns {Promise<void>}
   */
  async initialize(_config) {
    throw new NotImplementedError('initialize');
  }

  /**
   * Called on app quit. Must release all resources within 3 seconds.
   * @returns {Promise<void>}
   */
  async shutdown() {
    throw new NotImplementedError('shutdown');
  }

  // ── Execution ─────────────────────────────────────────────────────────────

  /**
   * Execute a single step. Called by ExecutionEngine after approval.
   * @param {Step} step
   * @returns {Promise<StepResult>}
   */
  async executeStep(_step) {
    throw new NotImplementedError('executeStep');
  }

  /**
   * Run an entire goal autonomously. Plugin owns internal planning/execution.
   * @param {string} _goal
   * @param {RunGoalOptions} [_options]
   * @returns {Promise<GoalResult>}
   */
  async runGoal(_goal, _options = {}) {
    throw new NotImplementedError('runGoal');
  }

  /**
   * Pause execution. The current action finishes; no new actions start.
   * @returns {Promise<void>}
   */
  async pause() {
    throw new NotImplementedError('pause');
  }

  /**
   * Resume after a pause.
   * @returns {Promise<void>}
   */
  async resume() {
    throw new NotImplementedError('resume');
  }

  /**
   * Abort all current and queued actions immediately.
   * @returns {Promise<void>}
   */
  async abort() {
    throw new NotImplementedError('abort');
  }

  // ── Synchronous helpers (called in the hot-path; must be fast) ───────────

  /**
   * Return an integer risk score 1–5 for this step.
   * 1 = read-only / safe, 5 = irreversible / dangerous.
   * Implemented by the plugin because risk is domain-specific.
   * @param {Step} step
   * @returns {number}
   */
  getRiskScore(_step) {
    throw new NotImplementedError('getRiskScore');
  }

  /**
   * Return a plain-English one-sentence description of what this step does.
   * Shown in the approval card UI.
   * @param {Step} step
   * @returns {string}
   */
  describeStep(_step) {
    throw new NotImplementedError('describeStep');
  }
}

module.exports = { OpenGuiderPlugin, NotImplementedError };
