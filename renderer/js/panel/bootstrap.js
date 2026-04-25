import { createMessagingController } from "./messaging.js";
import { createPlanView } from "./plan-view.js";
import { createPttController } from "./ptt.js";
import { createPanelState } from "./state.js";
import { createTtsPlaybackController } from "./tts.js";
import { createPanelUI, queryPanelDom } from "./ui.js";

const BROWSER_EXECUTION_TERMINAL_STATUSES = new Set(["success", "failed", "aborted"]);
const MODE_BAR_HIDE_DELAY_MS = 150;

function createPanelLogger() {
  return (...args) => {
    console.log("[OpenGuider][panel]", ...args);
  };
}

function isActiveBrowserExecution(browserExecution) {
  return Boolean(browserExecution) && !BROWSER_EXECUTION_TERMINAL_STATUSES.has(browserExecution.status);
}

function getModeBarPluginLabel(browserExecution) {
  const pluginId = String(
    browserExecution?.pluginId
    || browserExecution?.pluginName
    || browserExecution?.pluginType
    || "browser",
  ).toLowerCase();

  if (pluginId.includes("desktop")) {
    return "◈ DESKTOP EXECUTING";
  }
  if (pluginId.includes("cli")) {
    return "▸ CLI EXECUTING";
  }
  return "⬡ BROWSER EXECUTING";
}

function getTrustPresentation(trustLevel) {
  if (trustLevel === "autopilot") {
    return {
      label: "● AUTOPILOT",
      tone: "autopilot",
      noticeLabel: "autopilot",
    };
  }
  if (trustLevel === "paranoid") {
    return {
      label: "● PARANOID",
      tone: "paranoid",
      noticeLabel: "paranoid",
    };
  }
  return {
    label: "● SUPERVISED",
    tone: "supervised",
    noticeLabel: "supervised",
  };
}

function getCurrentBrowserStepNumber(browserExecution) {
  const substeps = Array.isArray(browserExecution?.substeps) ? browserExecution.substeps : [];
  if (substeps.length === 0) {
    return 0;
  }

  const running = substeps.find((substep) => substep?.status === "running");
  if (running?.stepNumber) {
    return Number(running.stepNumber) || 0;
  }

  return Number(substeps[substeps.length - 1]?.stepNumber) || substeps.length;
}

function formatModeBarStep(stepNumber) {
  const safeStep = Number.isFinite(Number(stepNumber)) ? Math.max(0, Number(stepNumber)) : 0;
  return `STEP ${safeStep} / ?`;
}

function normalizeInlineText(text) {
  return String(text || "").trim().replace(/\s+/g, " ");
}

function getBrowserExecutionTerminalSummary(browserExecution) {
  const finalMessage = normalizeInlineText(browserExecution?.finalMessage);
  if (finalMessage) {
    return finalMessage;
  }

  const goal = normalizeInlineText(browserExecution?.goal);
  if (goal) {
    return goal;
  }

  return browserExecution?.status === "success"
    ? "Task completed."
    : "Task finished with issues.";
}

function createStepApprovalController({ dom, log, win = window }) {
  const StepApprovalCardCtor = win.StepApprovalCard;
  if (!dom.stepApprovalCard || !dom.stepApprovalSection) {
    return {
      syncBrowserExecution() {},
    };
  }

  if (typeof StepApprovalCardCtor !== "function") {
    log("step-approval:component unavailable");
    return {
      syncBrowserExecution() {},
    };
  }

  const card = new StepApprovalCardCtor(dom.stepApprovalCard, dom.stepApprovalSection);

  return {
    syncBrowserExecution(browserExecution) {
      const status = browserExecution?.status || null;
      if (!browserExecution || status === "success" || status === "failed" || status === "aborted") {
        card.hide();
      }
    },
  };
}

