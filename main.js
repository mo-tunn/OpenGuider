// main.js — Electron main process
// Handles: system tray, windows lifecycle, global hotkeys, IPC, AI streaming,
// screenshot capture, TTS, cursor overlay management.

const { app } = require("electron");
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}
const {
  BrowserWindow, Tray, Menu, ipcMain, screen,
  nativeImage, globalShortcut, shell, safeStorage, systemPreferences,
} = require("electron");
const path   = require("path");
const fs = require("fs");
const { createStore }     = require("./src/store");
const { SecureStore, SECRET_KEYS } = require("./src/secure-store");
const { captureAllScreens } = require("./src/screenshot");
const { streamAIResponse, parsePointTag, fetchOllamaModels } = require("./src/ai/index");
const { SessionManager } = require("./src/session/session-manager");
const {
  clearSessionSnapshot,
  loadSessionSnapshot,
  saveSessionSnapshot,
} = require("./src/session/session-persistence");
const { TaskOrchestrator } = require("./src/agent/task-orchestrator");
const { emitPointerTool } = require("./src/agent/tools/pointer-tool");
const { formatStructuredUserError } = require("./src/ai/structured");
const { createLogger, createRequestContext, initializeLogger } = require("./src/logger");
const { PerformanceMetrics } = require("./src/performance-metrics");
const {
  getPlatformCapabilities,
  normalizeSettingsForPlatform,
  resolveEffectiveTtsProvider,
} = require("./src/platform-capabilities");

// ── Constants ─────────────────────────────────────────────────────────────────
const PANEL_WIDTH  = 440;
const PANEL_HEIGHT = 660;
const WIDGET_WIDTH = 220;
const WIDGET_COLLAPSED_HEIGHT = 58;
const WIDGET_EXPANDED_HEIGHT = 248;
const FAST_MODE_PROMPT = [
  "FAST MODE:",
  "Do NOT create long plans.",
  "Give only the next best action in maximum two short sentences.",
  "Always append a [POINT:x,y:label] tag when a clickable target is likely on screen.",
  "If uncertain, still provide your best click estimate with a concise label.",
].join(" ");

// ── Global state ──────────────────────────────────────────────────────────────
let tray                 = null;
let panelWindow          = null;
let settingsWindow       = null;
let cursorOverlayWindow  = null;
let widgetWindow         = null;
let store                = null;
let secureStore          = null;
let appLogger            = createLogger("main");
let isPanelVisible       = false;
let currentAIController  = null; // AbortController for in-flight AI requests
let assemblySocket       = null; // AssemblyAI WebSocket
let sessionManager       = null;
let taskOrchestrator     = null;
let perfMetrics          = new PerformanceMetrics();
let pointerCalibration   = {
  byScreenNumber: {},
  byDisplayId: {},
  updatedAt: null,
};
let isPushToTalkRecording = false;
let isPlanShortcutInFlight = false;
let panelOpenAnimationTimer = null;
let lastPanelShowRequestAt = 0;
let lastPushToTalkToggleAt = 0;

function getVirtualDisplayBounds() {
  const displays = screen.getAllDisplays();
  const left = Math.min(...displays.map((display) => display.bounds.x));
  const top = Math.min(...displays.map((display) => display.bounds.y));
  const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
  const bottom = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height));
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function resizeCursorOverlayToVirtualBounds() {
  if (!cursorOverlayWindow || cursorOverlayWindow.isDestroyed()) {
    return;
  }
  cursorOverlayWindow.setBounds(getVirtualDisplayBounds());
}

function debugLog(...args) {
  const [message, ...rest] = args;
  appLogger.debug(String(message || ""), { data: rest });
}

function recordPerformanceMetric(name, startedAt, { ok = true, meta = {} } = {}) {
  const durationMs = Date.now() - startedAt;
  perfMetrics.recordDuration(name, durationMs, { ok, meta });
}

function buildPointerCalibration(screenshots = []) {
  const displays = screen.getAllDisplays();
  const byScreenNumber = {};
  const byDisplayId = {};

  (screenshots || []).forEach((shot, index) => {
    const requestedDisplayId = String(shot?.displayId || "").trim();
    let matchedDisplay = null;
    if (requestedDisplayId) {
      matchedDisplay = displays.find((display) => String(display.id) === requestedDisplayId) || null;
    }
    if (!matchedDisplay && Number(shot?.screenNumber) > 0) {
      matchedDisplay = displays[Number(shot.screenNumber) - 1] || null;
    }
    if (!matchedDisplay) {
      matchedDisplay = displays[index] || displays[0] || null;
    }
    if (!matchedDisplay) {
      return;
    }

    const sourceWidth = Math.max(1, Number(shot?.width) || matchedDisplay.bounds.width);
    const sourceHeight = Math.max(1, Number(shot?.height) || matchedDisplay.bounds.height);
    const calibration = {
      sourceWidth,
      sourceHeight,
      scaleX: matchedDisplay.bounds.width / sourceWidth,
      scaleY: matchedDisplay.bounds.height / sourceHeight,
      displayId: String(matchedDisplay.id),
      screenNumber: Number(shot?.screenNumber) || index + 1,
    };
    byScreenNumber[calibration.screenNumber] = calibration;
    byDisplayId[calibration.displayId] = calibration;
  });

  return {
    byScreenNumber,
    byDisplayId,
    updatedAt: new Date().toISOString(),
  };
}

function updatePointerCalibration(screenshots = []) {
  pointerCalibration = buildPointerCalibration(screenshots);
}

function wrapUserFacingError(error) {
  return new Error(formatStructuredUserError(error));
}

function classifyErrorForUI(error) {
  const message = String(error?.message || "");
  if (/api key|authentication|unauthorized|forbidden|401|403/i.test(message)) {
    return {
      code: "auth_error",
      action: "open-settings",
      actionLabel: "Open settings",
    };
  }
  if (/rate limit|429|quota/i.test(message)) {
    return {
      code: "rate_limit",
      action: "retry",
      actionLabel: "Try again",
    };
  }
  if (/credits|402|insufficient/i.test(message)) {
    return {
      code: "credits",
      action: "open-settings",
      actionLabel: "Open settings",
    };
  }
  return {
    code: "unknown_error",
    action: "open-settings",
    actionLabel: "Open settings",
  };
}

