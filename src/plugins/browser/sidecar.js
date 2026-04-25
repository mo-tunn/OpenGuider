/**
 * @file sidecar.js
 * Spawns and manages the Python agent_server.py child process.
 * Handles port selection, readiness polling, crash detection, and graceful shutdown.
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const { createLogger } = require('../../logger');

const logger = createLogger('sidecar');

const HEALTH_POLL_MS     = 300;   // initial poll interval
const HEALTH_MAX_WAIT_MS = 15000; // maximum time to wait for /health
const SHUTDOWN_TIMEOUT_MS = 3000;

class SidecarStartupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SidecarStartupError';
  }
}

class Sidecar extends EventEmitter {
  constructor() {
    super();
    this._proc    = null;
    this._port    = null;
    this._callbackPort = null;
    this._running = false;
  }

  get isRunning()    { return this._running; }
  get port()         { return this._port; }
  get callbackPort() { return this._callbackPort; }

  // ── Start ─────────────────────────────────────────────────────────────────

  /**
   * Start the Python sidecar on a random available port.
   * @param {object} envOverrides - extra environment variables
   * @returns {Promise<{ port: number, callbackPort: number }>}
   */
  async start(envOverrides = {}) {
    if (this._running) {
      return { port: this._port, callbackPort: this._callbackPort };
    }

    const { port, callbackPort } = await this._findPorts();
    this._port         = port;
    this._callbackPort = callbackPort;

    const pythonBin  = this._resolvePythonBin();
    const scriptPath = path.join(__dirname, 'python', 'agent_server.py');

    logger.info('sidecar-starting', { pythonBin, port, callbackPort });

    this._proc = spawn(pythonBin, [scriptPath], {
      env: {
        ...process.env,
        PORT:          String(port),
        CALLBACK_PORT: String(callbackPort),
        ...envOverrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Pipe output to logger
    this._proc.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        if (
          trimmed.includes('[hitl-hooks]') ||
          trimmed.includes('Starting agent_server') ||
          trimmed.includes('Building LLM:')
        ) {
          logger.info(`[python] ${trimmed}`);
          continue;
        }
        logger.debug(`[python] ${trimmed}`);
      }
    });
    this._proc.stderr.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        logger.warn(`[python:stderr] ${line}`);
      }
    });

    this._proc.on('exit', (code, signal) => {
      this._running = false;
      if (code !== 0 && code !== null) {
        logger.error('sidecar-crashed', { code, signal });
        this.emit('crashed', new Error(`Sidecar exited with code ${code}`));
      } else {
        logger.info('sidecar-exited', { code, signal });
        this.emit('stopped');
      }
    });

    this._proc.on('error', (err) => {
      this._running = false;
      logger.error('sidecar-spawn-error', { error: err.message });
      this.emit('crashed', err);
    });

    // Wait for /health
    await this._waitUntilReady(port);
    this._running = true;
    this.emit('running', { port, callbackPort });
    logger.info('sidecar-ready', { port, callbackPort });
    return { port, callbackPort };
  }

  // ── Shutdown ──────────────────────────────────────────────────────────────

  /**
   * Gracefully shut down the sidecar.
   * Sends POST /abort, then SIGTERM, then SIGKILL after SHUTDOWN_TIMEOUT_MS.
   * @returns {Promise<void>}
   */
  async shutdown() {
    if (!this._proc) {
      this._running = false;
      return;
    }

    // Ask agent to stop cleanly
    if (this._port) {
      try {
        await fetch(`http://127.0.0.1:${this._port}/abort`, {
          method: 'POST',
          signal: AbortSignal.timeout(2000),
        });
      } catch (_) {
        // ignore — process may already be dead
      }
    }

    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this._running = false;
        this._proc = null;
        resolve();
      };

      this._proc.on('exit', done);

      // Terminate
      try {
        this._proc.kill('SIGTERM');
      } catch (_) {
        // On Windows SIGTERM is not supported; .kill() without args sends the default signal
        try { this._proc.kill(); } catch (__) { /* ignore */ }
      }

      // Force-kill if still alive
      setTimeout(() => {
        if (settled) return;
        logger.warn('sidecar-force-kill');
        try { this._proc.kill('SIGKILL'); } catch (_) {
          try { this._proc.kill(); } catch (__) { /* ignore */ }
        }
        done();
      }, SHUTDOWN_TIMEOUT_MS);
    });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Resolve which Python binary to use.
   * In production (app.isPackaged): use bundled runtime IF it exists.
   * In dev: prefer PYTHON_BIN env var, then 'python3', then 'python'.
   * @returns {string}
   */
  _resolvePythonBin() {
    // Lazy-require to avoid importing Electron in tests
    let isPackaged = false;
    try {
      const { app } = require('electron');
      isPackaged = app.isPackaged;
      if (isPackaged) {
        // Bundled runtime (post-install download puts it here)
        const bundledPy = path.join(
          process.resourcesPath,
          'python-runtime',
          process.platform === 'win32' ? 'python.exe' : 'python'
        );
        const fs = require('fs');
        if (fs.existsSync(bundledPy)) {
          return bundledPy;
        }
        // Fall through to system python if bundled doesn't exist yet
      }
    } catch (_) {
      // Electron not available in test env
    }

    return process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  }

  /**
   * Find two free ports: one for the main server, one for the HITL callback.
   * Uses a simple approach: bind a TCP socket, record the port, then close.
   * @returns {Promise<{ port: number, callbackPort: number }>}
   */
  async _findPorts() {
    const net = require('net');
    const getFreePort = () => new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address();
        srv.close(() => resolve(port));
      });
      srv.on('error', reject);
    });

    const port         = await getFreePort();
    const callbackPort = await getFreePort();
    return { port, callbackPort };
  }

  /**
   * Poll GET /health with exponential back-off until ready or timeout.
   * @param {number} port
   * @returns {Promise<void>}
   */
  async _waitUntilReady(port) {
    const url      = `http://127.0.0.1:${port}/health`;
    const deadline = Date.now() + HEALTH_MAX_WAIT_MS;
    let   delay    = HEALTH_POLL_MS;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return; // ready!
      } catch (_) {
        // not ready yet
      }

      if (!this._proc || this._proc.exitCode !== null) {
        throw new SidecarStartupError('Python sidecar process exited before becoming ready');
      }

      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 2000); // exponential back-off, cap at 2s
    }

    throw new SidecarStartupError(`Sidecar did not become ready within ${HEALTH_MAX_WAIT_MS}ms`);
  }
}

module.exports = { Sidecar, SidecarStartupError };
