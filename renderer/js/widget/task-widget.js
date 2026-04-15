export function createTaskWidgetController({ api, doc = document }) {
  const dom = {
    details: doc.getElementById("widget-details"),
    widget: doc.getElementById("widget"),
    statusLogo: doc.getElementById("status-logo"),
    loader: doc.getElementById("widget-loader"),
    statusText: doc.getElementById("status-text"),
    goalText: doc.getElementById("goal-text"),
    stepTitle: doc.getElementById("step-title"),
    stepInstruction: doc.getElementById("step-instruction"),
    stepProgress: doc.getElementById("step-progress"),
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
  let resizeFrame = null;
  let lastRequestedHeight = 0;

  const BLINK_ASSETS = [
    "assets/logo.png",
    "assets/half-opened.png",
    "assets/full-closed.png",
    "assets/half-opened.png",
    "assets/logo.png",
  ];

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
    const step = plan?.steps?.[plan.currentStepIndex];
    hasActiveStep = Boolean(step);

    dom.goalText.textContent = plan?.goal || (assistantMode === "fast" ? "Fast Mode" : "No active plan");
    dom.stepTitle.textContent = step?.title || "Waiting for a task";
    dom.stepInstruction.textContent = step?.instruction || "Ask for a goal and I will create a step-by-step plan.";
    dom.stepProgress.textContent = step ? `${plan.currentStepIndex + 1}/${plan.steps.length}` : "0/0";
    dom.btnOpenChat.classList.toggle("hidden", hasActiveStep);

    updateActionButtons();
    scheduleExpandedHeightSync();
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
    const disabled = !hasActiveStep || isBusy || currentStatus !== "waiting_user";
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
    dom.statusText.textContent = currentStatus.replace(/_/g, " ");
    dom.statusText.dataset.status = currentStatus;
    updateActionButtons();
    scheduleExpandedHeightSync();
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

    api.on("session-updated", () => {
      setBusy(false);
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