export function createPanelController({
  api = window.openguider,
  doc = document,
  win = window,
} = {}) {
  const state = createPanelState();
  const dom = queryPanelDom(doc);
  const log = createPanelLogger();

  const ui = createPanelUI({ api, doc, dom, log, state });
  const planView = createPlanView({ doc, dom });
  const stepApproval = createStepApprovalController({ dom, log, win });
  const messaging = createMessagingController({ api, doc, dom, log, state, ui });
  const tts = createTtsPlaybackController({ api, log, state, win });
  const ptt = createPttController({ api, dom, log, messaging, state, ui, win });
  let lastBrowserExecutionSnapshot = null;
  let modeBarHideTimer = null;

  function getActionShortcutMap() {
    return [
      { settingKey: "previousStepShortcut", action: () => api.invoke("previous-step"), button: dom.btnPlanPrev, title: "Previous step" },
      { settingKey: "markStepDoneShortcut", action: () => api.invoke("mark-step-done"), button: dom.btnPlanDone, title: "Mark done" },
      { settingKey: "skipCurrentStepShortcut", action: () => api.invoke("skip-current-step"), button: dom.btnPlanSkip, title: "Skip step" },
      { settingKey: "requestStepHelpShortcut", action: () => api.invoke("request-step-help"), button: dom.btnPlanHelp, title: "Need help" },
      { settingKey: "regenerateCurrentStepShortcut", action: () => api.invoke("regenerate-current-step"), button: dom.btnPlanRegenerate, title: "Regenerate step" },
      { settingKey: "recheckCurrentStepShortcut", action: () => api.invoke("recheck-current-step"), button: dom.btnPlanRecheck, title: "Re-check" },
      { settingKey: "cancelActivePlanShortcut", action: () => api.invoke("cancel-active-plan"), button: dom.btnPlanCancel, title: "Cancel plan" },
    ];
  }

  function applyShortcutTitles() {
    getActionShortcutMap().forEach(({ settingKey, button, title }) => {
      if (!button) {
        return;
      }
      if (!settingKey) {
        button.title = title;
        return;
      }
      const value = state.getSetting(settingKey);
      button.title = value ? `${title} (${value})` : title;
    });
  }

  function updatePlanActionButtons(snapshot) {
    const currentStep = snapshot?.activePlan?.steps?.[snapshot?.activePlan?.currentStepIndex];
    const enabled = Boolean(currentStep) && snapshot?.status === "waiting_user";
    dom.btnPlanDone.disabled = !enabled;
    dom.btnPlanPrev.disabled = !enabled;
    dom.btnPlanSkip.disabled = !enabled;
    dom.btnPlanHelp.disabled = !enabled;
    dom.btnPlanRegenerate.disabled = !enabled;
    dom.btnPlanRecheck.disabled = !enabled;
    dom.btnPlanCancel.disabled = !enabled;
  }

  function updatePlanActionVisibility(assistantMode, sessionSnapshot = null) {
    if (!dom.panelActions) {
      return;
    }

    const snapshot = sessionSnapshot || state.getSessionSnapshot() || {
      activePlan: state.getActivePlan(),
      browserExecution: state.getBrowserExecution(),
    };
    const currentStep = snapshot?.activePlan?.steps?.[snapshot?.activePlan?.currentStepIndex];
    const showActions = assistantMode === "planning"
      && !snapshot?.browserExecution
      && Boolean(currentStep);
    dom.panelActions.classList.toggle("hidden", !showActions);
  }

  function updateModeBarStepCounter(stepNumber) {
    if (!dom.modeBarStep) {
      return;
    }
    dom.modeBarStep.textContent = formatModeBarStep(stepNumber);
  }

  function showModeBar(browserExecution) {
    if (!dom.modeBar) {
      return;
    }

    const trust = getTrustPresentation(browserExecution?.trustLevel);
    const shouldAnimateIn = dom.modeBar.classList.contains("hidden") || dom.modeBar.classList.contains("is-leaving");
    if (modeBarHideTimer) {
      win.clearTimeout(modeBarHideTimer);
      modeBarHideTimer = null;
    }

    dom.modeBarPlugin.textContent = getModeBarPluginLabel(browserExecution);
    dom.modeBarTrust.textContent = trust.label;
    dom.modeBarTrust.dataset.tone = trust.tone;
    updateModeBarStepCounter(getCurrentBrowserStepNumber(browserExecution));

    dom.modeBar.classList.remove("hidden", "is-leaving");
    dom.modeBar.setAttribute("aria-hidden", "false");
    if (shouldAnimateIn) {
      dom.modeBar.classList.remove("is-sweeping");
      void dom.modeBar.offsetWidth;
      dom.modeBar.classList.add("is-visible", "is-sweeping");
      win.setTimeout(() => {
        dom.modeBar?.classList.remove("is-sweeping");
      }, 320);
    } else {
      dom.modeBar.classList.add("is-visible");
    }
  }

  function hideModeBar() {
    if (!dom.modeBar || dom.modeBar.classList.contains("hidden")) {
      return;
    }

    if (modeBarHideTimer) {
      win.clearTimeout(modeBarHideTimer);
    }

    dom.modeBar.classList.remove("is-visible", "is-sweeping");
    dom.modeBar.classList.add("is-leaving");
    dom.modeBar.setAttribute("aria-hidden", "true");

    modeBarHideTimer = win.setTimeout(() => {
      dom.modeBar?.classList.add("hidden");
      dom.modeBar?.classList.remove("is-leaving");
      modeBarHideTimer = null;
    }, MODE_BAR_HIDE_DELAY_MS);
  }

  function injectBrowserExecutionNotice(previousExecution, nextExecution) {
    const wasActive = isActiveBrowserExecution(previousExecution);
    const isActive = isActiveBrowserExecution(nextExecution);

    if (!wasActive && isActive) {
      const trust = getTrustPresentation(nextExecution?.trustLevel);
      ui.injectSystemNotice(`⬡ Browser automation started · ${trust.noticeLabel}`, "start");
      return;
    }

    if (!wasActive) {
      return;
    }

    const nextStatus = nextExecution?.status || null;
    if (!nextStatus || !BROWSER_EXECUTION_TERMINAL_STATUSES.has(nextStatus)) {
      return;
    }

    const stepCount = Array.isArray(nextExecution?.substeps) ? nextExecution.substeps.length : 0;
    const summary = getBrowserExecutionTerminalSummary(nextExecution);
    const prefix = nextStatus === "success" ? "⬡ Done" : "⬡ Failed";
    ui.injectSystemNotice(
      `${prefix} · ${stepCount} step${stepCount === 1 ? "" : "s"} · ${summary}`,
      nextStatus === "success" ? "success" : "error",
      { richText: true },
    );
  }

  function syncBrowserExecution(browserExecution) {
    const activeExecution = isActiveBrowserExecution(browserExecution) ? browserExecution : null;
    state.setBrowserExecution(activeExecution);
    if (dom.panelRoot) {
      dom.panelRoot.classList.toggle("browser-task-active", Boolean(activeExecution));
    }
    if (browserExecution) {
      planView.renderBrowserExecution(browserExecution);
    } else {
      planView.clearBrowserExecution();
    }
    if (activeExecution) {
      showModeBar(activeExecution);
    } else {
      hideModeBar();
    }
    stepApproval.syncBrowserExecution(browserExecution || null);
    updatePlanActionVisibility(state.getSetting("assistantMode") || "fast");
  }

  function bindEvents() {
    dom.textInput.addEventListener("focus", () => {
      if (state.isStreaming()) {
        messaging.cancelMessage();
      }
    });

    dom.textInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        messaging.sendMessage();
      }
    });

    dom.textInput.addEventListener("input", () => {
      dom.textInput.style.height = "auto";
      dom.textInput.style.height = Math.min(dom.textInput.scrollHeight, 120) + "px";
    });

    dom.sendBtn.addEventListener("click", messaging.sendMessage);
    const stopBtn = doc.getElementById("stop-btn");
    if (stopBtn) {
      stopBtn.addEventListener("click", messaging.cancelMessage);
    }
    dom.btnPlanPrev.addEventListener("click", () => api.invoke("previous-step"));
    dom.btnPlanDone.addEventListener("click", () => api.invoke("mark-step-done"));
    dom.btnPlanSkip.addEventListener("click", () => api.invoke("skip-current-step"));
    dom.btnPlanHelp.addEventListener("click", () => api.invoke("request-step-help"));
    dom.btnPlanRegenerate.addEventListener("click", () => api.invoke("regenerate-current-step"));
    dom.btnPlanRecheck.addEventListener("click", () => api.invoke("recheck-current-step"));
    dom.btnPlanCancel.addEventListener("click", () => api.invoke("cancel-active-plan"));

    dom.modelSelect.addEventListener("change", async () => {
      const selectedModel = dom.modelSelect.value;
      if (!selectedModel) {
        return;
      }

      state.setSetting("aiModel", selectedModel);
      const providerKey = (state.getSetting("aiProvider") || "claude") + "ModelCustom";
      state.setSetting(providerKey, selectedModel);

      log("ipc:save-settings invoke", providerKey);
      await api.invoke("save-settings", {
        aiModel: selectedModel,
        [providerKey]: selectedModel,
      });
    });

    dom.assistantModeSelect.addEventListener("change", async () => {
      const assistantMode = dom.assistantModeSelect.value === "fast" ? "fast" : "planning";
      if (!dom.assistantModeSelect.value) {
        return;
      }
      const planningEnabled = assistantMode === "planning";
      state.setSetting("assistantMode", assistantMode);
      state.setSetting("planningModeEnabled", planningEnabled);
      updatePlanActionVisibility(assistantMode);
      ui.hideErrorBanner();
      dom.sendBtn.disabled = false;
      dom.pttBtn.disabled = false;
      log("ipc:save-settings invoke assistantMode", assistantMode);
      await api.invoke("save-settings", {
        assistantMode,
        planningModeEnabled: planningEnabled,
      });

      if (!planningEnabled) {
        await api.invoke("cancel-active-plan", { silent: true });
      }
    });

    dom.btnSettings.addEventListener("click", () => {
      log("ipc:open-settings invoke");
      api.invoke("open-settings");
    });

    dom.btnClose.addEventListener("click", () => {
      log("ipc:minimize-panel invoke");
      api.invoke("minimize-panel");
    });

    dom.btnClear.addEventListener("click", async () => {
      const shouldDelete = await ui.confirmClearConversation();
      if (!shouldDelete) {
        return;
      }
      log("ipc:reset-session invoke");
      await api.invoke("reset-session");
    });
    dom.pttBtn.addEventListener("mousedown", ptt.startPTT);
    dom.pttBtn.addEventListener("mouseup", ptt.stopPTT);
    dom.pttBtn.addEventListener("mouseleave", ptt.stopPTT);

    // Click anywhere in chat area focuses the text input for typing.
    dom.chatArea.addEventListener("click", (event) => {
      // Don't steal focus from links or interactive elements inside messages.
      if (event.target.closest("a, button, select, input, textarea, details")) {
        return;
      }
      dom.textInput.focus();
    });

    // Safety: reset stuck UI state when user focuses the text input.
    dom.textInput.addEventListener("focus", () => {
      if (state.isStreaming()) {
        log("safety:focus reset stuck streaming state");
        api.invoke("abort-message");
        state.setStreaming(false);
        dom.sendBtn.disabled = false;
        ui.renderAgentState("idle");
        ui.removeAllTypingIndicators();
      }
      if (state.isRecording()) {
        log("safety:focus reset stuck recording state");
        ptt.stopPTT();
      }
    });

    dom.onboardingOpenSettings?.addEventListener("click", async () => {
      state.setSetting("onboardingCompleted", true);
      await api.invoke("save-settings", { onboardingCompleted: true });
      ui.hideOnboarding();
      await api.invoke("open-settings");
    });

  }

  function setupIPCListeners() {
    api.on("push-to-talk-start", () => {
      log("ipc:push-to-talk-start received");
      ptt.startPTT();
    });

    api.on("push-to-talk-stop", () => {
      log("ipc:push-to-talk-stop received");
      ptt.stopPTT();
    });

    api.on("ai-chunk", (chunk) => messaging.appendStreamChunk(chunk));
    api.on("ai-done", (parsed) => messaging.onAIDone(parsed));
    api.on("ai-error", (errorMessage) => messaging.onAIError(errorMessage));
    api.on("tts-start", (base64Audio) => tts.handleTtsStart(base64Audio));
    api.on("tts-webspeech", (data) => tts.handleWebSpeech(data));
    api.on("tts-webspeech-stop", (options) => tts.handleWebSpeechStop(options));
    api.on("tts-google", (chunksBase64) => tts.handleGoogleTts(chunksBase64));

    api.on("settings-changed", (nextSettings) => {
      log("ipc:settings-changed received");
      state.setSettings(nextSettings);
      ui.buildModelSelector();
      ui.updateProviderDot();
      applyShortcutTitles();
      const assistantMode = nextSettings?.assistantMode || "fast";
      dom.assistantModeSelect.value = assistantMode;
      updatePlanActionVisibility(assistantMode);
      state.setIncludeScreen(nextSettings?.includeScreenshotByDefault !== false);
    });

    api.on("session-updated", (snapshot) => {
      log("ipc:session-updated received");
      injectBrowserExecutionNotice(lastBrowserExecutionSnapshot, snapshot?.browserExecution || null);
      lastBrowserExecutionSnapshot = snapshot?.browserExecution || null;
      messaging.syncSession(snapshot);
      planView.renderPlan(snapshot?.activePlan || null);
      syncBrowserExecution(snapshot?.browserExecution || null);
      ui.renderAgentState(snapshot?.status || "idle");
      updatePlanActionVisibility(state.getSetting("assistantMode") || "fast", snapshot);
      updatePlanActionButtons(snapshot);
    });

    api.on("execution:substep-progress", (substep) => {
      if (!isActiveBrowserExecution(lastBrowserExecutionSnapshot)) {
        return;
      }
      updateModeBarStepCounter(substep?.stepNumber || getCurrentBrowserStepNumber(lastBrowserExecutionSnapshot));
    });

    api.on("plan-updated", (plan) => {
      log("ipc:plan-updated received");
      state.setActivePlan(plan || null);
      planView.renderPlan(plan || null);
      updatePlanActionVisibility(state.getSetting("assistantMode") || "fast", {
        activePlan: plan || null,
        browserExecution: state.getBrowserExecution(),
      });
    });

    api.on("agent-state-changed", (nextState) => {
      log("ipc:agent-state-changed received", nextState);
      state.setAgentState(nextState);
      ui.renderAgentState(nextState);
    });

    api.on("pointer-updated", (pointer) => {
      log("ipc:pointer-updated received");
      state.setPointer(pointer);
    });
  }

  async function ensureRuntimePermissions() {
    try {
      const permissionState = await api.invoke("ensure-runtime-permissions");
      if (permissionState?.screenNeedsSettings) {
        ui.showErrorBanner({
          title: "Screen recording permission needed",
          message: "OpenGuider needs macOS Screen Recording permission for accurate screenshot guidance.",
          actionLabel: "Open system settings",
          onAction: () => {
            api.invoke("open-permission-settings", "screen");
          },
        });
      }
    } catch (error) {
      log("ipc:ensure-runtime-permissions error", error);
    }
  }

  async function init() {
    log("init:start");
    const settings = await api.invoke("get-settings");
    const session = await api.invoke("get-active-session");
    state.setSettings(settings);
    state.setSessionSnapshot(session);
    ui.buildModelSelector();
    ui.updateProviderDot();
    ui.renderConversation(session?.messages || []);
    planView.renderPlan(session?.activePlan || null);
    lastBrowserExecutionSnapshot = session?.browserExecution || null;
    syncBrowserExecution(session?.browserExecution || null);
    ui.renderAgentState(session?.status || "idle");
    applyShortcutTitles();
    updatePlanActionButtons(session);
    const assistantMode = settings?.assistantMode || "fast";
    dom.assistantModeSelect.value = assistantMode;
    state.setSetting("assistantMode", assistantMode);
    state.setSetting("planningModeEnabled", assistantMode === "planning");
    updatePlanActionVisibility(assistantMode, session);
    dom.sendBtn.disabled = false;
    dom.pttBtn.disabled = false;
    state.setIncludeScreen(settings?.includeScreenshotByDefault !== false);
    bindEvents();
    setupIPCListeners();
    if (!settings?.onboardingCompleted) {
      state.setSetting("onboardingCompleted", true);
      await api.invoke("save-settings", { onboardingCompleted: true });
      ui.showOnboarding();
    }
    await ensureRuntimePermissions();
    dom.textInput.focus();
    log("init:complete");
  }

  return {
    init,
  };
}

export async function initPanelApp() {
  const controller = createPanelController();
  await controller.init();
}
