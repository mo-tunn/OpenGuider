/**
 * StepApprovalCard.js
 * Self-contained UI component that renders the step approval dialog.
 * No framework — plain DOM. Reads from / writes to window.openguider IPC.
 *
 * Constructor: new StepApprovalCard(container, sectionEl)
 *   container  — the DOM element to render the card inside
 *   sectionEl  — wrapper element that is shown/hidden
 */

/* global openguider */

class StepApprovalCard {
  /**
   * @param {HTMLElement} container
   * @param {HTMLElement} sectionEl
   */
  constructor(container, sectionEl) {
    this._container  = container;
    this._sectionEl  = sectionEl;
    this._step       = null;
    this._taskId     = null;
    this._unsubscribe = null;
    this._decisionSentStepId = null;

    this._bindGlobal();
  }

  // ── IPC subscription ──────────────────────────────────────────────────────

  _bindGlobal() {
    // Listen for pending steps
    this._unsubscribe = openguider.on('execution:step-pending', (payload) => {
      this._show(payload);
    });

    // Hide card when step completes
    openguider.on('execution:step-complete', () => {
      this._hide();
    });

    openguider.on('execution:aborted', () => {
      this._hide();
    });

    // Keyboard shortcuts (global for this window)
    document.addEventListener('keydown', (e) => {
      if (!this._step) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._decide('approve');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this._decide('abort');
      } else if (e.key === 'r' || e.key === 'R') {
        const tag = document.activeElement?.tagName?.toLowerCase();
        if (tag === 'textarea' || tag === 'input') return;
        e.preventDefault();
        this._decide('replan');
      }
    });
  }

  show(payload) {
    this._show(payload);
  }

  hide() {
    this._hide();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /**
   * @param {{ step, description, riskScore, screenshotBefore }} payload
   */
  _show(payload) {
    const { taskId, step, description, riskScore, screenshotBefore } = payload || {};
    const normalizedStep = {
      ...(step || {}),
      id: String(step?.id ?? step?.stepNumber ?? Date.now()),
    };
    this._step = normalizedStep;
    this._taskId = taskId || step?.taskId || null;
    this._decisionSentStepId = null;
    this._render(normalizedStep, description, riskScore, screenshotBefore);
    this._sectionEl.classList.remove('hidden');
    // Focus the approve button for keyboard users
    setTimeout(() => {
      this._container.querySelector('#btn-approve')?.focus();
    }, 50);
  }

  _hide() {
    this._step = null;
    this._taskId = null;
    this._decisionSentStepId = null;
    this._sectionEl.classList.add('hidden');
    this._container.innerHTML = '';
  }

  /**
   * @param {object} step
   * @param {string} description
   * @param {number} riskScore
   * @param {string} screenshotBefore
   */
  _render(step, description, riskScore, screenshotBefore) {
    const riskColor = this._riskColor(riskScore);
    const riskLabel = ['', 'Safe', 'Low risk', 'Moderate', 'High risk', 'Dangerous'][riskScore] || 'Unknown';
    const actionJson = this._escapeHtml(JSON.stringify(step?.action || {}, null, 2));
    const safeDescription = description || 'Review the next browser action.';

    this._container.innerHTML = `
      <div class="approval-card" role="dialog" aria-modal="true" aria-label="Step approval">
        <!-- Header -->
        <div class="approval-header">
          <div class="risk-badge" style="background: ${riskColor}">
            <span class="risk-icon">${this._riskIcon(riskScore)}</span>
            <span class="risk-text">${riskLabel}</span>
          </div>
          <span class="approval-title">Action Approval</span>
          <div class="risk-number">Risk ${riskScore}/5</div>
        </div>

        <!-- Description -->
        <div class="approval-description">${this._escapeHtml(safeDescription)}</div>

        <details class="approval-technical">
          <summary>Technical details</summary>
          <div class="payload-editor">
            <textarea class="payload-textarea" rows="4" readonly>${actionJson}</textarea>
          </div>
        </details>

        <!-- Trust toggle -->
        <label class="trust-toggle">
          <input type="checkbox" id="trust-toggle-cb" />
          <span class="trust-toggle-label">Run remaining steps automatically (autopilot for this task)</span>
        </label>

        <!-- Action buttons -->
        <div class="approval-actions">
          <button class="btn btn-approve" id="btn-approve">
            ✓ Approve <kbd>Enter</kbd>
          </button>
          <button class="btn btn-replan" id="btn-replan">
            ↻ Re-plan <kbd>R</kbd>
          </button>
          <button class="btn btn-abort" id="btn-abort">
            ✕ Abort all <kbd>Esc</kbd>
          </button>
        </div>
      </div>
    `;

    // ── Bind button events ──────────────────────────────────────────────────

    this._container.querySelector('#btn-approve').addEventListener('click', () => {
      this._decide('approve');
    });

    this._container.querySelector('#btn-replan').addEventListener('click', () => {
      this._decide('replan');
    });

    this._container.querySelector('#btn-abort').addEventListener('click', () => {
      this._decide('abort');
    });

    // Trust override checkbox
    this._container.querySelector('#trust-toggle-cb').addEventListener('change', (e) => {
      if (e.target.checked) {
        openguider.send('execution:trust-override', {
          taskId: this._taskId || step.taskId || step.id,
          newTrustLevel: 'autopilot',
        });
      }
    });
  }

  // ── Decision helpers ──────────────────────────────────────────────────────

  /**
   * @param {'approve'|'replan'|'abort'} decision
   */
  _decide(decision) {
    if (!this._step) return;
    const stepId = this._step.id;
    if (this._decisionSentStepId === stepId) {
      console.log('[step-approval] decision already sent for step, ignoring duplicate click', { stepId, decision });
      return;
    }
    this._decisionSentStepId = stepId;
    console.log('[step-approval] send execution:step-decision', { stepId, decision });
    openguider.send('execution:step-decision', {
      taskId: this._taskId || undefined,
      stepId,
      decision,
    });
    this._hide();
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  _riskColor(score) {
    return ['', '#22c55e', '#84cc16', '#eab308', '#f97316', '#ef4444'][score] || '#6b7280';
  }

  _riskIcon(score) {
    return ['', '✅', '🟢', '⚠️', '🔶', '🛑'][score] || '❓';
  }

  _escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

if (typeof window !== 'undefined') {
  window.StepApprovalCard = StepApprovalCard;
}

if (typeof module !== 'undefined') {
  module.exports = { StepApprovalCard };
}
