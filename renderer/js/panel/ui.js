const PROVIDER_COLORS = {
  groq: "#f97316",
  claude: "#f59e0b",
  openrouter: "#10a37f",
  openai: "#10b981",
  gemini: "#3b82f6",
  ollama: "#a855f7",
};

const BLINK_ASSETS = [
  "assets/logo.png",
  "assets/half-opened.png",
  "assets/full-closed.png",
  "assets/half-opened.png",
  "assets/logo.png",
];

export function queryPanelDom(doc = document) {
  return {
    panelRoot: doc.querySelector(".panel"),
    agentStatus: doc.getElementById("agent-status"),
    assistantModeSelect: doc.getElementById("assistant-mode-select"),
    modeBar: doc.getElementById("mode-bar"),
    modeBarPlugin: doc.getElementById("mode-bar-plugin"),
    modeBarTrust: doc.getElementById("mode-bar-trust"),
    modeBarStep: doc.getElementById("mode-bar-step"),
    browserTaskView: doc.getElementById("browser-task-view"),
    stepApprovalSection: doc.getElementById("step-approval-section"),
    stepApprovalCard: doc.getElementById("step-approval-card"),
    chatArea: doc.getElementById("chat-area"),
    chatMessages: doc.getElementById("chat-messages"),
    chatBackground: doc.getElementById("chat-background"),
    chatBackgroundLogo: doc.getElementById("chat-background-logo"),
    textInput: doc.getElementById("text-input"),
    sendBtn: doc.getElementById("send-btn"),
    modelSelect: doc.getElementById("model-select"),
    providerDot: doc.getElementById("provider-dot"),
    pttBtn: doc.getElementById("ptt-btn"),
    waveform: doc.getElementById("waveform"),
    btnSettings: doc.getElementById("btn-settings"),
    btnClose: doc.getElementById("btn-close"),
    btnClear: doc.getElementById("btn-clear"),
    planGoal: doc.getElementById("plan-goal"),
    planPanel: doc.getElementById("plan-panel"),
    panelActions: doc.getElementById("panel-actions"),
    planProgress: doc.getElementById("plan-progress"),
    planSteps: doc.getElementById("plan-steps"),
    btnPlanDone: doc.getElementById("btn-plan-done"),
    btnPlanPrev: doc.getElementById("btn-plan-prev"),
    btnPlanSkip: doc.getElementById("btn-plan-skip"),
    btnPlanHelp: doc.getElementById("btn-plan-help"),
    btnPlanRegenerate: doc.getElementById("btn-plan-regenerate"),
    btnPlanRecheck: doc.getElementById("btn-plan-recheck"),
    btnPlanCancel: doc.getElementById("btn-plan-cancel"),
    errorBanner: doc.getElementById("error-banner"),
    errorBannerTitle: doc.getElementById("error-banner-title"),
    errorBannerMessage: doc.getElementById("error-banner-message"),
    errorBannerRequest: doc.getElementById("error-banner-request"),
    errorBannerAction: doc.getElementById("error-banner-action"),
    errorBannerDismiss: doc.getElementById("error-banner-dismiss"),
    onboardingOverlay: doc.getElementById("onboarding-overlay"),
    onboardingOpenSettings: doc.getElementById("onboarding-open-settings"),
    confirmOverlay: doc.getElementById("confirm-overlay"),
    confirmMessage: doc.getElementById("confirm-message"),
    confirmCancel: doc.getElementById("confirm-cancel"),
    confirmConfirm: doc.getElementById("confirm-confirm"),
    toast: doc.getElementById("toast"),
  };
}