function toUiErrorPayload(error, requestContext) {
  const base = classifyErrorForUI(error);
  return {
    ...base,
    message: error?.message || "Unexpected error",
    requestId: requestContext?.requestId || null,
  };
}

function applyPlatformSettingsGuards(settings) {
  const capabilities = getPlatformCapabilities(process.platform);
  const normalized = normalizeSettingsForPlatform(settings, capabilities);
  return {
    capabilities,
    normalizedSettings: normalized.settings,
    warnings: normalized.warnings,
  };
}

async function getRuntimeSettings() {
  if (!secureStore) {
    return applyPlatformSettingsGuards(store?.store || {}).normalizedSettings;
  }
  const hydrated = await secureStore.fillSecrets(store.store);
  return applyPlatformSettingsGuards(hydrated).normalizedSettings;
}

function attachWindowCrashHandlers(windowRef, name) {
  if (!windowRef || windowRef.isDestroyed()) {
    return;
  }
  windowRef.webContents.on("render-process-gone", (_event, details) => {
    appLogger.error("renderer-process-gone", {
      window: name,
      reason: details?.reason,
      exitCode: details?.exitCode,
    });
  });
  windowRef.webContents.on("unresponsive", () => {
    appLogger.warn("renderer-unresponsive", { window: name });
  });
}

function registerCrashTracking() {
  process.on("uncaughtException", (error) => {
    appLogger.error("uncaught-exception", { error });
  });
  process.on("unhandledRejection", (reason) => {
    appLogger.error("unhandled-rejection", {
      error: reason instanceof Error ? reason : new Error(String(reason)),
    });
  });
}

// ── Tray icon (programmatic 32x32 purple circle) ──────────────────────────────
function buildTrayIcon() {
  const logoPath = path.join(__dirname, "renderer", "assets", "logo.png");
  if (fs.existsSync(logoPath)) {
    const logoIcon = nativeImage.createFromPath(logoPath);
    if (!logoIcon.isEmpty()) {
      return logoIcon;
    }
  }

  const size = 32;
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - size / 2;
      const dy = y - size / 2;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= size / 2 - 2) {
        data[idx] = 124;
        data[idx + 1] = 58;
        data[idx + 2] = 237;
        data[idx + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBuffer(data, { width: size, height: size });
}

// ── Panel window ──────────────────────────────────────────────────────────────
function createPanelWindow() {
  panelWindow = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  panelWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  attachWindowCrashHandlers(panelWindow, "panel");

}

// ── Settings window ───────────────────────────────────────────────────────────
function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 600,
    height: 700,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: false,
    alwaysOnTop: false,
    parent: panelWindow,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, "renderer", "settings.html"));
  attachWindowCrashHandlers(settingsWindow, "settings");
  settingsWindow.on("closed", () => { settingsWindow = null; });
}

// ── Cursor overlay ────────────────────────────────────────────────────────────
function createCursorOverlay() {
  const virtualBounds = getVirtualDisplayBounds();
  cursorOverlayWindow = new BrowserWindow({
    width: virtualBounds.width,
    height: virtualBounds.height,
    x: virtualBounds.x,
    y: virtualBounds.y,
    frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true,
    focusable: false, show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false, contextIsolation: true,
    },
  });
  cursorOverlayWindow.setAlwaysOnTop(true, "screen-saver", 1);
  cursorOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  cursorOverlayWindow.setIgnoreMouseEvents(true, { forward: true });
  cursorOverlayWindow.loadFile(path.join(__dirname, "renderer", "cursor.html"));
  attachWindowCrashHandlers(cursorOverlayWindow, "cursor-overlay");
  screen.on("display-added", resizeCursorOverlayToVirtualBounds);
  screen.on("display-removed", resizeCursorOverlayToVirtualBounds);
  screen.on("display-metrics-changed", resizeCursorOverlayToVirtualBounds);
}

// ── Widget window ─────────────────────────────────────────────────────────────
function createWidgetWindow() {
  if (widgetWindow && !widgetWindow.isDestroyed()) return;

  widgetWindow = new BrowserWindow({
    width: WIDGET_WIDTH,
    height: WIDGET_COLLAPSED_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  widgetWindow.loadFile(path.join(__dirname, "renderer", "widget.html"));
  attachWindowCrashHandlers(widgetWindow, "widget");

  // Position at top right
  const { width, height } = screen.getPrimaryDisplay().workArea;
  widgetWindow.setPosition(width - WIDGET_WIDTH - 20, 20);

  widgetWindow.on("closed", () => { widgetWindow = null; });
}

function positionWidgetBottomRight(nextHeight) {
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    return;
  }

  const { width, height } = screen.getPrimaryDisplay().workArea;
  const x = width - WIDGET_WIDTH - 20;
  const y = height - nextHeight - 20;
  widgetWindow.setPosition(x, y);
}

function resizeWidgetPreservingPosition(nextHeight) {
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    return;
  }

  const [x, y] = widgetWindow.getPosition();
  widgetWindow.setBounds({
    x,
    y,
    width: WIDGET_WIDTH,
    height: nextHeight,
  });
}

function updateWidgetState(state) {
  debugLog("widget:state", state);
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send("state-change", state);
  }
}

function broadcastAgentState(state) {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send("agent-state-changed", state);
  }
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send("agent-state-changed", state);
  }
}

function broadcastSessionSnapshot(snapshot) {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send("session-updated", snapshot);
    panelWindow.webContents.send("plan-updated", snapshot.activePlan);
    panelWindow.webContents.send("agent-state-changed", snapshot.status);
  }

  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send("session-updated", snapshot);
    widgetWindow.webContents.send("plan-updated", snapshot.activePlan);
    widgetWindow.webContents.send("agent-state-changed", snapshot.status);
  }

  const widgetState = mapSessionStatusToWidgetState(snapshot.status);
  updateWidgetState(widgetState);
}

function mapSessionStatusToWidgetState(status) {
  switch (status) {
    case "planning":
    case "executing":
    case "evaluating":
      return "thinking";
    case "waiting_user":
      return "idle";
    default:
      return status || "idle";
  }
}

function hideCursorOverlay() {
  if (cursorOverlayWindow && !cursorOverlayWindow.isDestroyed()) {
    cursorOverlayWindow.hide();
  }

  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send("pointer-updated", null);
  }

  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send("pointer-updated", null);
  }
}

