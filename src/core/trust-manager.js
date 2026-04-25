/**
 * @file trust-manager.js
 * Encodes the three trust presets and provides the shouldAutoApprove()
 * decision function used by ExecutionEngine before every step.
 *
 * Completely synchronous and side-effect-free — safe to unit test in isolation.
 */

const { createLogger } = require('../logger');

const logger = createLogger('trust-manager');

// ── Trust presets ─────────────────────────────────────────────────────────────

/**
 * @typedef {'paranoid'|'balanced'|'autopilot'} TrustLevel
 */

/**
 * @typedef {object} TrustPreset
 * @property {TrustLevel} id
 * @property {number}     autoApproveBelow - auto-approve steps with riskScore <= this value
 * @property {string}     label            - display name for Settings UI
 * @property {string}     description      - one-sentence description for Settings UI
 */

/** @type {Object.<TrustLevel, TrustPreset>} */
const TRUST_PRESETS = Object.freeze({
  paranoid: Object.freeze({
    id: 'paranoid',
    autoApproveBelow: 0,
    label: "Don't Trust",
    description: 'Every browser step waits for your approval before it runs.',
  }),
  balanced: Object.freeze({
    id: 'balanced',
    autoApproveBelow: 2,
    label: 'Balanced',
    description: 'Low-risk steps continue automatically; risky steps pause for your approval.',
  }),
  autopilot: Object.freeze({
    id: 'autopilot',
    autoApproveBelow: 5,
    label: 'Automatic',
    description: 'Runs with full trust so browser execution stays automatic unless a plugin forces review.',
  }),
});

/** @type {TrustLevel[]} */
const TRUST_LEVEL_IDS = Object.freeze(['paranoid', 'balanced', 'autopilot']);

// ── Decision function ─────────────────────────────────────────────────────────

/**
 * Decide whether a step should be automatically approved without user interaction.
 *
 * @param {import('../plugins/plugin-interface').Step} step
 * @param {TrustLevel} trustLevel
 * @param {import('../plugins/plugin-interface').OpenGuiderPlugin} plugin
 * @returns {boolean} true → auto-approve, false → show approval card
 */
function shouldAutoApprove(step, trustLevel, plugin) {
  const preset = TRUST_PRESETS[trustLevel] || TRUST_PRESETS.balanced;

  // paranoid never auto-approves (autoApproveBelow === 0, riskScore >= 1 always)
  if (preset.autoApproveBelow === 0) {
    return false;
  }

  let riskScore;
  try {
    riskScore = plugin.getRiskScore(step);
  } catch (err) {
    // Fail safe: if we can't determine risk, force user approval
    logger.warn('risk-score-error', {
      stepId: step?.id,
      error: err?.message,
    });
    return false;
  }

  if (typeof riskScore !== 'number' || !Number.isFinite(riskScore)) {
    logger.warn('risk-score-invalid', { stepId: step?.id, riskScore });
    return false;
  }

  return riskScore <= preset.autoApproveBelow;
}

module.exports = { TRUST_PRESETS, TRUST_LEVEL_IDS, shouldAutoApprove };
