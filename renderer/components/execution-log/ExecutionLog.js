/**
 * ExecutionLog.js
 * Scrollable log panel showing all completed steps with timestamps,
 * outcome badges, and expandable screenshot previews.
 *
 * Usage: new ExecutionLog(containerEl)
 */

/* global openguider */

class ExecutionLog {
  /**
   * @param {HTMLElement} container
   */
  constructor(container) {
    this._container = container;
    /** @type {Array<{id, status, description, actionType?, riskScore, timestamp, screenshot, error, message}>} */
    this._entries = [];
    this._render();
    this._bindIpc();
  }

  // ── IPC ───────────────────────────────────────────────────────────────────

  _bindIpc() {
    openguider.on('execution:substep-progress', (payload) => {
      const event = payload?.event || 'substep_start';
      const id = String(payload?.stepNumber || payload?.stepId || Date.now());
      const existing = this._entries.find((entry) => entry.id === id);
      if (event === 'substep_start') {
        this._upsert({
          id,
          status: 'pending',
          description: payload?.description || payload?.actionType || 'browser action',
          actionType: payload?.actionType || 'action',
          riskScore: payload?.riskScore || 3,
          timestamp: Date.now(),
          screenshot: payload?.screenshotBefore || '',
          message: '',
          error: null,
        });
        return;
      }

      if (event === 'substep_end') {
        this._upsert({
          id,
          status: payload?.success === false ? 'failed' : 'success',
          description: existing?.description || payload?.description || payload?.actionType || 'browser action',
          actionType: existing?.actionType || payload?.actionType || 'action',
          riskScore: existing?.riskScore || payload?.riskScore || 3,
          timestamp: existing?.timestamp || payload?.timestamp || Date.now(),
          screenshot: payload?.screenshotAfter || payload?.screenshot || '',
          message: payload?.message || '',
          error: payload?.error || null,
        });
      }
    });

    // New step is pending — add a spinner entry
    openguider.on('execution:step-pending', (payload) => {
      const { step, description, riskScore } = payload;
      this._upsert({
        id:          step.id,
        status:      'pending',
        description: description || step.type,
        riskScore:   riskScore || 3,
        timestamp:   Date.now(),
        screenshot:  '',
        message:     '',
        error:       null,
      });
    });

    // Step completed — update entry
    openguider.on('execution:step-complete', (result) => {
      const { stepId, success, screenshot, message, error } = result;
      this._upsert({
        id:          stepId,
        status:      success ? 'success' : 'failed',
        screenshot,
        message:     message || '',
        error:       error || null,
      });
    });

    // Aborted — mark any pending entries as aborted
    openguider.on('execution:aborted', () => {
      for (const entry of this._entries) {
        if (entry.status === 'pending') {
          entry.status = 'aborted';
        }
      }
      this._render();
    });
  }

  // ── State ─────────────────────────────────────────────────────────────────

  /**
   * Insert a new entry or update an existing one by id.
   * @param {object} data
   */
  _upsert(data) {
    const idx = this._entries.findIndex((e) => e.id === data.id);
    if (idx >= 0) {
      this._entries[idx] = { ...this._entries[idx], ...data };
    } else {
      this._entries.push({ ...data });
    }
    this._render();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  _render() {
    const wasAtBottom = this._isAtBottom();

    this._container.innerHTML = `
      <div class="log-header">
        <span class="log-title">Execution Log</span>
        <span class="log-count">${this._entries.length} step${this._entries.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="log-list" id="log-list">
        ${this._entries.length === 0
          ? '<div class="log-empty">No steps executed yet.</div>'
          : this._entries.map((e, i) => this._renderEntry(e, i)).join('')
        }
      </div>
    `;

    // Bind expand toggles
    this._container.querySelectorAll('.log-row').forEach((row) => {
      row.addEventListener('click', () => {
        row.classList.toggle('expanded');
      });
    });

    if (wasAtBottom) this._scrollToBottom();
  }

  /**
   * @param {object} entry
   * @param {number} index
   * @returns {string}
   */
  _renderEntry(entry, index) {
    const time       = this._formatTime(entry.timestamp);
    const statusIcon = this._statusIcon(entry.status);
    const statusCls  = `status-${entry.status}`;
    const riskColor  = this._riskColor(entry.riskScore);
    const baseDesc   = entry.actionType
      ? `[${entry.actionType}] ${entry.description || ''}`
      : (entry.description || '');
    const shortDesc  = baseDesc.slice(0, 80) + (baseDesc.length > 80 ? '…' : '');

    const expandedContent = entry.screenshot
      ? `<img class="log-screenshot" src="data:image/png;base64,${entry.screenshot}" alt="Step screenshot" />`
      : '';

    const errorContent = entry.error
      ? `<div class="log-error">${this._escapeHtml(entry.error)}</div>`
      : '';

    const messageContent = entry.message && entry.message !== entry.description
      ? `<div class="log-message">${this._escapeHtml(entry.message)}</div>`
      : '';

    return `
      <div class="log-row ${statusCls}" data-index="${index}">
        <div class="log-row-main">
          <span class="log-index">${String(index + 1).padStart(2, '0')}</span>
          <span class="log-time">${time}</span>
          <span class="log-desc">${this._escapeHtml(shortDesc)}</span>
          <span class="log-risk-dot" style="background:${riskColor}" title="Risk ${entry.riskScore}/5"></span>
          <span class="log-status-icon ${statusCls}">${statusIcon}</span>
        </div>
        <div class="log-row-expanded">
          ${expandedContent}
          ${messageContent}
          ${errorContent}
        </div>
      </div>
    `;
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  _isAtBottom() {
    const list = this._container.querySelector('#log-list');
    if (!list) return true;
    return list.scrollTop + list.clientHeight >= list.scrollHeight - 12;
  }

  _scrollToBottom() {
    const list = this._container.querySelector('#log-list');
    if (list) list.scrollTop = list.scrollHeight;
  }

  _formatTime(ts) {
    if (!ts) return '--:--:--';
    const d = new Date(ts);
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, '0'))
      .join(':');
  }

  _statusIcon(status) {
    const map = {
      pending: '<span class="spinner"></span>',
      success: '✓',
      failed:  '✕',
      aborted: '–',
    };
    return map[status] || '?';
  }

  _riskColor(score) {
    return ['', '#22c55e', '#84cc16', '#eab308', '#f97316', '#ef4444'][score] || '#6b7280';
  }

  _escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

if (typeof module !== 'undefined') {
  module.exports = { ExecutionLog };
}