function showPointer(pointer) {
  const payload = emitPointerTool({
    pointer,
    screen,
    cursorOverlayWindow,
    pointerCalibration,
  });

  if (!payload) {
    hideCursorOverlay();
    return null;
  }

  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send("pointer-updated", payload);
  }

  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send("pointer-updated", payload);
  }

  return payload;
}

// ── Panel position (top-right by default, persistent if moved) ───────────────
function getPanelPosition() {
  const workArea = screen.getPrimaryDisplay().workArea;
  const defaultX = workArea.x + workArea.width - PANEL_WIDTH - 20;
  const defaultY = workArea.y + 20;
  const savedX = Number(store?.get("panelWindowX", -1));
  const savedY = Number(store?.get("panelWindowY", -1));
  const x = Number.isFinite(savedX) && savedX >= 0 ? savedX : defaultX;
  const y = Number.isFinite(savedY) && savedY >= 0 ? savedY : defaultY;
  const clampedX = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - PANEL_WIDTH));
  const clampedY = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - PANEL_HEIGHT));
  return { x: clampedX, y: clampedY };
}

function animatePanelIn(targetX, targetY) {
  if (!panelWindow || panelWindow.isDestroyed()) {
    return;
  }

  if (panelOpenAnimationTimer) {
    clearInterval(panelOpenAnimationTimer);
    panelOpenAnimationTimer = null;
  }

  const startY = targetY - 10;
  const steps = 8;
  let step = 0;
  panelWindow.setPosition(targetX, startY);
  panelWindow.setOpacity(0);
  panelWindow.show();

  panelOpenAnimationTimer = setInterval(() => {
    if (!panelWindow || panelWindow.isDestroyed()) {
      clearInterval(panelOpenAnimationTimer);
      panelOpenAnimationTimer = null;
      return;
    }
    step += 1;
    const progress = Math.min(1, step / steps);
    const eased = 1 - (1 - progress) * (1 - progress);
    const nextY = Math.round(startY + (targetY - startY) * eased);
    panelWindow.setPosition(targetX, nextY);
    panelWindow.setOpacity(progress);

    if (progress >= 1) {
      clearInterval(panelOpenAnimationTimer);
      panelOpenAnimationTimer = null;
      panelWindow.setPosition(targetX, targetY);
      panelWindow.setOpacity(1);
    }
  }, 16);
}

function showPanel() {
  debugLog("window:panel show");
  const now = Date.now();
  if (now - lastPanelShowRequestAt < 180) {
    return;
  }
  lastPanelShowRequestAt = now;

  if (!panelWindow || panelWindow.isDestroyed()) {
    return;
  }
  if (isPanelVisible && panelWindow.isVisible()) {
    panelWindow.focus();
    return;
  }

  const { x, y } = getPanelPosition();
  animatePanelIn(x, y);
  panelWindow.focus();
  isPanelVisible = true;
}
function hidePanel() {
  debugLog("window:panel hide");
  if (panelOpenAnimationTimer) {
    clearInterval(panelOpenAnimationTimer);
    panelOpenAnimationTimer = null;
  }
  panelWindow.hide();
  isPanelVisible = false;
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function createTray() {
  tray = new Tray(buildTrayIcon());
  tray.setToolTip("OpenGuider — AI Companion");
  tray.on("click", () => { isPanelVisible ? hidePanel() : showPanel(); });
  tray.on("double-click", showPanel);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open OpenGuider",  click: showPanel },
    { label: "Settings",     click: createSettingsWindow },
    { type: "separator" },
    { label: "Quit",         click: () => app.quit() },
  ]));
}

function getDefaultSender() {
  if (panelWindow && !panelWindow.isDestroyed()) {
    return panelWindow.webContents;
  }
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    return widgetWindow.webContents;
  }
  return null;
}

function canRunPlanShortcutAction() {
  const snapshot = sessionManager?.getSnapshot?.();
  const currentStep = snapshot?.activePlan?.steps?.[snapshot?.activePlan?.currentStepIndex];
  return Boolean(currentStep) && snapshot?.status === "waiting_user";
}

async function runPlanShortcutAction(actionName) {
  if (!canRunPlanShortcutAction()) {
    debugLog("hotkey:plan-action skipped", actionName, "inactive");
    return;
  }

  if (isPlanShortcutInFlight) {
    debugLog("hotkey:plan-action skipped", actionName, "busy");
    return;
  }

  isPlanShortcutInFlight = true;
  const sender = getDefaultSender();
  if (!sender) {
    isPlanShortcutInFlight = false;
    return;
  }

  if (currentAIController) {
    currentAIController.abort();
  }
  currentAIController = new AbortController();

  try {
    let result = null;
    if (actionName === "mark-step-done") {
      result = await taskOrchestrator.markStepDone({
        settings: store.store,
        signal: currentAIController.signal,
      });
    } else if (actionName === "request-step-help") {
      result = await taskOrchestrator.requestStepHelp({
        settings: store.store,
        signal: currentAIController.signal,
      });
    } else if (actionName === "recheck-current-step") {
      result = await taskOrchestrator.recheckCurrentStep({
        settings: store.store,
        signal: currentAIController.signal,
      });
    } else if (actionName === "previous-step") {
      result = await taskOrchestrator.previousStep({
        settings: store.store,
        signal: currentAIController.signal,
      });
    } else if (actionName === "skip-current-step") {
      result = await taskOrchestrator.skipCurrentStep({
        settings: store.store,
        signal: currentAIController.signal,
      });
    } else if (actionName === "regenerate-current-step") {
      result = await taskOrchestrator.regenerateCurrentStep({
        settings: store.store,
        signal: currentAIController.signal,
      });
    } else if (actionName === "cancel-active-plan") {
      result = taskOrchestrator.cancelActivePlan();
    }

    if (result) {
      await handleOrchestratorResult(result, store.store, sender);
    }
  } catch (err) {
    if (err?.name !== "AbortError") {
      debugLog("hotkey:plan-action error", actionName, err?.message || err);
      appLogger.error("global-shortcut-action failed", { actionName, error: err });
    }
  } finally {
    currentAIController = null;
    isPlanShortcutInFlight = false;
  }
}

