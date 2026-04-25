export function createTaskWidgetController({ api, doc = document }) {
  const TERMINAL_BROWSER_STATUSES = new Set(["success", "failed", "aborted"]);
  const dom = {
    details: doc.getElementById("widget-details"),
    widget: doc.getElementById("widget"),
    statusLogo: doc.getElementById("status-logo"),
    loader: doc.getElementById("widget-loader"),
    statusText: doc.getElementById("status-text"),
    goalText: doc.getElementById("goal-text"),
    browserProgress: doc.getElementById("browser-progress"),
    stepCard: doc.getElementById("step-card"),
    stepTitle: doc.getElementById("step-title"),
    stepInstruction: doc.getElementById("step-instruction"),
    stepProgress: doc.getElementById("step-progress"),
    actionRow: doc.getElementById("action-row"),
    btnDone: doc.getElementById("btn-done"),
    btnPrev: doc.getElementById("btn-prev"),
    btnSkip: doc.getElementById("btn-skip"),
    btnHelp: doc.getElementById("btn-help"),
    btnRegenerate: doc.getElementById("btn-regenerate"),
    btnRecheck: doc.getElementById("btn-recheck"),
    btnCancelPlan: doc.getElementById("btn-cancel-plan"),
    btnOpenChat: doc.getElementById("btn-open-chat"),
    btnExpand: doc.getElementById("btn-expand"),
    btnShowPlan: doc.getElementById("btn-show-plan"),
  };
  let isExpanded = false;
  let isBusy = false;
  let hasActiveStep = false;
  let currentStatus = "idle";
  let baseAgentStatus = "idle";
  let transientWidgetState = "idle";
  let assistantMode = "";
  let currentPlan = null;
  let currentBrowserExecution = null;
  let lastBrowserExecutionSnapshot = null;
  let resizeFrame = null;
  let lastRequestedHeight = 0;
  let expandAfterBrowserExecution = false;

  function formatPlainSummary(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "  ")
      .replace(/```[\w]*\n([\s\S]*?)```/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1")
      .trim();
  }

  const BLINK_ASSETS = [
    "assets/logo.png",
    "assets/half-opened.png",
    "assets/full-closed.png",
    "assets/half-opened.png",
    "assets/logo.png",
  ];

  function isActiveBrowserExecution(browserExecution) {
    return Boolean(browserExecution) && !TERMINAL_BROWSER_STATUSES.has(browserExecution.status);
  }

  function getBrowserExecutionName(browserExecution) {
    const pluginId = String(
      browserExecution?.pluginId
      || browserExecution?.pluginName
      || browserExecution?.pluginType
      || "browser",
    ).toLowerCase();

    if (pluginId.includes("desktop")) {
      return "desktop";
    }
    if (pluginId.includes("cli")) {
      return "cli";
    }
    return "browser";
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

  function truncateText(text, maxLength) {
    const value = String(text || "").trim().replace(/\s+/g, " ");
    if (!value) {
      return "";
    }
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  }

  function startBlinkLoop() {
    const delay = 3000 + Math.random() * 3000;
    window.setTimeout(() => executeBlink(0), delay);
  }

  function executeBlink(index) {
    if (index >= BLINK_ASSETS.length) {
      startBlinkLoop();
      return;
    }

    dom.statusLogo.src = BLINK_ASSETS[index];
    window.setTimeout(() => executeBlink(index + 1), 80);
  }

  function renderStep(plan) {
    currentPlan = plan || null;
    if (currentBrowserExecution) {
      hasActiveStep = false;
      dom.goalText.textContent = truncateText(currentBrowserExecution.goal || "Browser task", 30);
      dom.browserProgress.textContent = `step ${getCurrentBrowserStepNumber(currentBrowserExecution)}`;
      dom.btnOpenChat.classList.add("hidden");
      updateActionButtons();
      scheduleExpandedHeightSync();
      return;
    }

    const step = plan?.steps?.[plan.currentStepIndex];
    hasActiveStep = Boolean(step);

    dom.goalText.textContent = plan?.goal || (assistantMode === "fast" ? "Fast Mode" : "No active plan");
    dom.browserProgress.classList.add("hidden");
    dom.stepTitle.textContent = step?.title || "Waiting for a task";
    dom.stepInstruction.textContent = step?.instruction || "Ask for a goal and I will create a step-by-step plan.";
    dom.stepProgress.textContent = step ? `${plan.currentStepIndex + 1}/${plan.steps.length}` : "0/0";
    dom.btnOpenChat.classList.toggle("hidden", hasActiveStep);

    updateActionButtons();
    scheduleExpandedHeightSync();
  }

  function applyBrowserExecution(browserExecution) {
    currentBrowserExecution = isActiveBrowserExecution(browserExecution) ? browserExecution : null;
    const browserExecutionActive = Boolean(currentBrowserExecution);
    dom.widget.classList.toggle("browser-exec-active", browserExecutionActive);
    dom.browserProgress.classList.toggle("hidden", !browserExecutionActive);
    dom.btnShowPlan.classList.toggle("hidden", browserExecutionActive);
    dom.stepCard?.classList.toggle("hidden", browserExecutionActive);
    if (browserExecutionActive && isExpanded) {
      expandAfterBrowserExecution = true;
      void setExpanded(false);
    } else if (!browserExecutionActive && expandAfterBrowserExecution) {
      expandAfterBrowserExecution = false;
      void setExpanded(true);
    }
    renderStep(currentPlan);
    updateStatusDisplay(currentStatus);
  }

  function applyAssistantMode(nextMode) {
    assistantMode = nextMode === "fast" ? "fast" : (nextMode === "planning" ? "planning" : "");
    const fastModeEnabled = assistantMode === "fast";
    dom.btnShowPlan.disabled = fastModeEnabled;
    dom.btnShowPlan.title = fastModeEnabled ? "Show plan is disabled in Fast mode" : "Show plan";
    if (fastModeEnabled && isExpanded) {
      setExpanded(false);
    }
    renderStep(currentPlan);
  }

  function setBusy(nextBusy) {
    isBusy = Boolean(nextBusy);
    dom.loader.classList.toggle("hidden", !isBusy);
    updateActionButtons();
  }

  function updateActionButtons() {
    const disabled = Boolean(currentBrowserExecution) || !hasActiveStep || isBusy || currentStatus !== "waiting_user";
    dom.btnDone.disabled = disabled;
    dom.btnPrev.disabled = disabled;
    dom.btnSkip.disabled = disabled;
    dom.btnHelp.disabled = disabled;
    dom.btnRegenerate.disabled = disabled;
    dom.btnRecheck.disabled = disabled;
    dom.btnCancelPlan.disabled = disabled;
  }

  function updateStatusDisplay(nextStatus) {
    currentStatus = nextStatus || "idle";
    const displayStatus = currentBrowserExecution
      ? getBrowserExecutionName(currentBrowserExecution)
      : currentStatus;
    dom.statusText.textContent = displayStatus.replace(/_/g, " ");
    dom.statusText.dataset.status = displayStatus;
    dom.statusText.classList.toggle("browser-status-pulse", Boolean(currentBrowserExecution));
    updateActionButtons();
    scheduleExpandedHeightSync();
  }

  function updateBrowserProgress(stepNumber) {
    if (!currentBrowserExecution) {
      return;
    }
    dom.browserProgress.textContent = `step ${Math.max(0, Number(stepNumber) || 0)}`;
  }

  function flashCompletionLogo() {
    dom.statusLogo.classList.remove("completion-flash");
    void dom.statusLogo.offsetWidth;
    dom.statusLogo.classList.add("completion-flash");
    window.setTimeout(() => dom.statusLogo.classList.remove("completion-flash"), 420);
  }

  function scheduleExpandedHeightSync() {
    if (!isExpanded) {
      return;
    }

    if (resizeFrame) {
      window.cancelAnimationFrame(resizeFrame);
    }

    resizeFrame = window.requestAnimationFrame(async () => {
      resizeFrame = null;
      const measuredHeight = Math.ceil(dom.widget.scrollHeight + 4);
      if (Math.abs(measuredHeight - lastRequestedHeight) < 2) {
        return;
      }
      lastRequestedHeight = measuredHeight;
      await api.invoke("set-widget-height", measuredHeight);
    });
  }

  async function runAction(action) {
    if (isBusy || !hasActiveStep || currentStatus !== "waiting_user") {
      return;
    }

    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  async function setExpanded(nextExpanded) {
    isExpanded = Boolean(nextExpanded);
    dom.widget.classList.toggle("expanded", isExpanded);
    dom.details.classList.toggle("hidden", !isExpanded);
    dom.btnShowPlan.classList.toggle("expanded", isExpanded);
    await api.invoke("set-widget-expanded", isExpanded);
    if (isExpanded) {
      scheduleExpandedHeightSync();
    }
  }

  function bindEvents() {
    dom.btnExpand.addEventListener("click", (event) => {
      event.stopPropagation();
      api.invoke("show-main");
    });

    dom.btnShowPlan.addEventListener("click", (event) => {
      event.stopPropagation();
      setExpanded(!isExpanded);
    });

    dom.btnOpenChat.addEventListener("click", () => {
      api.invoke("show-main");
    });

    dom.btnDone.addEventListener("click", () => {
      runAction(() => api.invoke("mark-step-done"));
    });

    dom.btnPrev.addEventListener("click", () => {
      runAction(() => api.invoke("previous-step"));
    });

    dom.btnSkip.addEventListener("click", () => {
      runAction(() => api.invoke("skip-current-step"));
    });

    dom.btnHelp.addEventListener("click", () => {
      runAction(() => api.invoke("request-step-help"));
    });

    dom.btnRegenerate.addEventListener("click", () => {
      runAction(() => api.invoke("regenerate-current-step"));
    });

    dom.btnRecheck.addEventListener("click", () => {
      runAction(() => api.invoke("recheck-current-step"));
    });

    dom.btnCancelPlan.addEventListener("click", () => {
      runAction(() => api.invoke("cancel-active-plan"));
    });
  }

  function bindIPC() {
    function clearWidgetStateClasses() {
      dom.widget.classList.remove("listening", "thinking", "speaking");
    }

    function mapAgentStatusToVisualState(status) {
      switch (status) {
        case "planning":
        case "executing":
        case "evaluating":
        case "thinking":
          return "thinking";
        case "responding":
          return "speaking";
        default:
          return "idle";
      }
    }

    function mapTransientStateToStatus(state) {
      if (state === "speaking") {
        return "responding";
      }
      return state;
    }

    function applyWidgetState(state) {
      clearWidgetStateClasses();
      if (state && state !== "idle") {
        dom.widget.classList.add(state);
      }
    }

    function syncFromAgentStatus(state) {
      baseAgentStatus = state || "idle";
      if (transientWidgetState !== "idle") {
        return;
      }
      applyWidgetState(mapAgentStatusToVisualState(baseAgentStatus));
      updateStatusDisplay(baseAgentStatus);
    }

    function syncFromTransientState(state) {
      transientWidgetState = state || "idle";
      if (transientWidgetState === "idle") {
        applyWidgetState(mapAgentStatusToVisualState(baseAgentStatus));
        updateStatusDisplay(baseAgentStatus);
        return;
      }
      applyWidgetState(transientWidgetState);
      updateStatusDisplay(mapTransientStateToStatus(transientWidgetState));
    }

    api.on("state-change", (state) => {
      syncFromTransientState(state || "idle");
    });

    api.on("agent-state-changed", (state) => {
      syncFromAgentStatus(state || "idle");
    });

    api.on("plan-updated", (plan) => {
      renderStep(plan);
    });

    api.on("session-updated", (snapshot) => {
      setBusy(false);
      const nextBrowserExecution = snapshot?.browserExecution || null;
      const wasActive = isActiveBrowserExecution(lastBrowserExecutionSnapshot);
      const isActive = isActiveBrowserExecution(nextBrowserExecution);
      applyBrowserExecution(nextBrowserExecution);
      if (wasActive && !isActive && nextBrowserExecution?.status && TERMINAL_BROWSER_STATUSES.has(nextBrowserExecution.status)) {
        flashCompletionLogo();
      }
      lastBrowserExecutionSnapshot = nextBrowserExecution;
      renderStep(snapshot?.activePlan || currentPlan);
    });

    api.on("execution:substep-progress", (substep) => {
      updateBrowserProgress(substep?.stepNumber || getCurrentBrowserStepNumber(currentBrowserExecution));
    });

    api.on("settings-changed", (settings) => {
      applyAssistantMode(settings?.assistantMode || "");
    });
  }

  async function init() {
    bindEvents();
    bindIPC();
    await setExpanded(false);
    api.send("widget-loaded");
    const settings = await api.invoke("get-settings");
    applyAssistantMode(settings?.assistantMode || "");
    const session = await api.invoke("get-active-session");
    lastBrowserExecutionSnapshot = session?.browserExecution || null;
    applyBrowserExecution(session?.browserExecution || null);
    renderStep(session?.activePlan || null);
    updateStatusDisplay(session?.status || "idle");
    setBusy(false);
    startBlinkLoop();
  }

  return {
    init,
    renderStep,
  };
}
