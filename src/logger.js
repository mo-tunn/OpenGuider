const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const MAX_LOG_FILE_BYTES = 1_000_000;
const MAX_ROTATED_FILES = 5;
const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let loggerState = {
  logDir: null,
  logFilePath: null,
  level: "info",
  ready: false,
};

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function rotateLogsIfNeeded() {
  try {
    if (!loggerState.logFilePath || !fs.existsSync(loggerState.logFilePath)) {
      return;
    }
    const stat = fs.statSync(loggerState.logFilePath);
    if (stat.size < MAX_LOG_FILE_BYTES) {
      return;
    }

    for (let index = MAX_ROTATED_FILES - 1; index >= 1; index -= 1) {
      const from = `${loggerState.logFilePath}.${index}`;
      const to = `${loggerState.logFilePath}.${index + 1}`;
      if (fs.existsSync(from)) {
        fs.renameSync(from, to);
      }
    }

    fs.renameSync(loggerState.logFilePath, `${loggerState.logFilePath}.1`);
  } catch (_error) {
    // Never crash app because of logger rotation.
  }
}

function writeLine(line) {
  try {
    rotateLogsIfNeeded();
    fs.appendFileSync(loggerState.logFilePath, `${line}\n`, { encoding: "utf8" });
  } catch (_error) {
    // Intentionally swallow to keep logger non-blocking for app stability.
  }
}

function initializeLogger({ app, level = "info" }) {
  const userDataPath = app?.getPath?.("userData");
  if (!userDataPath) {
    return;
  }
  const logDir = path.join(userDataPath, "logs");
  ensureDir(logDir);
  loggerState = {
    logDir,
    logFilePath: path.join(logDir, "app.log"),
    level: LEVELS[level] ? level : "info",
    ready: true,
  };
}

function isEnabled(level) {
  return LEVELS[level] >= LEVELS[loggerState.level];
}

function serializeError(error) {
  if (!error) {
    return null;
  }
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

function sanitizeMeta(meta = {}) {
  const sanitized = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value instanceof Error) {
      sanitized[key] = serializeError(value);
      continue;
    }
    if (typeof value === "function") {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function createLogger(scope, baseMeta = {}) {
  function log(level, message, meta = {}) {
    if (!isEnabled(level)) {
      return;
    }

    const payload = {
      ts: new Date().toISOString(),
      level,
      scope,
      message,
      ...sanitizeMeta(baseMeta),
      ...sanitizeMeta(meta),
    };

    const line = JSON.stringify(payload);
    if (loggerState.ready) {
      writeLine(line);
    }

    const consoleMethod = level === "error" ? "error" : level === "warn" ? "warn" : "log";
    console[consoleMethod](`[${scope}]`, message, meta);
  }

  return {
    debug: (message, meta) => log("debug", message, meta),
    info: (message, meta) => log("info", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta),
    child: (meta = {}) => createLogger(scope, { ...baseMeta, ...meta }),
  };
}

function createRequestContext(operation, baseMeta = {}) {
  return {
    requestId: randomUUID(),
    operation,
    startedAt: Date.now(),
    ...baseMeta,
  };
}

module.exports = {
  createLogger,
  createRequestContext,
  initializeLogger,
};
