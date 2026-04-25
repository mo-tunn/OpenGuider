const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  getInstalledRuntimeInfo,
  resolveChildProcessAssetPath,
} = require("../../src/plugins/browser/sidecar");

test("getInstalledRuntimeInfo reads the downloaded runtime manifest", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openguider-runtime-"));
  const runtimeDir = path.join(tempRoot, "python-runtime");
  const pythonDir = path.join(runtimeDir, "python");
  const browsersDir = path.join(runtimeDir, "playwright-browsers");
  fs.mkdirSync(pythonDir, { recursive: true });
  fs.mkdirSync(browsersDir, { recursive: true });

  const pythonBin = path.join(pythonDir, process.platform === "win32" ? "python.exe" : "python3");
  fs.writeFileSync(pythonBin, "");
  fs.writeFileSync(path.join(runtimeDir, "manifest.json"), JSON.stringify({
    pythonBin,
    playwrightBrowsersPath: browsersDir,
  }));

  const previousRuntimeDir = process.env.OPENGUIDER_BROWSER_RUNTIME_DIR;
  process.env.OPENGUIDER_BROWSER_RUNTIME_DIR = runtimeDir;

  try {
    const info = getInstalledRuntimeInfo();
    assert.ok(info);
    assert.equal(info.runtimeDir, runtimeDir);
    assert.equal(info.pythonBin, pythonBin);
    assert.equal(info.playwrightBrowsersPath, browsersDir);
  } finally {
    if (previousRuntimeDir) {
      process.env.OPENGUIDER_BROWSER_RUNTIME_DIR = previousRuntimeDir;
    } else {
      delete process.env.OPENGUIDER_BROWSER_RUNTIME_DIR;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveChildProcessAssetPath switches to app.asar.unpacked when present", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openguider-asar-"));
  const unpackedDir = path.join(tempRoot, "resources", "app.asar.unpacked", "scripts");
  fs.mkdirSync(unpackedDir, { recursive: true });

  const directPath = path.join(tempRoot, "resources", "app.asar", "scripts", "download-browser-agent.js");
  const unpackedPath = path.join(unpackedDir, "download-browser-agent.js");
  fs.writeFileSync(unpackedPath, "console.log('ok');");

  try {
    assert.equal(resolveChildProcessAssetPath(directPath), unpackedPath);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
