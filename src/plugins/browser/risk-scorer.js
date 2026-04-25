/**
 * @file risk-scorer.js
 * Maps browser action types to risk scores 1–5.
 * Pure function — synchronous, no side effects.
 *
 * Risk scale:
 *   1 = read-only / navigational
 *   2 = benign interaction (click, hover)
 *   3 = data entry
 *   4 = form submission / file transfer
 *   5 = irreversible / financial / destructive
 */

const RISK_MAP = Object.freeze({
  // ── Risk 1: read-only ──────────────────────────────────────────────────────
  navigate:   1,
  screenshot: 1,
  scroll:     1,
  go_back:    1,
  wait:       1,
  extract:    1,
  find_text:  1,
  search:     1,
  switch:     1,   // switch browser tab

  // ── Risk 2: benign interaction ─────────────────────────────────────────────
  click:      2,
  hover:      2,
  focus:      2,
  close:      2,   // close a browser tab (not a form delete)

  // ── Risk 3: data entry ─────────────────────────────────────────────────────
  type:             3,
  input:            3,
  select:           3,
  select_dropdown:  3,
  dropdown_options: 3,
  check:            3,
  send_keys:        3,

  // ── Risk 4: form submission / file transfer ────────────────────────────────
  submit:   4,
  upload:   4,
  download: 4,
  fill_form: 4,
  write_file: 4,
  replace_file: 4,

  // ── Risk 5: irreversible / dangerous ──────────────────────────────────────
  delete:         5,
  logout:         5,
  purchase:       5,
  confirm_dialog: 5,
  evaluate:       5, // arbitrary JS execution

  // ── browser_action: pass-through — scored by content later; default safe ──
  browser_action: 3,
});

/**
 * Return a risk score 1–5 for a Step.
 * For browser_action type, the score is always 3 (moderate) unless the
 * instruction text explicitly contains high-risk keywords.
 *
 * @param {import('../plugin-interface').Step} step
 * @returns {number} 1–5
 */
function getBrowserRiskScore(step) {
  const type = (step?.type || '').toLowerCase().trim();

  if (RISK_MAP[type] !== undefined) {
    // For browser_action, scan the instruction for high-risk keywords
    if (type === 'browser_action') {
      return _scoreFromInstruction(step?.payload?.instruction || '');
    }
    return RISK_MAP[type];
  }

  // Unknown type → default 3 (ask in balanced, auto in autopilot)
  return 3;
}

/**
 * Heuristic scoring for free-form browser_action instructions.
 * @param {string} instruction
 * @returns {number}
 */
function _scoreFromInstruction(instruction) {
  const lower = instruction.toLowerCase();

  const risk5 = ['delete', 'purchase', 'buy', 'pay', 'checkout', 'confirm', 'logout', 'log out', 'unsubscribe', 'cancel subscription'];
  if (risk5.some((kw) => lower.includes(kw))) return 5;

  const risk4 = ['submit', 'send', 'upload', 'download', 'post', 'publish', 'save', 'fill'];
  if (risk4.some((kw) => lower.includes(kw))) return 4;

  const risk2 = ['navigate', 'open', 'go to', 'visit', 'scroll', 'screenshot'];
  if (risk2.some((kw) => lower.includes(kw))) return 2;

  return 3; // default moderate
}

module.exports = { getBrowserRiskScore };