function registerShortcut(accelerator, onPress, label) {
  const shortcut = (accelerator || "").trim();
  if (!shortcut) {
    debugLog("hotkey:skip empty", label);
    return;
  }
  const ok = globalShortcut.register(shortcut, onPress);
  if (!ok) {
    debugLog("hotkey:register failed", label, shortcut);
    return;
  }
  debugLog("hotkey:registered", label, shortcut);
}

// ── Global hotkey ─────────────────────────────────────────────────────────────
function registerHotkeys() {
  globalShortcut.unregisterAll();
  isPushToTalkRecording = false;

  const pushToTalkShortcut = store.get("pushToTalkShortcut") || "Ctrl+Shift+Space";
  const markStepDoneShortcut = store.get("markStepDoneShortcut") || "Ctrl+Alt+1";
  const requestStepHelpShortcut = store.get("requestStepHelpShortcut") || "Ctrl+Alt+2";
  const recheckCurrentStepShortcut = store.get("recheckCurrentStepShortcut") || "Ctrl+Alt+3";
  const cancelActivePlanShortcut = store.get("cancelActivePlanShortcut") || "Ctrl+Alt+4";
  const previousStepShortcut = store.get("previousStepShortcut") || "Ctrl+Alt+5";
  const skipCurrentStepShortcut = store.get("skipCurrentStepShortcut") || "Ctrl+Alt+6";
  const regenerateCurrentStepShortcut = store.get("regenerateCurrentStepShortcut") || "Ctrl+Alt+7";

  registerShortcut(pushToTalkShortcut, () => {
    const now = Date.now();
    // Prevent accidental double toggles from key repeat.
    if (now - lastPushToTalkToggleAt < 300) {
      return;
    }
    lastPushToTalkToggleAt = now;
    debugLog("hotkey:push-to-talk", pushToTalkShortcut, isPushToTalkRecording ? "stop" : "start");
    if (!panelWindow || panelWindow.isDestroyed()) {
      isPushToTalkRecording = false;
      return;
    }
    if (!isPushToTalkRecording) {
      isPushToTalkRecording = true;
      panelWindow.webContents.send("push-to-talk-start");
      updateWidgetState("listening");
    } else {
      isPushToTalkRecording = false;
      panelWindow.webContents.send("push-to-talk-stop");
      updateWidgetState("idle");
    }
  }, "pushToTalk");

  registerShortcut(markStepDoneShortcut, () => {
    void runPlanShortcutAction("mark-step-done");
  }, "markStepDone");
  registerShortcut(requestStepHelpShortcut, () => {
    void runPlanShortcutAction("request-step-help");
  }, "requestStepHelp");
  registerShortcut(recheckCurrentStepShortcut, () => {
    void runPlanShortcutAction("recheck-current-step");
  }, "recheckCurrentStep");
  registerShortcut(previousStepShortcut, () => {
    void runPlanShortcutAction("previous-step");
  }, "previousStep");
  registerShortcut(skipCurrentStepShortcut, () => {
    void runPlanShortcutAction("skip-current-step");
  }, "skipCurrentStep");
  registerShortcut(regenerateCurrentStepShortcut, () => {
    void runPlanShortcutAction("regenerate-current-step");
  }, "regenerateCurrentStep");
  registerShortcut(cancelActivePlanShortcut, () => {
    void runPlanShortcutAction("cancel-active-plan");
  }, "cancelActivePlan");
}

function resolvePreferredTtsTargetSender(sender) {
  if (panelWindow && !panelWindow.isDestroyed()) {
    return panelWindow.webContents;
  }
  return sender;
}

async function ensureRuntimePermissions() {
  const payload = {
    platform: process.platform,
    microphone: "not_required",
    screen: "not_required",
    screenNeedsSettings: false,
  };

  if (process.platform !== "darwin") {
    return payload;
  }

  const microphoneStatus = systemPreferences.getMediaAccessStatus("microphone");
  if (microphoneStatus === "granted") {
    payload.microphone = "granted";
  } else {
    const granted = await systemPreferences.askForMediaAccess("microphone");
    payload.microphone = granted ? "granted" : "denied";
  }

  const screenStatus = systemPreferences.getMediaAccessStatus("screen");
  payload.screen = screenStatus || "unknown";
  payload.screenNeedsSettings = ["denied", "restricted"].includes(payload.screen);

  return payload;
}

async function openPermissionSettings(scope) {
  if (process.platform !== "darwin") {
    return false;
  }
  const normalizedScope = String(scope || "").trim().toLowerCase();
  if (normalizedScope === "microphone") {
    return shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
  }
  if (normalizedScope === "screen") {
    return shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  }
  return false;
}

