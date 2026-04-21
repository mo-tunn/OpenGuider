import { createMessagingController } from "./messaging.js";
import { createPlanView } from "./plan-view.js";
import { createPttController } from "./ptt.js";
import { createPanelState } from "./state.js";
import { createTtsPlaybackController } from "./tts.js";
import { createPanelUI, queryPanelDom } from "./ui.js";

function createPanelLogger() {
  return (...args) => {
    console.log("[OpenGuider][panel]", ...args);
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
  const messaging = createMessagingController({ api, doc, dom, log, state, ui });
  const tts = createTtsPlaybackController({ api, log, state, win });
  const ptt = createPttController({ api, dom, log, messaging, state, ui, win });

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

  function updatePlanActionVisibility(assistantMode) {
    if (!dom.panelActions) {
      return;
    }
    const showActions = assistantMode === "planning";
    dom.panelActions.classList.toggle("hidden", !showActions);
  }

  function bindEvents() {
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
      messaging.syncSession(snapshot);
      planView.renderPlan(snapshot?.activePlan || null);
      ui.renderAgentState(snapshot?.status || "idle");
      updatePlanActionButtons(snapshot);
    });

    api.on("plan-updated", (plan) => {
      log("ipc:plan-updated received");
      state.setActivePlan(plan || null);
      planView.renderPlan(plan || null);
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
    ui.renderAgentState(session?.status || "idle");
    applyShortcutTitles();
    updatePlanActionButtons(session);
    const assistantMode = settings?.assistantMode || "fast";
    dom.assistantModeSelect.value = assistantMode;
    state.setSetting("assistantMode", assistantMode);
    state.setSetting("planningModeEnabled", assistantMode === "planning");
    updatePlanActionVisibility(assistantMode);
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