export function createPanelUI({ api, doc = document, dom, log, state }) {
  function normalizeUrl(url) {
    const trimmed = String(url || "").trim();
    if (!trimmed) {
      return "";
    }
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }
    if (/^www\./i.test(trimmed)) {
      return `https://${trimmed}`;
    }
    return "";
  }

  function buildLink(url, label) {
    const href = normalizeUrl(url);
    if (!href) {
      return label;
    }
    return `<a class="message-link" href="${href}" data-external-link="1">${label}</a>`;
  }

  function linkifyText(text) {
    return text.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<]+)/gim, (full, prefix, candidate) => {
      let raw = candidate;
      let trailing = "";
      while (/[),.!?:;]$/.test(raw)) {
        trailing = raw.slice(-1) + trailing;
        raw = raw.slice(0, -1);
      }
      const anchor = buildLink(raw, raw);
      return `${prefix}${anchor}${trailing}`;
    });
  }

  function makeCopyButton(messageElement) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "copy-icon-btn";
    button.title = "Copy response";
    button.setAttribute("aria-label", "Copy response");
    button.textContent = "⧉";

    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const text = messageElement.dataset.copyText || "";
      if (!text) {
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        button.classList.add("copied");
        showToast("Copied");
        window.setTimeout(() => button.classList.remove("copied"), 700);
      } catch (error) {
        showToast("Copy failed", true);
      }
    });

    return button;
  }

  function splitThinkingText(text, collapseThinking = false) {
    const source = String(text || "");
    const thoughtParts = [];

    let visibleText = source.replace(/<think>([\s\S]*?)<\/think>/gi, (_match, part) => {
      if (part && part.trim()) {
        thoughtParts.push(part.trim());
      }
      return "";
    });

    if (collapseThinking) {
      const keptLines = [];
      for (const line of visibleText.split("\n")) {
        if (/^\s*(thinking|reasoning|analysis|thought process)\s*[:\-]/i.test(line)) {
          const cleaned = line.replace(/^\s*(thinking|reasoning|analysis|thought process)\s*[:\-]\s*/i, "").trim();
          if (cleaned) {
            thoughtParts.push(cleaned);
          }
          continue;
        }
        keptLines.push(line);
      }
      visibleText = keptLines.join("\n");
    }

    return {
      visibleText: visibleText.trim(),
      thinkingText: thoughtParts.join("\n\n").trim(),
    };
  }

  function buildAssistantMeta(messageElement) {
    const meta = doc.createElement("span");
    meta.className = "msg-meta";

    const time = doc.createElement("span");
    time.textContent = new Date().toLocaleString([], {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

    const badge = doc.createElement("span");
    badge.className = "msg-badge";
    badge.textContent = "AI";

    const actions = doc.createElement("span");
    actions.className = "assistant-meta-actions";
    actions.appendChild(makeCopyButton(messageElement));

    meta.appendChild(time);
    meta.appendChild(badge);
    meta.appendChild(actions);
    return meta;
  }

  function applyAssistantContent({ messageElement, bubble, text, collapseThinking = false }) {
    const { visibleText, thinkingText } = splitThinkingText(text, collapseThinking);
    bubble.innerHTML = simpleMarkdown(visibleText || "...");
    messageElement.dataset.copyText = visibleText || "";

    const existingThinking = messageElement.querySelector(".thinking-box");
    if (existingThinking) {
      existingThinking.remove();
    }

    if (collapseThinking && thinkingText) {
      const details = doc.createElement("details");
      details.className = "thinking-box";

      const summary = doc.createElement("summary");
      summary.textContent = "Thinking";
      details.appendChild(summary);

      const content = doc.createElement("div");
      content.className = "thinking-content";
      content.innerHTML = simpleMarkdown(thinkingText);
      details.appendChild(content);

      messageElement.appendChild(details);
    }
  }

  function startBackgroundBlinkLoop() {
    if (!dom.chatBackgroundLogo) {
      return;
    }
    const delay = 3000 + Math.random() * 2000;
    window.setTimeout(() => executeBackgroundBlink(0), delay);
  }

  function executeBackgroundBlink(index) {
    if (!dom.chatBackgroundLogo) {
      return;
    }
    if (index >= BLINK_ASSETS.length) {
      startBackgroundBlinkLoop();
      return;
    }
    dom.chatBackgroundLogo.src = BLINK_ASSETS[index];
    window.setTimeout(() => executeBackgroundBlink(index + 1), 80);
  }

  function updateChatBackgroundState(messageCount) {
    const hasMessages = messageCount > 0;
    dom.chatArea.classList.toggle("has-messages", hasMessages);
  }

  function buildModelSelector() {
    const settings = state.getSettings();
    const provider = settings.aiProvider || "claude";
    const customKey = provider + "ModelCustom";
    const savedModel = settings[customKey] || settings.aiModel || "";

    dom.modelSelect.innerHTML = "";

    if (savedModel) {
      const option = doc.createElement("option");
      option.value = savedModel;
      option.textContent = savedModel;
      dom.modelSelect.appendChild(option);
      dom.modelSelect.value = savedModel;
    } else {
      const option = doc.createElement("option");
      option.value = "";
      option.textContent = "— Configure model in Settings —";
      option.disabled = true;
      option.selected = true;
      dom.modelSelect.appendChild(option);
    }

    if (provider === "ollama") {
      api.invoke("get-ollama-models").then((ollamaModels) => {
        if (ollamaModels && ollamaModels.length > 0) {
          dom.modelSelect.innerHTML = "";
          for (const modelName of ollamaModels) {
            const option = doc.createElement("option");
            option.value = modelName;
            option.textContent = modelName;
            dom.modelSelect.appendChild(option);
          }

          if (savedModel && ollamaModels.includes(savedModel)) {
            dom.modelSelect.value = savedModel;
          } else {
            dom.modelSelect.value = ollamaModels[0];
            state.setSetting("aiModel", ollamaModels[0]);
          }
        }
      }).catch((error) => {
        log("ipc:get-ollama-models error", error);
      });
    }
  }

  function updateProviderDot() {
    const provider = state.getSetting("aiProvider") || "claude";
    dom.providerDot.style.background = PROVIDER_COLORS[provider] || "#64748b";
    dom.providerDot.title = provider;
  }

  function appendUserMessage(text, images) {
    const messageElement = doc.createElement("div");
    messageElement.className = "message user";

    const bubble = doc.createElement("div");
    bubble.className = "bubble";

    if (images && images.length > 0) {
      const image = doc.createElement("img");
      image.className = "screenshot-thumb";
      image.src = `data:image/jpeg;base64,${images[0].base64Jpeg}`;
      bubble.appendChild(image);
    }

    const paragraph = doc.createElement("p");
    paragraph.textContent = text;
    bubble.appendChild(paragraph);

    const meta = doc.createElement("span");
    meta.className = "msg-meta";
    meta.textContent = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    messageElement.appendChild(bubble);
    messageElement.appendChild(meta);
    dom.chatMessages.appendChild(messageElement);
    updateChatBackgroundState(dom.chatMessages.childElementCount);
    scrollToBottom();
  }

  function appendAssistantMessage(text) {
    const collapseThinking = state.getSetting("assistantMode") === "planning";
    const messageElement = doc.createElement("div");
    messageElement.className = "message assistant";

    const bubble = doc.createElement("div");
    bubble.className = "bubble";
    applyAssistantContent({
      messageElement,
      bubble,
      text,
      collapseThinking,
    });

    messageElement.appendChild(bubble);
    messageElement.appendChild(buildAssistantMeta(messageElement));
    dom.chatMessages.appendChild(messageElement);
    updateChatBackgroundState(dom.chatMessages.childElementCount);
    scrollToBottom();

    return { el: messageElement, bubble };
  }

  async function streamAssistantMessage(text, { collapseThinking = false } = {}) {
    const messageElement = doc.createElement("div");
    messageElement.className = "message assistant";

    const bubble = doc.createElement("div");
    bubble.className = "bubble";
    messageElement.appendChild(bubble);
    messageElement.appendChild(buildAssistantMeta(messageElement));
    dom.chatMessages.appendChild(messageElement);
    updateChatBackgroundState(dom.chatMessages.childElementCount);

    const { visibleText } = splitThinkingText(text, collapseThinking);
    const targetText = visibleText || "...";
    const step = Math.max(2, Math.ceil(targetText.length / 80));
    let cursor = 0;

    while (cursor < targetText.length) {
      cursor = Math.min(targetText.length, cursor + step);
      bubble.innerHTML = simpleMarkdown(targetText.slice(0, cursor));
      scrollToBottom();
      // Small delay for perceived streaming.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => window.setTimeout(resolve, 12));
    }

    applyAssistantContent({
      messageElement,
      bubble,
      text,
      collapseThinking,
    });
    scrollToBottom();
    return { el: messageElement, bubble };
  }

  function appendErrorMessage(message) {
    const element = doc.createElement("div");
    element.className = "message assistant";
    element.innerHTML = `<div class="bubble" style="border-color:rgba(239,68,68,0.3);color:#fca5a5">⚠ ${escapeHtml(message)}</div>`;
    dom.chatMessages.appendChild(element);
    updateChatBackgroundState(dom.chatMessages.childElementCount);
    scrollToBottom();
  }

  function appendRawElement(element) {
    dom.chatMessages.appendChild(element);
    updateChatBackgroundState(dom.chatMessages.childElementCount);
    scrollToBottom();
  }

  function injectSystemNotice(text, type = "info", options = {}) {
    if (!dom.chatMessages) {
      return null;
    }

    const notice = doc.createElement("div");
    notice.className = `system-notice system-notice-${type}`;
    if (options?.richText) {
      notice.classList.add("system-notice-rich");
    }

    const textNode = doc.createElement("span");
    textNode.className = "system-notice-text";
    if (options?.richText) {
      textNode.innerHTML = simpleMarkdown(text);
    } else {
      textNode.textContent = text;
    }

    notice.appendChild(textNode);
    dom.chatMessages.appendChild(notice);
    updateChatBackgroundState(dom.chatMessages.childElementCount);
    scrollToBottom();
    return notice;
  }

  function showTypingIndicator() {
    const id = state.nextTypingId();
    const element = doc.createElement("div");
    element.className = "message assistant";
    element.id = `typing-${id}`;
    element.innerHTML = `<div class="typing-indicator"><span></span><span></span><span></span></div>`;
    dom.chatMessages.appendChild(element);
    updateChatBackgroundState(dom.chatMessages.childElementCount);
    scrollToBottom();
    return id;
  }

  function removeTypingIndicator(id) {
    const element = doc.getElementById(`typing-${id}`);
    if (element) {
      element.remove();
    }
  }

  function removeAllTypingIndicators() {
    doc.querySelectorAll('[id^="typing-"]').forEach((element) => element.remove());
  }

  function clearConversation() {
    renderConversation([]);
  }

  function renderConversation(messages) {
    dom.chatMessages.innerHTML = "";

    if (!Array.isArray(messages) || messages.length === 0) {
      updateChatBackgroundState(0);
      return;
    }

    messages.forEach((message) => {
      if (message.role === "user") {
        appendUserMessage(message.content);
      } else {
        appendAssistantMessage(message.content);
      }
    });
    updateChatBackgroundState(dom.chatMessages.childElementCount);
  }

  function renderAgentState(nextState) {
    if (!dom.agentStatus) {
      return;
    }

    const value = nextState || "idle";
    dom.agentStatus.textContent = value.replace(/_/g, " ");
    dom.agentStatus.dataset.state = value;
  }

  function scrollToBottom() {
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
  }

  function simpleMarkdown(text) {
    const placeholders = [];
    const stash = (html) => {
      const key = `@@HTML${placeholders.length}@@`;
      placeholders.push({ key, html });
      return key;
    };

    let rendered = String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "  ")
      .replace(/\[POINT:[^\]]+\]/gi, "")
      .replace(/\{[^{}]*"point"\s*:\s*\[\d+,\s*\d+\][^{}]*"label"\s*:\s*"[^"]+"[^{}]*\}/gi, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/```[\w]*\n([\s\S]*?)```/g, (_match, code) => stash(`<pre><code>${code}</code></pre>`))
      .replace(/`([^`]+)`/g, (_match, code) => stash(`<code>${code}</code>`))
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
        return stash(buildLink(url, label));
      });

    rendered = linkifyText(rendered)
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

  function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function showToast(message, isError = false) {
    dom.toast.textContent = message;
    dom.toast.classList.remove("hidden");
    dom.toast.style.borderColor = isError ? "rgba(239,68,68,0.4)" : "";
    dom.toast.style.color = isError ? "#fca5a5" : "";

    clearTimeout(state.getToastTimer());
    state.setToastTimer(
      window.setTimeout(() => dom.toast.classList.add("hidden"), 3000),
    );
  }

  function hideErrorBanner() {
    if (!dom.errorBanner) {
      return;
    }
    dom.errorBanner.classList.add("hidden");
  }

  function showErrorBanner({
    title = "Something went wrong",
    message = "Unknown error",
    requestId = "",
    actionLabel = "Open settings",
    onAction = null,
  } = {}) {
    if (!dom.errorBanner) {
      showToast(message, true);
      return;
    }
    dom.errorBannerTitle.textContent = title;
    dom.errorBannerMessage.textContent = message;
    dom.errorBannerRequest.textContent = requestId ? `Request ID: ${requestId}` : "";
    dom.errorBannerAction.textContent = actionLabel;
    dom.errorBanner.classList.remove("hidden");

    dom.errorBannerAction.onclick = () => {
      if (typeof onAction === "function") {
        onAction();
      }
    };
    dom.errorBannerDismiss.onclick = () => {
      hideErrorBanner();
    };
  }

  function showOnboarding() {
    if (dom.onboardingOverlay) {
      dom.onboardingOverlay.classList.remove("hidden");
    }
  }

  function hideOnboarding() {
    if (dom.onboardingOverlay) {
      dom.onboardingOverlay.classList.add("hidden");
    }
  }

  function confirmClearConversation() {
    if (!dom.confirmOverlay || !dom.confirmCancel || !dom.confirmConfirm) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      dom.confirmMessage.textContent = "This will remove all chat history and active plan progress.";
      dom.confirmOverlay.classList.remove("hidden");
      dom.confirmConfirm.focus();

      let settled = false;

      function finish(result) {
        if (settled) {
          return;
        }
        settled = true;
        dom.confirmOverlay.classList.add("hidden");
        dom.confirmCancel.removeEventListener("click", onCancel);
        dom.confirmConfirm.removeEventListener("click", onConfirm);
        doc.removeEventListener("keydown", onKeydown);
        dom.confirmOverlay.removeEventListener("click", onBackdrop);
        resolve(result);
      }

      function onCancel() {
        finish(false);
      }

      function onConfirm() {
        finish(true);
      }

      function onBackdrop(event) {
        if (event.target === dom.confirmOverlay) {
          finish(false);
        }
      }

      function onKeydown(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        } else if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        }
      }

      dom.confirmCancel.addEventListener("click", onCancel);
      dom.confirmConfirm.addEventListener("click", onConfirm);
      dom.confirmOverlay.addEventListener("click", onBackdrop);
      doc.addEventListener("keydown", onKeydown);
    });
  }

  function startWaveformAnimation() {
    const bars = doc.querySelectorAll(".waveform-bar");
    const interval = window.setInterval(() => {
      bars.forEach((bar) => {
        bar.style.height = 4 + Math.random() * 10 + "px";
      });
    }, 100);
    state.setWaveInterval(interval);
  }

  function stopWaveformAnimation() {
    clearInterval(state.getWaveInterval());
    doc.querySelectorAll(".waveform-bar").forEach((bar) => {
      bar.style.height = "4px";
    });
  }

  dom.chatMessages.addEventListener("click", (event) => {
    const linkElement = event.target.closest("a[data-external-link]");
    if (!linkElement) {
      return;
    }
    event.preventDefault();
    const href = linkElement.getAttribute("href");
    const url = normalizeUrl(href);
    if (!url) {
      return;
    }
    api.invoke("open-external-link", url).catch((error) => {
      log("ipc:open-external-link error", error);
      showToast("Failed to open link", true);
    });
  });

  startBackgroundBlinkLoop();
  updateChatBackgroundState(0);

  return {
    applyAssistantContent,
    appendAssistantMessage,
    appendErrorMessage,
    injectSystemNotice,
    appendRawElement,
    appendUserMessage,
    buildModelSelector,
    clearConversation,
    escapeHtml,
    removeAllTypingIndicators,
    removeTypingIndicator,
    renderAgentState,
    renderConversation,
    scrollToBottom,
    showToast,
    showErrorBanner,
    hideErrorBanner,
    showOnboarding,
    hideOnboarding,
    confirmClearConversation,
    showTypingIndicator,
    simpleMarkdown,
    streamAssistantMessage,
    startWaveformAnimation,
    stopWaveformAnimation,
    updateProviderDot,
  };
}
