export function createPlanView({ doc = document, dom }) {
  let browserTaskShell = null;
  let browserTaskHeaderGoal = null;
  let browserTaskHeaderMeta = null;
  let browserTaskList = null;
  let browserTaskSummary = null;
  let browserTaskKey = null;
  let browserRowMap = new Map();

  function normalizeRichText(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "  ");
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderRichTextHtml(text) {
    const placeholders = [];
    const stash = (html) => {
      const key = `@@PLAN_HTML_${placeholders.length}@@`;
      placeholders.push({ key, html });
      return key;
    };

    let rendered = escapeHtml(normalizeRichText(text))
      .replace(/```[\w]*\n([\s\S]*?)```/g, (_match, code) => stash(`<pre><code>${code}</code></pre>`))
      .replace(/`([^`]+)`/g, (_match, code) => stash(`<code>${code}</code>`))
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
        return stash(`<a class="message-link" href="${url}" data-external-link="1">${label}</a>`);
      });

    rendered = rendered
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/^### (.+)$/gm, "<strong>$1</strong>")
      .replace(/^## (.+)$/gm, "<strong>$1</strong>")
      .replace(/^# (.+)$/gm, "<strong>$1</strong>")
      .replace(/^[\*\-] (.+)$/gm, "<li>$1</li>")
      .replace(/(<li>.*<\/li>)/gs, "<ul>$1</ul>")
      .replace(/\n\n/g, "</p><p>")
      .replace(/\n/g, "<br/>")
      .replace(/^(?!<)(.+?)(?=$)/gm, "<p>$1</p>");

    placeholders.forEach(({ key, html }) => {
      rendered = rendered.replaceAll(key, html);
    });
    return rendered;
  }

  function renderPlan(plan) {
    if (!dom.planPanel || !dom.planSteps || !dom.planGoal || !dom.planProgress) {
      return;
    }

    if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
      dom.planPanel.classList.add("hidden");
      dom.planSteps.innerHTML = "";
      dom.planGoal.textContent = "";
      dom.planProgress.textContent = "";
      return;
    }

    dom.planPanel.classList.remove("hidden");
    dom.planGoal.textContent = plan.goal || "Active plan";
    dom.planProgress.textContent = `${Math.min(plan.currentStepIndex + 1, plan.steps.length)}/${plan.steps.length}`;
    dom.planSteps.innerHTML = "";

    plan.steps.forEach((step, index) => {
      const item = doc.createElement("div");
      item.className = `plan-step ${step.status || "pending"}`;

      const badge = doc.createElement("span");
      badge.className = "plan-step-badge";
      badge.textContent = `${index + 1}`;

      const body = doc.createElement("div");
      body.className = "plan-step-body";

      const title = doc.createElement("div");
      title.className = "plan-step-title";
      title.textContent = step.title;

      const instruction = doc.createElement("div");
      instruction.className = "plan-step-instruction";
      instruction.textContent = step.instruction;

      body.appendChild(title);
      body.appendChild(instruction);
      item.appendChild(badge);
      item.appendChild(body);
      dom.planSteps.appendChild(item);
    });
  }

  function ensureBrowserTaskShell() {
    if (!dom.browserTaskView) {
      return false;
    }
    if (browserTaskShell) {
      return true;
    }

    dom.browserTaskView.innerHTML = "";
    browserTaskShell = doc.createElement("div");
    browserTaskShell.className = "browser-task-shell";

    const header = doc.createElement("div");
    header.className = "browser-task-header";

    browserTaskHeaderGoal = doc.createElement("div");
    browserTaskHeaderGoal.className = "browser-task-goal";

    browserTaskHeaderMeta = doc.createElement("div");
    browserTaskHeaderMeta.className = "browser-task-meta";

    browserTaskList = doc.createElement("div");
    browserTaskList.className = "browser-task-list";

    browserTaskSummary = doc.createElement("div");
    browserTaskSummary.className = "browser-task-summary hidden";

    header.appendChild(browserTaskHeaderGoal);
    header.appendChild(browserTaskHeaderMeta);
    browserTaskShell.appendChild(header);
    browserTaskShell.appendChild(browserTaskList);
    browserTaskShell.appendChild(browserTaskSummary);
    dom.browserTaskView.appendChild(browserTaskShell);
    return true;
  }

  function clearBrowserExecution() {
    browserTaskKey = null;
    browserRowMap = new Map();
    browserTaskShell = null;
    browserTaskHeaderGoal = null;
    browserTaskHeaderMeta = null;
    browserTaskList = null;
    browserTaskSummary = null;
    if (dom.browserTaskView) {
      dom.browserTaskView.innerHTML = "";
      dom.browserTaskView.classList.add("hidden");
    }
  }

  function getBrowserExecutionKey(browserExecution) {
    return `${browserExecution?.taskId || ""}::${browserExecution?.startedAt || ""}`;
  }

  function getSubstepKey(substep, fallbackIndex = 0) {
    return String(substep?.stepNumber || substep?.id || `substep_${fallbackIndex + 1}`);
  }

  function formatExecutionMeta(browserExecution) {
    const parts = [];
    if (browserExecution?.pluginName || browserExecution?.pluginId) {
      parts.push(String(browserExecution.pluginName || browserExecution.pluginId || "Browser"));
    }
    if (browserExecution?.trustLevel) {
      const trustLabels = {
        paranoid: "Paranoid",
        balanced: "Supervised",
        autopilot: "Autopilot",
      };
      parts.push(trustLabels[browserExecution.trustLevel] || browserExecution.trustLevel);
    }
    if (browserExecution?.status) {
      const normalizedStatus = String(browserExecution.status)
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase());
      parts.push(normalizedStatus);
    }
    return parts.join(" · ");
  }

  function createStatusIndicator(status) {
    const indicator = doc.createElement("span");
    indicator.className = "browser-task-status";
    updateStatusIndicator(indicator, status);
    return indicator;
  }

  function updateStatusIndicator(indicator, status) {
    indicator.className = "browser-task-status";
    indicator.innerHTML = "";

    if (status === "running") {
      const spinner = doc.createElement("span");
      spinner.className = "browser-task-spinner";
      indicator.appendChild(spinner);
      return;
    }

    indicator.textContent = status === "failed" ? "X" : "✓";
  }

  function applyRowStatus(row, status) {
    row.classList.remove("is-running", "is-done", "is-failed");
    if (status === "running") {
      row.classList.add("is-running");
    } else if (status === "failed") {
      row.classList.add("is-failed");
    } else {
      row.classList.add("is-done");
    }
  }

  function createSubstepRow(substep, index) {
    const row = doc.createElement("div");
    row.className = "browser-task-item";
    row.dataset.stepKey = getSubstepKey(substep, index);

    const stepNumber = doc.createElement("div");
    stepNumber.className = "browser-task-step-number";
    stepNumber.textContent = String(substep.stepNumber || index + 1).padStart(2, "0");

    const body = doc.createElement("div");
    body.className = "browser-task-body";

    const topLine = doc.createElement("div");
    topLine.className = "browser-task-line";

    const actionType = doc.createElement("span");
    actionType.className = "browser-task-action";

    const description = doc.createElement("span");
    description.className = "browser-task-description";

    const detail = doc.createElement("div");
    detail.className = "browser-task-detail hidden";

    topLine.appendChild(actionType);
    topLine.appendChild(description);
    body.appendChild(topLine);
    body.appendChild(detail);

    const statusIndicator = createStatusIndicator(substep.status);

    row.appendChild(stepNumber);
    row.appendChild(body);
    row.appendChild(statusIndicator);

    updateSubstepRow({
      row,
      stepNumber,
      actionType,
      description,
      detail,
      statusIndicator,
    }, substep, index);

    return {
      row,
      stepNumber,
      actionType,
      description,
      detail,
      statusIndicator,
    };
  }

  function updateSubstepRow(refs, substep, index = 0) {
    refs.row.dataset.stepKey = getSubstepKey(substep, index);
    refs.stepNumber.textContent = String(substep.stepNumber || index + 1).padStart(2, "0");
    refs.actionType.textContent = (substep.actionType || "action").replace(/_/g, " ");
    refs.description.textContent = substep.description || "Browser action";
    applyRowStatus(refs.row, substep.status);
    updateStatusIndicator(refs.statusIndicator, substep.status);

    const detailText = substep.error || substep.message || "";
    refs.detail.textContent = detailText;
    refs.detail.classList.toggle("hidden", !detailText);
  }

  function syncBrowserExecution(browserExecution) {
    if (!browserExecution) {
      clearBrowserExecution();
      return;
    }

    if (!ensureBrowserTaskShell()) {
      return;
    }

    const nextKey = getBrowserExecutionKey(browserExecution);
    if (browserTaskKey !== nextKey) {
      clearBrowserExecution();
      ensureBrowserTaskShell();
      browserTaskKey = nextKey;
    }

    dom.browserTaskView.classList.remove("hidden");
    browserTaskHeaderGoal.textContent = browserExecution.goal || "Browser task";
    browserTaskHeaderMeta.textContent = formatExecutionMeta(browserExecution);

    const substeps = Array.isArray(browserExecution.substeps) ? browserExecution.substeps : [];
    substeps.forEach((substep, index) => {
      const substepKey = getSubstepKey(substep, index);
      const existing = browserRowMap.get(substepKey);
      if (existing) {
        updateSubstepRow(existing, substep, index);
        return;
      }

      const refs = createSubstepRow(substep, index);
      browserRowMap.set(substepKey, refs);
      browserTaskList.appendChild(refs.row);
    });

    const isFinished = browserExecution.status === "success"
      || browserExecution.status === "failed"
      || browserExecution.status === "aborted";
    if (!isFinished) {
      browserTaskSummary.className = "browser-task-summary hidden";
      browserTaskSummary.textContent = "";
      return;
    }

    browserTaskSummary.className = "browser-task-summary";
    browserTaskSummary.classList.add(browserExecution.status === "success" ? "is-success" : "is-failed");
    browserTaskSummary.innerHTML = renderRichTextHtml(browserExecution.finalMessage || (
      browserExecution.status === "success"
        ? "Task completed successfully."
        : "Task finished with issues."
    ));
  }

  function renderBrowserExecution(browserExecution) {
    syncBrowserExecution(browserExecution);
  }

  return {
    clearBrowserExecution,
    renderBrowserExecution,
    renderPlan,
    syncBrowserExecution,
  };
}
