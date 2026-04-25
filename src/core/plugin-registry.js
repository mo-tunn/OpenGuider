/**
 * @file plugin-registry.js
 * Singleton registry that loads, validates, initializes, and shuts down plugins.
 * All plugins must extend OpenGuiderPlugin from plugin-interface.js.
 */

const { OpenGuiderPlugin, NotImplementedError } = require('../plugins/plugin-interface');
const { createLogger } = require('../logger');

const logger = createLogger('plugin-registry');

const SHUTDOWN_TIMEOUT_MS = 3000;

/** @typedef {'uninitialized'|'ok'|'failed'} PluginStatus */

class PluginRegistry {
  constructor() {
    /** @type {Map<string, { plugin: OpenGuiderPlugin, status: PluginStatus }>} */
    this._plugins = new Map();
  }

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Register a plugin. Validates it implements the full interface.
   * @param {OpenGuiderPlugin} plugin
   * @throws {Error} if the plugin is invalid or a duplicate id is registered
   */
  register(plugin) {
    if (!(plugin instanceof OpenGuiderPlugin)) {
      throw new Error('Plugin must be an instance of OpenGuiderPlugin');
    }

    // Validate all required getters
    const requiredGetters = ['id', 'name', 'version', 'capabilities'];
    for (const getter of requiredGetters) {
      try {
        const value = plugin[getter];
        if (value === undefined || value === null) {
          throw new Error(`Plugin getter "${getter}" returned null or undefined`);
        }
      } catch (err) {
        if (err instanceof NotImplementedError) {
          throw new Error(`Plugin must implement getter: ${getter}`);
        }
        throw err;
      }
    }

    // Validate capabilities is a non-empty array of strings
    const caps = plugin.capabilities;
    if (!Array.isArray(caps) || caps.length === 0) {
      throw new Error(`Plugin "${plugin.id}" must declare at least one capability`);
    }
    if (caps.some((c) => typeof c !== 'string')) {
      throw new Error(`Plugin "${plugin.id}" capabilities must all be strings`);
    }

    // Check for duplicate
    if (this._plugins.has(plugin.id)) {
      throw new Error(`Plugin with id "${plugin.id}" is already registered`);
    }

    this._plugins.set(plugin.id, { plugin, status: 'uninitialized' });
    logger.info('plugin-registered', { id: plugin.id, name: plugin.name, version: plugin.version });
  }

  // ── Retrieval ─────────────────────────────────────────────────────────────

  /**
   * @param {string} id
   * @returns {OpenGuiderPlugin}
   * @throws {Error} if not found
   */
  getPlugin(id) {
    const entry = this._plugins.get(id);
    if (!entry) {
      throw new Error(`Plugin not found: "${id}"`);
    }
    return entry.plugin;
  }

  /**
   * @returns {OpenGuiderPlugin[]}
   */
  listPlugins() {
    return Array.from(this._plugins.values()).map((e) => e.plugin);
  }

  /**
   * @param {string} id
   * @returns {PluginStatus|undefined}
   */
  getStatus(id) {
    return this._plugins.get(id)?.status;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Call initialize() on all registered plugins.
   * A single plugin failure is logged but does not block others.
   * @param {object} config
   * @returns {Promise<void>}
   */
  async initializeAll(config) {
    for (const [id, entry] of this._plugins) {
      try {
        logger.info('plugin-initializing', { id });
        await entry.plugin.initialize(config);
        entry.status = 'ok';
        logger.info('plugin-initialized', { id });
      } catch (err) {
        entry.status = 'failed';
        logger.error('plugin-init-failed', { id, error: err?.message });
      }
    }
  }

  /**
   * Call shutdown() on all plugins with a global 3-second timeout.
   * @returns {Promise<void>}
   */
  async shutdownAll() {
    const shutdownPromises = Array.from(this._plugins.entries()).map(([id, entry]) => {
      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => {
          logger.warn('plugin-shutdown-timeout', { id });
          resolve();
        }, SHUTDOWN_TIMEOUT_MS);
      });

      const shutdownPromise = Promise.resolve()
        .then(() => entry.plugin.shutdown())
        .then(() => {
          logger.info('plugin-shutdown-ok', { id });
        })
        .catch((err) => {
          logger.error('plugin-shutdown-error', { id, error: err?.message });
        });

      return Promise.race([shutdownPromise, timeoutPromise]);
    });

    await Promise.all(shutdownPromises);
  }
}

// Singleton instance
const registry = new PluginRegistry();

module.exports = { PluginRegistry, registry };
