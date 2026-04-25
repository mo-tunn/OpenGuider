/**
 * @file execution-engine.js
 * Human-in-the-Loop orchestration loop.
 * Dequeues steps, evaluates auto-approve vs user-approval, emits IPC events,
 * and calls plugin.executeStep() when approved.
 */

const { EventEmitter } = require('events');
const { ipcMain } = require('electron');
const { createStepQueue } = require('./step-queue');
const { shouldAutoApprove } = require('./trust-manager');
const { createLogger } = require('../logger');

const logger = createLogger('execution-engine');

/** How long (ms) to wait for a user decision before auto-skipping */
const DECISION_TIMEOUT_MS = 120_000;

class ExecutionEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('../plugins/plugin-interface').OpenGuiderPlugin} opts.plugin
   * @param {'paranoid'|'balanced'|'autopilot'} opts.trustLevel
   * @param {Electron.BrowserWindow} opts.approvalWindow - the floating approval window
   * @param {string} opts.taskId
   */
  constructor({ plugin, trustLevel, approvalWindow, taskId }) {
    super();
    this._plugin = plugin;
    this._trustLevel = trustLevel;
    this._approvalWindow = approvalWindow;
    this._taskId = taskId;
    this._aborted = false;
    this._decisionTimeout = null;
    this._pendingDecisionResolve = null;
    this._pendingDecisionListener = null;
    this._pendingDecisionStepId = null;

    this._queue = createStepQueue(async (step) => this._processOneStep(step));

    // Forward queue events
    this._queue.on('step-started', (step) => this.emit('step-started', step));
    this._queue.on('drained', () => this.emit('drained'));
    this._queue.on('step-error', (step, err) => {
      logger.error('queue-step-error', { stepId: step?.id, error: err?.message });
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Enqueue a step for execution.
   * @param {import('../plugins/plugin-interface').Step} step
   */
  enqueueStep(step) {
    if (this._aborted) return;
    this._queue.enqueue(step);
  }

  pause() {
    this._queue.pause();
  }

  resume() {
    this._queue.resume();
  }

  /**
   * Override trust level for this task (e.g. user toggled "run all automatically").
   * @param {'paranoid'|'balanced'|'autopilot'} newTrustLevel
   */
  setTrustOverride(newTrustLevel) {
    logger.info('trust-override', { taskId: this._taskId, from: this._trustLevel, to: newTrustLevel });
    this._trustLevel = newTrustLevel;
  }

  /**
   * Abort all — clears the queue, cancels pending user decision, calls plugin.abort().
   * @returns {Promise<void>}
   */
  async abort() {
    if (this._aborted) return;
    this._aborted = true;
    this._queue.abort();

    // Resolve any pending user decision so the processOneStep promise chain unblocks
    if (this._pendingDecisionResolve) {
      this._pendingDecisionResolve({ decision: 'abort' });
      this._pendingDecisionResolve = null;
    }
    if (this._pendingDecisionListener) {
      ipcMain.removeListener('execution:step-decision', this._pendingDecisionListener);
      this._pendingDecisionListener = null;
    }
    this._pendingDecisionStepId = null;
    if (this._decisionTimeout) {
      clearTimeout(this._decisionTimeout);
      this._decisionTimeout = null;
    }

    try {
      await this._plugin.abort();
    } catch (err) {
      logger.warn('plugin-abort-error', { error: err?.message });
    }

    this._sendToApprovalWindow('execution:aborted', { taskId: this._taskId });
    this.emit('aborted', { taskId: this._taskId });
    logger.info('engine-aborted', { taskId: this._taskId });
  }

  /**
   * Wait until all enqueued steps have been processed.
   * @returns {Promise<void>}
   */
  drain() {
    return this._queue.drain();
  }

  // ── Internal step processing ──────────────────────────────────────────────

  /**
   * The heart of the HITL loop — called by StepQueue for each dequeued step.
   * @param {import('../plugins/plugin-interface').Step} step
   * @returns {Promise<import('../plugins/plugin-interface').StepResult>}
   */
  async _processOneStep(step) {
    if (this._aborted) {
      return this._makeSkipResult(step, 'Aborted');
    }

    // ── 1. Ask plugin to describe and score the step ─────────────────────
    let description, riskScore;
    try {
      description = this._plugin.describeStep(step);
      riskScore = this._plugin.getRiskScore(step);
    } catch (err) {
      logger.warn('step-describe-error', { stepId: step.id, error: err?.message });
      description = `Execute ${step.type} action`;
      riskScore = 3;
    }

    logger.info('step-processing', { stepId: step.id, riskScore, trustLevel: this._trustLevel });

    // ── 2. Auto-approve check ─────────────────────────────────────────────
    const autoApprove = shouldAutoApprove(step, this._trustLevel, this._plugin);

    // ── 3. If not auto-approved, emit pending event and await user decision ─
    if (!autoApprove) {
      const screenshotBefore = step.context?.screenshot || '';
      this._sendToApprovalWindow('execution:step-pending', {
        taskId: this._taskId,
        step,
        description,
        riskScore,
        screenshotBefore,
      });

      const decision = await this._awaitUserDecision(step.id, this._taskId);

      if (decision.decision === 'abort') {
        await this.abort();
        return this._makeSkipResult(step, 'Aborted by user');
      }

      if (decision.decision === 'skip') {
        this._sendToApprovalWindow('execution:step-complete', this._makeSkipResult(step, 'Skipped by user'));
        return this._makeSkipResult(step, 'Skipped by user');
      }

      if (decision.decision === 'edit' && decision.editedPayload) {
        step = { ...step, payload: { ...step.payload, ...decision.editedPayload } };
      }
      // 'approve' falls through to execution
    }

    // ── 4. Execute ────────────────────────────────────────────────────────
    let result;
    try {
      result = await this._plugin.executeStep(step);
    } catch (err) {
      logger.error('execute-step-error', { stepId: step.id, error: err?.message });
      result = {
        stepId: step.id,
        success: false,
        screenshot: '',
        message: `Execution failed: ${err?.message || 'Unknown error'}`,
        requiresHumanReview: true,
        error: err?.message || 'Unknown error',
      };
    }

    // ── 5. Emit result ────────────────────────────────────────────────────
    this._sendToApprovalWindow('execution:step-complete', result);
    this.emit('step-complete', result);

    if (result.requiresHumanReview) {
      logger.info('step-flagged-for-review', { stepId: step.id });
    }

    return result;
  }

  /**
   * Wait for the renderer to send back a decision (approve/skip/abort/edit).
   * Auto-skips after DECISION_TIMEOUT_MS.
   * @param {string} stepId
   * @param {string} taskId
   * @returns {Promise<{ decision: string, editedPayload?: object }>}
   */
  _awaitUserDecision(stepId, taskId) {
    return new Promise((resolve) => {
      // Ensure only one active decision listener at a time.
      if (this._pendingDecisionListener) {
        ipcMain.removeListener('execution:step-decision', this._pendingDecisionListener);
        this._pendingDecisionListener = null;
      }

      const settleDecision = (payload) => {
        if (this._decisionTimeout) {
          clearTimeout(this._decisionTimeout);
          this._decisionTimeout = null;
        }
        if (this._pendingDecisionListener) {
          ipcMain.removeListener('execution:step-decision', this._pendingDecisionListener);
          this._pendingDecisionListener = null;
        }
        this._pendingDecisionResolve = null;
        this._pendingDecisionStepId = null;
        resolve(payload);
      };

      this._pendingDecisionResolve = settleDecision;
      this._pendingDecisionStepId = stepId;

      // Timeout: auto-skip if no response
      this._decisionTimeout = setTimeout(() => {
        logger.warn('decision-timeout', { stepId });
        settleDecision({ decision: 'skip', stepId });
      }, DECISION_TIMEOUT_MS);

      const onDecision = (_event, payload) => {
        if (payload?.taskId && payload.taskId !== taskId) {
          logger.warn('decision-taskid-mismatch', { expected: taskId, got: payload?.taskId, stepId });
          return;
        }
        if (payload?.stepId !== stepId) {
          // Ignore stale decisions; keep waiting for the active step.
          logger.warn('decision-stepid-mismatch', { expected: stepId, got: payload?.stepId });
          return;
        }

        logger.info('decision-received', { stepId, decision: payload?.decision || 'unknown' });
        settleDecision(payload);
      };

      this._pendingDecisionListener = onDecision;
      ipcMain.on('execution:step-decision', onDecision);
    });
  }

  /**
   * Listen for trust-level overrides from the renderer.
   * Call once after construction.
   */
  listenForTrustOverrides() {
    ipcMain.on('execution:trust-override', (_event, payload) => {
      if (payload?.taskId === this._taskId && payload?.newTrustLevel) {
        this.setTrustOverride(payload.newTrustLevel);
      }
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _sendToApprovalWindow(channel, payload) {
    const win = this._approvalWindow;
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }

  /**
   * @param {import('../plugins/plugin-interface').Step} step
   * @param {string} reason
   * @returns {import('../plugins/plugin-interface').StepResult}
   */
  _makeSkipResult(step, reason) {
    return {
      stepId: step.id,
      success: false,
      screenshot: '',
      message: reason,
      requiresHumanReview: false,
    };
  }
}

module.exports = { ExecutionEngine };
