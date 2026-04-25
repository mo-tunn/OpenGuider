/**
 * @file intent-router.js
 * Lightweight router that decides whether a task should be delegated to a plugin
 * and prepares a clean goal string for plugin-owned execution.
 */

const { z } = require('zod');
const { invokeStructuredResponse } = require('../ai/structured');
const { extractJSONObject } = require('../agent/schemas');
const { createLogger } = require('../logger');

const logger = createLogger('intent-router');

const RouteSchema = z.object({
  plugin: z.enum(['browser', 'cli', 'desktop']).nullable(),
  goal: z.string().min(1),
  trust: z.enum(['autopilot', 'supervised']),
});

function looksLikeBrowserTask(userMessage = '') {
  const text = String(userMessage || '').trim().toLowerCase();
  if (!text) return false;

  return /\b(open|navigate|visit|website|web site|browser|tab|page|url|link|click|search|find on|type into|fill|submit|amazon|google|youtube|login|sign in|checkout|cart|product|results?)\b/.test(text);
}

function isImageInputUnsupportedError(error) {
  const message = error?.message || String(error || '');
  return /image input|vision|multimodal|does not support image|no endpoints found that support image input/i.test(message);
}

function buildRoutePrompt({ userMessage, availablePluginIds, includeScreenshot }) {
  return [
    includeScreenshot
      ? 'Given this user request and screenshot, decide:'
      : 'Given this user request, decide:',
    '1) Which tool is needed: browser (web tasks), cli (terminal/file tasks), desktop (native app tasks), or none (just answer/guide).',
    '2) Restate the goal clearly in one sentence for the tool.',
    '3) Suggest trust level: autopilot (clear, low-risk task) or supervised (ambiguous, high-risk, or personal/sensitive data).',
    '',
    `User request: ${userMessage}`,
    `Available plugins: ${Array.from(availablePluginIds).join(', ') || 'none'}`,
    includeScreenshot ? 'Screenshot is attached if it helps disambiguate the current UI state.' : 'No screenshot is attached.',
    '',
    'Respond ONLY as JSON:',
    '{ "plugin": "browser"|"cli"|"desktop"|null, "goal": "...", "trust": "autopilot"|"supervised" }',
  ].join('\n');
}

class IntentRouter {
  /**
   * @param {string} userMessage
   * @param {string} screenshotBase64
   * @param {import('../plugins/plugin-interface').OpenGuiderPlugin[]} availablePlugins
   * @param {object} settings
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ pluginId: string|null, goal: string, suggestedTrustLevel: 'balanced'|'autopilot', trust: 'supervised'|'autopilot' }>}
   */
  async route(userMessage, screenshotBase64, availablePlugins = [], settings, signal) {
    const quickText = String(userMessage || '').trim().toLowerCase();
    const looksLikeGeneralQnA = /^(what|who|when|where|why|how)\b/.test(quickText)
      && !/(open|navigate|website|browser|click|search|amazon|google|checkout|buy|login|sign in)/.test(quickText);
    if (looksLikeGeneralQnA) {
      return {
        pluginId: null,
        goal: userMessage,
        suggestedTrustLevel: 'balanced',
        trust: 'supervised',
      };
    }

    const availablePluginIds = new Set(
      (availablePlugins || [])
        .map((plugin) => plugin?.id)
        .filter((id) => typeof id === 'string' && id.length > 0),
    );

    let parsed;
    try {
      const shouldSkipScreenshot = availablePluginIds.has('browser') && looksLikeBrowserTask(userMessage);
      const includeScreenshot = Boolean(screenshotBase64) && !shouldSkipScreenshot;
      const prompt = buildRoutePrompt({ userMessage, availablePluginIds, includeScreenshot });
      const images = includeScreenshot
        ? [{ base64Jpeg: screenshotBase64 }]
        : [];

      let raw;
      try {
        raw = await invokeStructuredResponse({
          text: prompt,
          images,
          history: [],
          settings,
          signal,
          operationName: 'intent_router',
        });
      } catch (err) {
        if (!includeScreenshot || !isImageInputUnsupportedError(err)) {
          throw err;
        }

        logger.info('route-retry-without-image', {
          reason: 'provider_does_not_support_image_input',
        });
        raw = await invokeStructuredResponse({
          text: buildRoutePrompt({ userMessage, availablePluginIds, includeScreenshot: false }),
          images: [],
          history: [],
          settings,
          signal,
          operationName: 'intent_router_text_only_retry',
        });
      }

      parsed = RouteSchema.parse(extractJSONObject(raw));
    } catch (err) {
      logger.warn('route-parse-fallback', { error: err?.message });
      // Safe fallback: no plugin delegation if routing is uncertain.
      return {
        pluginId: null,
        goal: userMessage,
        suggestedTrustLevel: 'balanced',
        trust: 'supervised',
      };
    }

    const pluginId = parsed.plugin && availablePluginIds.has(parsed.plugin)
      ? parsed.plugin
      : null;

    if (parsed.plugin && !pluginId) {
      logger.warn('route-plugin-unavailable', { requested: parsed.plugin });
    }

    const suggestedTrustLevel = parsed.trust === 'autopilot'
      ? 'autopilot'
      : 'balanced';

    logger.info('routed', {
      pluginId,
      trust: parsed.trust,
      goalPreview: parsed.goal.slice(0, 120),
    });

    return {
      pluginId,
      goal: parsed.goal.trim(),
      suggestedTrustLevel,
      trust: parsed.trust,
    };
  }
}

module.exports = { IntentRouter };
