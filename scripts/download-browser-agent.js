#!/usr/bin/env node
/**
 * download-browser-agent.js
 * Post-install script that downloads and sets up the Python runtime
 * for the browser agent into the app's userData directory.
 *
 * This runs on demand (from Settings UI) — NOT bundled into the installer.
 * Usage: node scripts/download-browser-agent.js [--target <dir>]
 *
 * On completion emits JSON progress events on stdout for the Electron IPC bridge:
 *   { event: 'progress', step: string, percent: number }
 *   { event: 'done', path: string }
 *   { event: 'error', message: string }
 */

'use strict';

const https     = require('https');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const { execSync, spawn } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────
const PYTHON_VERSION = '3.11.9';
const PYTHON_STANDALONE_BASE =
  'https://github.com/indygreg/python-build-standalone/releases/download/20240415';

const PLATFORM_DOWNLOADS = {
  win32: {
    url: `${PYTHON_STANDALONE_BASE}/cpython-${PYTHON_VERSION}+20240415-x86_64-pc-windows-msvc-install_only.tar.gz`,
    pythonExe: path.join('python', 'python.exe'),
  },
  darwin: {
    url: `${PYTHON_STANDALONE_BASE}/cpython-${PYTHON_VERSION}+20240415-aarch64-apple-darwin-install_only.tar.gz`,
    pythonExe: path.join('python', 'bin', 'python3'),
    // Also try x86_64 as fallback for Intel Macs
    urlFallback: `${PYTHON_STANDALONE_BASE}/cpython-${PYTHON_VERSION}+20240415-x86_64-apple-darwin-install_only.tar.gz`,
  },
  linux: {
    url: `${PYTHON_STANDALONE_BASE}/cpython-${PYTHON_VERSION}+20240415-x86_64-unknown-linux-gnu-install_only.tar.gz`,
    pythonExe: path.join('python', 'bin', 'python3'),
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function emit(event, data) {
  process.stdout.write(JSON.stringify({ event, ...data }) + '\n');
}

function progress(step, percent) {
  emit('progress', { step, percent });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const get = (u) => {
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location); // follow redirect
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode} for ${u}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let   recv  = 0;
        res.on('data', (chunk) => {
          recv += chunk.length;
          if (total > 0) {
            const pct = Math.round((recv / total) * 40); // 0-40%
            progress('Downloading Python runtime…', pct);
          }
        });
        res.pipe(file);
        res.on('end',   () => { file.close(); resolve(); });
        res.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });
}

function runCmd(cmd, args, cwd, logLabel) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => process.stderr.write(`[${logLabel}] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[${logLabel}:stderr] ${d}`));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const platform = process.platform;
  const config   = PLATFORM_DOWNLOADS[platform];
  if (!config) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  // Resolve target directory
  const args       = process.argv.slice(2);
  const targetIdx  = args.indexOf('--target');
  const targetDir  = targetIdx >= 0 ? args[targetIdx + 1] : path.join(os.homedir(), '.openguider', 'python-runtime');

  fs.mkdirSync(targetDir, { recursive: true });

  // ── 1. Download Python ──────────────────────────────────────────────────
  progress('Downloading Python runtime…', 0);
  const archivePath = path.join(targetDir, 'python.tar.gz');
  try {
    await downloadFile(config.url, archivePath);
  } catch (err) {
    if (config.urlFallback) {
      progress('Trying fallback runtime URL…', 5);
      await downloadFile(config.urlFallback, archivePath);
    } else {
      throw err;
    }
  }
  progress('Python runtime downloaded', 40);

  // ── 2. Extract ──────────────────────────────────────────────────────────
  progress('Extracting Python runtime…', 42);
  if (platform === 'win32') {
    // tar is available in modern Windows 10+
    execSync(`tar -xzf "${archivePath}" -C "${targetDir}"`, { stdio: 'ignore' });
  } else {
    execSync(`tar -xzf "${archivePath}" -C "${targetDir}"`, { stdio: 'ignore' });
  }
  fs.unlinkSync(archivePath);
  progress('Python runtime extracted', 55);

  // ── 3. Resolve python binary ─────────────────────────────────────────────
  const pythonBin = path.join(targetDir, config.pythonExe);

  if (!fs.existsSync(pythonBin)) {
    throw new Error(`Python binary not found at expected path: ${pythonBin}`);
  }

  if (platform !== 'win32') {
    fs.chmodSync(pythonBin, 0o755);
  }

  // ── 4. Install pip dependencies ──────────────────────────────────────────
  progress('Installing browser-use and dependencies…', 58);
  const requirementsPath = path.join(__dirname, '..', 'src', 'plugins', 'browser', 'python', 'requirements.txt');
  await runCmd(pythonBin, ['-m', 'pip', 'install', '--upgrade', 'pip'], targetDir, 'pip-upgrade');
  await runCmd(
    pythonBin,
    ['-m', 'pip', 'install', '-r', requirementsPath, '--quiet'],
    targetDir,
    'pip-install'
  );
  progress('Dependencies installed', 80);

  // ── 5. Install Playwright Chromium ───────────────────────────────────────
  progress('Installing Chromium browser…', 82);
  const playwrightBrowsersPath = path.join(targetDir, 'playwright-browsers');
  fs.mkdirSync(playwrightBrowsersPath, { recursive: true });

  await runCmd(
    pythonBin,
    ['-m', 'playwright', 'install', 'chromium'],
    targetDir,
    'playwright-install',
  );
  // Note: PLAYWRIGHT_BROWSERS_PATH must be set when running the sidecar so it
  // finds the installed Chromium. sidecar.js injects this env var automatically.
  progress('Chromium installed', 98);

  // ── 6. Write a manifest file ─────────────────────────────────────────────
  const manifest = {
    version:    PYTHON_VERSION,
    platform,
    pythonBin,
    playwrightBrowsersPath,
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  progress('Done', 100);
  emit('done', { path: targetDir, pythonBin });
}

main().catch((err) => {
  emit('error', { message: err.message });
  process.exit(1);
});