function sanitizeTextForTts(input) {
  let text = String(input || "");
  if (!text) {
    return "";
  }

  // Remove code blocks, inline code, markdown emphasis markers and links.
  text = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/[*_~>#]+/g, " ");

  // Remove most emoji / pictographic symbols.
  text = text
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[\uFE0F\u200D]/g, " ");

  // Remove repeated punctuation and clean spacing.
  text = text
    .replace(/[^\p{L}\p{N}\p{P}\p{Z}\n]/gu, " ")
    .replace(/([!?.,])\1+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  return text;
}

async function speakAssistantResponse(text, settings, sender) {
  const safeText = sanitizeTextForTts(text);
  if (!settings.ttsEnabled || !safeText) {
    return;
  }

  const { provider: effectiveTtsProvider, warning } = resolveEffectiveTtsProvider(
    settings.ttsProvider,
    getPlatformCapabilities(process.platform),
  );
  if (warning) {
    appLogger.warn("tts provider fallback", {
      requestedProvider: settings.ttsProvider,
      effectiveProvider: effectiveTtsProvider,
      warning,
    });
  }

  const ttsTargetSender = resolvePreferredTtsTargetSender(sender);
  debugLog("tts:start", effectiveTtsProvider);
  if (effectiveTtsProvider === "elevenlabs") {
    updateWidgetState("speaking");
    await speakWithElevenLabs(safeText, settings, ttsTargetSender);
  } else if (effectiveTtsProvider === "openai") {
    const openaiTTS = require("./src/tts/openai-tts");
    try {
      const base64Audio = await openaiTTS.speakText(safeText, settings);
      if (base64Audio && !ttsTargetSender.isDestroyed()) {
        updateWidgetState("speaking");
        ttsTargetSender.send("tts-start", base64Audio);
      }
    } catch (err) {
      appLogger.error("openai-tts failed", { error: err });
    }
  } else if (effectiveTtsProvider === "google") {
    const googleTTS = require("./src/tts/google-tts");
    try {
      const chunksBase64 = await googleTTS.speakText(safeText, settings);
      if (chunksBase64.length > 0 && !ttsTargetSender.isDestroyed()) {
        updateWidgetState("speaking");
        ttsTargetSender.send("tts-google", chunksBase64);
      }
    } catch (err) {
      appLogger.error("google-tts failed", { error: err });
    }
  }

  if (!ttsTargetSender.isDestroyed()) {
    ttsTargetSender.send("tts-done");
  }
  debugLog("tts:done", effectiveTtsProvider);
}

async function handleOrchestratorResult(result, settings, sender) {
  if (result?.pointer?.shouldPoint && result.pointer.coordinate) {
    showPointer(result.pointer);
  } else {
    hideCursorOverlay();
  }

  // In planning flow, speak only the current actionable step once when pointer appears.
  if (result?.pointer?.shouldPoint && result?.assistantMessage) {
    const ttsText = result?.userInputRequest?.message || result.assistantMessage;
    await speakAssistantResponse(ttsText, settings, sender);
  }

  return result;
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
function setupIPC() {
  // ── Settings ─────────────────────────────────────────────────────────────
  ipcMain.handle("get-settings", async () => {
    debugLog("ipc:get-settings");
    const nextSettings = await secureStore.fillSecrets(store.store);
    const guarded = applyPlatformSettingsGuards(nextSettings);
    return guarded.normalizedSettings;
  });
  ipcMain.handle("save-settings", async (_e, newSettings) => {
    debugLog("ipc:save-settings", Object.keys(newSettings || {}));
    const incomingSettings = newSettings || {};
    const guardedInput = applyPlatformSettingsGuards(incomingSettings);
    if (guardedInput.warnings.length > 0) {
      appLogger.warn("save-settings platform normalization", {
        warnings: guardedInput.warnings,
      });
    }
    await secureStore.saveSecretsFromSettings(guardedInput.normalizedSettings);
    for (const [k, v] of Object.entries(guardedInput.normalizedSettings || {})) {
      if (SECRET_KEYS.includes(k)) {
        store.delete(k);
        continue;
      }
      // electron-store throws if you try to set() undefined — use delete() instead
      if (v === undefined || v === null) {
        store.delete(k);
      } else {
        store.set(k, v);
      }
    }
    const hydratedSettings = await secureStore.fillSecrets(store.store);
    const guardedHydrated = applyPlatformSettingsGuards(hydratedSettings);
    const settingsToBroadcast = guardedHydrated.normalizedSettings;
    if (panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.webContents.send("settings-changed", settingsToBroadcast);
    }
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.webContents.send("settings-changed", settingsToBroadcast);
    }
    registerHotkeys();
    return {
      ok: true,
      warnings: guardedInput.warnings,
    };
  });
  ipcMain.handle("reset-settings", async () => {
    debugLog("ipc:reset-settings");
    if (currentAIController) {
      currentAIController.abort();
      currentAIController = null;
    }
    hideCursorOverlay();
    taskOrchestrator.resetSession();
    store.clear();
    clearSessionSnapshot(store);
    await secureStore.clearAllSecrets();
    const hydratedSettings = await secureStore.fillSecrets(store.store);
    const guardedHydrated = applyPlatformSettingsGuards(hydratedSettings);
    const settingsToBroadcast = guardedHydrated.normalizedSettings;
    if (panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.webContents.send("settings-changed", settingsToBroadcast);
    }
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.webContents.send("settings-changed", settingsToBroadcast);
    }
    registerHotkeys();
    return settingsToBroadcast;
  });

  ipcMain.handle("get-platform-capabilities", () => {
    return getPlatformCapabilities(process.platform);
  });

  ipcMain.handle("ensure-runtime-permissions", async () => {
    return ensureRuntimePermissions();
  });

  ipcMain.handle("open-permission-settings", async (_event, scope) => {
    return openPermissionSettings(scope);
  });

  ipcMain.handle("get-performance-metrics", () => {
    return perfMetrics.getSnapshot();
  });

  ipcMain.handle("reset-performance-metrics", () => {
    perfMetrics.reset();
    return { ok: true };
  });

  // ── Screenshot ───────────────────────────────────────────────────────────
  ipcMain.handle("capture-screenshot", async () => {
    const startedAt = Date.now();
    debugLog("ipc:capture-screenshot");
    try {
      const result = await captureAllScreens({ includeTimings: true });
      recordPerformanceMetric("ipc.capture-screenshot", startedAt, {
        ok: true,
        meta: {
          imageCount: result.images.length,
          fromCache: Boolean(result.timings?.fromCache),
          totalDurationMs: result.timings?.totalDurationMs || 0,
          getSourcesDurationMs: result.timings?.getSourcesDurationMs || 0,
          encodeDurationMs: result.timings?.encodeDurationMs || 0,
        },
      });
      updatePointerCalibration(result.images);
      return result.images;
    } catch (err) {
      recordPerformanceMetric("ipc.capture-screenshot", startedAt, {
        ok: false,
        meta: { errorName: err?.name || "Error" },
      });
      appLogger.error("capture-screenshot failed", { error: err });
      return [];
    }
  });

  ipcMain.handle("get-active-session", () => {
    debugLog("ipc:get-active-session");
    return sessionManager.getSnapshot();
  });

  ipcMain.handle("reset-session", () => {
    debugLog("ipc:reset-session");
    hideCursorOverlay();
    return taskOrchestrator.resetSession();
  });

  ipcMain.handle("start-goal-session", async (event, { text, images }) => {
    const requestContext = createRequestContext("start-goal-session");
    const startedAt = Date.now();
    debugLog("ipc:start-goal-session", {
      requestId: requestContext.requestId,
      textLength: text?.length || 0,
      imageCount: images?.length || 0,
    });
    if (currentAIController) currentAIController.abort();
    currentAIController = new AbortController();
    const runtimeSettings = await getRuntimeSettings();
    if (Array.isArray(images) && images.length > 0) {
      updatePointerCalibration(images);
    }

    try {
      const result = await taskOrchestrator.startGoalSession({
        text,
        images,
        settings: runtimeSettings,
        signal: currentAIController.signal,
        requestId: requestContext.requestId,
      });
      const handled = await handleOrchestratorResult(result, runtimeSettings, event.sender);
      recordPerformanceMetric("ipc.start-goal-session", startedAt, {
        ok: true,
        meta: { requestId: requestContext.requestId, imageCount: images?.length || 0 },
      });
      return { ...handled, requestId: requestContext.requestId };
    } catch (err) {
      recordPerformanceMetric("ipc.start-goal-session", startedAt, {
        ok: false,
        meta: { requestId: requestContext.requestId, errorName: err?.name || "Error" },
      });
      appLogger.error("ipc:start-goal-session failed", {
        requestId: requestContext.requestId,
        error: err,
      });
      throw wrapUserFacingError(err);
    } finally {
      currentAIController = null;
    }
  });

  ipcMain.handle("submit-user-message", async (event, { text, images }) => {
    const requestContext = createRequestContext("submit-user-message");
    const startedAt = Date.now();
    debugLog("ipc:submit-user-message", {
      requestId: requestContext.requestId,
      textLength: text?.length || 0,
      imageCount: images?.length || 0,
    });
    if (currentAIController) currentAIController.abort();
    currentAIController = new AbortController();
    const runtimeSettings = await getRuntimeSettings();
    if (Array.isArray(images) && images.length > 0) {
      updatePointerCalibration(images);
    }

    try {
      const result = await taskOrchestrator.submitUserMessage({
        text,
        images,
        settings: runtimeSettings,
        signal: currentAIController.signal,
        requestId: requestContext.requestId,
      });
      const handled = await handleOrchestratorResult(result, runtimeSettings, event.sender);
      recordPerformanceMetric("ipc.submit-user-message", startedAt, {
        ok: true,
        meta: { requestId: requestContext.requestId, imageCount: images?.length || 0 },
      });
      return { ...handled, requestId: requestContext.requestId };
    } catch (err) {
      recordPerformanceMetric("ipc.submit-user-message", startedAt, {
        ok: false,
        meta: { requestId: requestContext.requestId, errorName: err?.name || "Error" },
      });
      appLogger.error("ipc:submit-user-message failed", {
        requestId: requestContext.requestId,
        error: err,
      });
      throw wrapUserFacingError(err);
    } finally {
      currentAIController = null;
    }
  });

  ipcMain.handle("mark-step-done", async (event) => {
    const requestContext = createRequestContext("mark-step-done");
    debugLog("ipc:mark-step-done", { requestId: requestContext.requestId });
    if (currentAIController) currentAIController.abort();
    currentAIController = new AbortController();
    const runtimeSettings = await getRuntimeSettings();

    try {
      const result = await taskOrchestrator.markStepDone({
        settings: runtimeSettings,
        signal: currentAIController.signal,
        requestId: requestContext.requestId,
      });
      const handled = await handleOrchestratorResult(result, runtimeSettings, event.sender);
      return { ...handled, requestId: requestContext.requestId };
    } catch (err) {
      appLogger.error("ipc:mark-step-done failed", {
        requestId: requestContext.requestId,
        error: err,
      });
      throw wrapUserFacingError(err);
    } finally {
      currentAIController = null;
    }
  });

  ipcMain.handle("request-step-help", async (event) => {
    const requestContext = createRequestContext("request-step-help");
    debugLog("ipc:request-step-help", { requestId: requestContext.requestId });
    if (currentAIController) currentAIController.abort();
    currentAIController = new AbortController();
    const runtimeSettings = await getRuntimeSettings();

    try {
      const result = await taskOrchestrator.requestStepHelp({
        settings: runtimeSettings,
        signal: currentAIController.signal,
        requestId: requestContext.requestId,
      });
      const handled = await handleOrchestratorResult(result, runtimeSettings, event.sender);
      return { ...handled, requestId: requestContext.requestId };
    } catch (err) {
      appLogger.error("ipc:request-step-help failed", {
        requestId: requestContext.requestId,
        error: err,
      });
      throw wrapUserFacingError(err);
    } finally {
      currentAIController = null;
    }
  });

  ipcMain.handle("recheck-current-step", async (event) => {
    const requestContext = createRequestContext("recheck-current-step");
    debugLog("ipc:recheck-current-step", { requestId: requestContext.requestId });
    if (currentAIController) currentAIController.abort();
    currentAIController = new AbortController();
    const runtimeSettings = await getRuntimeSettings();

    try {
      const result = await taskOrchestrator.recheckCurrentStep({
        settings: runtimeSettings,
        signal: currentAIController.signal,
        requestId: requestContext.requestId,
      });
      const handled = await handleOrchestratorResult(result, runtimeSettings, event.sender);
      return { ...handled, requestId: requestContext.requestId };
    } catch (err) {
      appLogger.error("ipc:recheck-current-step failed", {
        requestId: requestContext.requestId,
        error: err,
      });
      throw wrapUserFacingError(err);
    } finally {
      currentAIController = null;
    }
  });

  ipcMain.handle("skip-current-step", async (event) => {
    const requestContext = createRequestContext("skip-current-step");
    debugLog("ipc:skip-current-step", { requestId: requestContext.requestId });
    if (currentAIController) currentAIController.abort();
    currentAIController = new AbortController();
    const runtimeSettings = await getRuntimeSettings();

    try {
      const result = await taskOrchestrator.skipCurrentStep({
        settings: runtimeSettings,
        signal: currentAIController.signal,
        requestId: requestContext.requestId,
      });
      const handled = await handleOrchestratorResult(result, runtimeSettings, event.sender);
      return { ...handled, requestId: requestContext.requestId };
    } catch (err) {
      appLogger.error("ipc:skip-current-step failed", {
        requestId: requestContext.requestId,
        error: err,
      });
      throw wrapUserFacingError(err);
    } finally {
      currentAIController = null;
    }
  });

  ipcMain.handle("previous-step", async (event) => {
    const requestContext = createRequestContext("previous-step");
    debugLog("ipc:previous-step", { requestId: requestContext.requestId });
    if (currentAIController) currentAIController.abort();
    currentAIController = new AbortController();
    const runtimeSettings = await getRuntimeSettings();

    try {
      const result = await taskOrchestrator.previousStep({
        settings: runtimeSettings,
        signal: currentAIController.signal,
        requestId: requestContext.requestId,
      });
      const handled = await handleOrchestratorResult(result, runtimeSettings, event.sender);
      return { ...handled, requestId: requestContext.requestId };
    } catch (err) {
      appLogger.error("ipc:previous-step failed", {
        requestId: requestContext.requestId,
        error: err,
      });
      throw wrapUserFacingError(err);
    } finally {
      currentAIController = null;
    }
  });

  ipcMain.handle("regenerate-current-step", async (event) => {
    const requestContext = createRequestContext("regenerate-current-step");
    debugLog("ipc:regenerate-current-step", { requestId: requestContext.requestId });
    if (currentAIController) currentAIController.abort();
    currentAIController = new AbortController();
    const runtimeSettings = await getRuntimeSettings();

    try {
      const result = await taskOrchestrator.regenerateCurrentStep({
        settings: runtimeSettings,
        signal: currentAIController.signal,
        requestId: requestContext.requestId,
      });
      const handled = await handleOrchestratorResult(result, runtimeSettings, event.sender);
      return { ...handled, requestId: requestContext.requestId };
    } catch (err) {
      appLogger.error("ipc:regenerate-current-step failed", {
        requestId: requestContext.requestId,
        error: err,
      });
      throw wrapUserFacingError(err);
    } finally {
      currentAIController = null;
    }
  });

  // ── AI streaming ─────────────────────────────────────────────────────────
  ipcMain.handle("send-message", async (event, { text, images, history, fastMode }) => {
    const requestContext = createRequestContext("send-message");
    const startedAt = Date.now();
    debugLog("ipc:send-message start", {
      requestId: requestContext.requestId,
      textLength: text?.length || 0,
      imageCount: images?.length || 0,
      historyCount: history?.length || 0,
      fastMode: Boolean(fastMode),
    });
    // Cancel any in-progress AI request
    if (currentAIController) currentAIController.abort();
    currentAIController = new AbortController();
    if (Array.isArray(images) && images.length > 0) {
      updatePointerCalibration(images);
    }

    broadcastAgentState("thinking");
    updateWidgetState("thinking");
    const settings = await getRuntimeSettings();
    const requestSettings = { ...settings };
    if (fastMode) {
      const userPrompt = settings.systemPromptOverride || "";
      requestSettings.systemPromptOverride = `${userPrompt}\n\n${FAST_MODE_PROMPT}`.trim();
    }
    try {
      const fullText = await streamAIResponse({
        text, images, history, settings: requestSettings,
        signal: currentAIController.signal,
        onChunk: (chunk) => {
          if (!event.sender.isDestroyed())
            event.sender.send("ai-chunk", chunk);
        },
      });

      const parsed = parsePointTag(fullText);
      if (!event.sender.isDestroyed())
        event.sender.send("ai-done", { ...parsed, requestId: requestContext.requestId });
      broadcastAgentState("executing");
      
      debugLog("ipc:send-message done", {
        requestId: requestContext.requestId,
        hasCoordinate: Boolean(parsed.coordinate),
        textLength: fullText.length,
      });
      updateWidgetState("idle");

      if (parsed.coordinate) {
        showPointer({
          coordinate: parsed.coordinate,
          label: parsed.label,
          explanation: parsed.spokenText,
          shouldPoint: true,
        });
      }

      await speakAssistantResponse(parsed.spokenText || fullText, settings, event.sender);
      recordPerformanceMetric("ipc.send-message", startedAt, {
        ok: true,
        meta: {
          requestId: requestContext.requestId,
          textLength: text?.length || 0,
          responseLength: fullText.length,
          imageCount: images?.length || 0,
        },
      });
    } catch (err) {
      recordPerformanceMetric("ipc.send-message", startedAt, {
        ok: false,
        meta: {
          requestId: requestContext.requestId,
          errorName: err?.name || "Error",
          imageCount: images?.length || 0,
        },
      });
      appLogger.error("ipc:send-message failed", {
        requestId: requestContext.requestId,
        error: err,
      });
      if (err.name !== "AbortError" && !event.sender.isDestroyed())
        event.sender.send("ai-error", toUiErrorPayload(err, requestContext));
      broadcastAgentState("idle");
    } finally {
      currentAIController = null;
    }
  });

  // ── Abort current AI request ──────────────────────────────────────────────
  ipcMain.handle("abort-message", () => {
    debugLog("ipc:abort-message");
    if (currentAIController) { currentAIController.abort(); currentAIController = null; }
  });

  // ── TTS ───────────────────────────────────────────────────────────────────
  ipcMain.on("stop-tts", (event, options) => {
    debugLog("ipc:stop-tts");
    if (!event.sender.isDestroyed()) event.sender.send("tts-webspeech-stop", options || {});
  });

  // ── Cursor ────────────────────────────────────────────────────────────────
  ipcMain.on("show-cursor-at", (_e, data) => {
    debugLog("ipc:show-cursor-at", data?.label || "element");
    if (cursorOverlayWindow && !cursorOverlayWindow.isDestroyed()) {
      cursorOverlayWindow.show();
      cursorOverlayWindow.webContents.send("show-cursor-at", data);
    }
  });
  ipcMain.on("hide-cursor", () => {
    debugLog("ipc:hide-cursor");
    if (cursorOverlayWindow && !cursorOverlayWindow.isDestroyed())
      cursorOverlayWindow.hide();
  });

  // ── AssemblyAI token (direct API key only) ────────────────────────────────
  ipcMain.handle("get-assemblyai-token", async () => {
    debugLog("ipc:get-assemblyai-token");
    const settings = await getRuntimeSettings();
    if (settings.assemblyaiApiKey) {
      const resp = await fetch("https://streaming.assemblyai.com/v3/token?expires_in_seconds=480", {
        headers: { authorization: settings.assemblyaiApiKey },
      });
      const json = await resp.json();
      return json.token;
    }
    throw new Error("No AssemblyAI API key configured. Go to Settings → Voice and add your key.");
  });

  // ── Ollama model list ─────────────────────────────────────────────────────
  ipcMain.handle("get-ollama-models", async () => {
    debugLog("ipc:get-ollama-models");
    const ollamaUrl = store.get("ollamaUrl") || "http://localhost:11434";
    return fetchOllamaModels(ollamaUrl);
  });

  // ── Window controls ───────────────────────────────────────────────────────
  ipcMain.handle("open-settings",  () => {
    debugLog("ipc:open-settings");
    return createSettingsWindow();
  });
  ipcMain.handle("open-external-link", async (_event, url) => {
    const target = String(url || "").trim();
    if (!/^https?:\/\//i.test(target)) {
      throw new Error("Invalid URL");
    }
    await shell.openExternal(target);
    return true;
  });
  ipcMain.handle("close-settings", () => {
    debugLog("ipc:close-settings");
    if (settingsWindow) settingsWindow.close();
  });
  ipcMain.handle("minimize-panel", () => {
    debugLog("ipc:minimize-panel");
    if (store && panelWindow && !panelWindow.isDestroyed()) {
      const [x, y] = panelWindow.getPosition();
      store.set("panelWindowX", x);
      store.set("panelWindowY", y);
    }
    panelWindow.hide();
  });
  ipcMain.handle("quit-app",       () => {
    debugLog("ipc:quit-app");
    app.quit();
  });

  // ── Widget ───────────────────────────────────────────────────────────────
  ipcMain.handle("show-main",      () => {
    debugLog("ipc:show-main");
    return showPanel();
  });
  ipcMain.handle("hide-widget",    () => {
    debugLog("ipc:hide-widget");
    if (widgetWindow) widgetWindow.hide();
  });
  ipcMain.handle("set-widget-expanded", (_e, isExpanded) => {
    const expanded = Boolean(isExpanded);
    debugLog("ipc:set-widget-expanded", expanded);
    if (!widgetWindow || widgetWindow.isDestroyed()) {
      return false;
    }

    const nextHeight = expanded ? WIDGET_EXPANDED_HEIGHT : WIDGET_COLLAPSED_HEIGHT;
    resizeWidgetPreservingPosition(nextHeight);
    return true;
  });
  ipcMain.handle("set-widget-height", (_e, requestedHeight) => {
    const numericHeight = Number(requestedHeight);
    if (!widgetWindow || widgetWindow.isDestroyed() || !Number.isFinite(numericHeight)) {
      return false;
    }

    const { height: workAreaHeight } = screen.getPrimaryDisplay().workArea;
    const maxHeight = Math.max(WIDGET_COLLAPSED_HEIGHT, workAreaHeight - 40);
    const nextHeight = Math.max(
      WIDGET_COLLAPSED_HEIGHT,
      Math.min(Math.round(numericHeight), maxHeight),
    );
    resizeWidgetPreservingPosition(nextHeight);
    return true;
  });
  ipcMain.handle("cancel-active-plan", (_event, options) => {
    debugLog("ipc:cancel-active-plan");
    const result = taskOrchestrator.cancelActivePlan(options || {});
    return result;
  });
  ipcMain.on("widget-loaded",      () => {
    debugLog("ipc:widget-loaded");
    if (widgetWindow) widgetWindow.webContents.send("widget-ready");
  });
  ipcMain.on("update-widget-state", (_e, state) => {
    debugLog("ipc:update-widget-state", state);
    if (state === "listening") {
      isPushToTalkRecording = true;
    } else if (state === "idle") {
      isPushToTalkRecording = false;
    }
    if (state === "speaking") {
      broadcastAgentState("responding");
    } else if (state === "idle" && !isPushToTalkRecording) {
      const snapshotStatus = sessionManager?.getSnapshot?.().status || "idle";
      broadcastAgentState(snapshotStatus);
    }
    updateWidgetState(state);
  });
}

// ── ElevenLabs TTS (direct API key) ──────────────────────────────────────────
async function speakWithElevenLabs(text, settings, sender) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${settings.elevenlabsVoiceId}`;
  const headers = {
    "Content-Type": "application/json",
    accept: "audio/mpeg",
    "xi-api-key": settings.elevenlabsApiKey,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`ElevenLabs error ${resp.status}: ${errText}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  const base64Audio = Buffer.from(arrayBuffer).toString("base64");
  updateWidgetState("speaking");
  if (!sender.isDestroyed()) sender.send("tts-start", base64Audio);

  // Wait for renderer to signal tts-done — handled via IPC from renderer
  await new Promise(resolve => setTimeout(resolve, 500));
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  app.setName("OpenGuider");
  initializeLogger({ app, level: process.env.OPENGUIDER_LOG_LEVEL || "info" });
  appLogger = createLogger("main");
  registerCrashTracking();
  debugLog("app:ready start");
  store = createStore();
  secureStore = new SecureStore({ safeStorage, serviceName: "OpenGuider" });
  sessionManager = new SessionManager();
  const persistedSession = loadSessionSnapshot(store);
  if (persistedSession) {
    sessionManager.hydrateSession(persistedSession);
    appLogger.info("restored-session-from-disk", {
      messageCount: persistedSession?.messages?.length || 0,
      hasPlan: Boolean(persistedSession?.activePlan),
    });
  }
  taskOrchestrator = new TaskOrchestrator({
    captureAllScreens,
    sessionManager,
  });
  createTray();
  createPanelWindow();
  createCursorOverlay();
  createWidgetWindow();
  sessionManager.on("updated", (snapshot) => {
    saveSessionSnapshot(store, snapshot);
    if (Array.isArray(snapshot?.lastScreenshots) && snapshot.lastScreenshots.length > 0) {
      updatePointerCalibration(snapshot.lastScreenshots);
    }
    broadcastSessionSnapshot(snapshot);
  });
  broadcastSessionSnapshot(sessionManager.getSnapshot());
  setupIPC();
  registerHotkeys();
  app.on("activate", () => {
    debugLog("app:activate");
    showPanel();
    if (widgetWindow) widgetWindow.show();
  });
  debugLog("app:ready complete");
});

app.on("second-instance", () => {
  if (panelWindow && !panelWindow.isDestroyed()) {
    showPanel();
    return;
  }
  app.whenReady().then(() => {
    if (panelWindow && !panelWindow.isDestroyed()) {
      showPanel();
    }
  });
});

app.on("will-quit", () => {
  debugLog("app:will-quit");
  globalShortcut.unregisterAll();
});
app.on("window-all-closed", (e) => e.preventDefault()); // keep running in tray
