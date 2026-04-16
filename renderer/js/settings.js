// renderer/js/settings.js

let settings = {};
let activeProvider = "claude";
let recordingButton = null;

const toast = document.getElementById("toast");
let toastTimer;
function showToast(msg, isError) {
  toast.textContent = msg;
  toast.classList.remove("hidden");
  toast.style.borderColor = isError ? "rgba(239,68,68,0.4)" : "";
  toast.style.color       = isError ? "#fca5a5" : "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 3000);
}

async function init() {
  settings = await window.openguider.invoke("get-settings");

  // Provider dropdown
  activeProvider = settings.aiProvider || "claude";
  const providerSelect = document.getElementById("providerSelect");
  providerSelect.value = activeProvider;
  activateProvider(activeProvider);

  providerSelect.addEventListener("change", () => {
    activeProvider = providerSelect.value;
    activateProvider(activeProvider);
  });

  // Fill fields — AI Provider
  document.getElementById("claudeApiKey").value      = settings.claudeApiKey          || "";
  document.getElementById("claudeModel").value       = settings.claudeModelCustom     || "";
  document.getElementById("claudeBaseUrl").value     = settings.claudeBaseUrl         || "https://api.anthropic.com";
  document.getElementById("openaiApiKey").value      = settings.openaiApiKey          || "";
  document.getElementById("openaiModel").value       = settings.openaiModelCustom     || "";
  document.getElementById("openaiBaseUrl").value     = settings.openaiBaseUrl         || "https://api.openai.com/v1";
  document.getElementById("geminiApiKey").value      = settings.geminiApiKey          || "";
  document.getElementById("geminiModel").value       = settings.geminiModelCustom     || "";
  document.getElementById("geminiBaseUrl").value     = settings.geminiBaseUrl         || "https://generativelanguage.googleapis.com/v1beta";
  document.getElementById("groqApiKey").value        = settings.groqApiKey            || "";
  document.getElementById("groqModel").value         = settings.groqModelCustom       || "";
  document.getElementById("groqBaseUrl").value       = settings.groqBaseUrl           || "https://api.groq.com/openai/v1";
  document.getElementById("openrouterApiKey").value  = settings.openrouterApiKey      || "";
  document.getElementById("openrouterModel").value   = settings.openrouterModelCustom || "";
  document.getElementById("openrouterBaseUrl").value = settings.openrouterBaseUrl     || "https://openrouter.ai/api/v1";
  document.getElementById("ollamaUrl").value         = settings.ollamaUrl             || "http://localhost:11434";
  document.getElementById("ollamaModel").value       = settings.ollamaModelCustom     || "";
  // STT / TTS
  document.getElementById("assemblyaiApiKey").value  = settings.assemblyaiApiKey  || "";
  document.getElementById("whisperApiKey").value     = settings.whisperApiKey     || "";
  document.getElementById("whisperBaseUrl").value    = settings.whisperBaseUrl    || "https://api.openai.com/v1";
  document.getElementById("whisperModel").value      = settings.whisperModel      || "whisper-1";
  document.getElementById("sttLanguage").value       = settings.sttLanguage       || "en-US";
  document.getElementById("pushToTalkShortcut").value = settings.pushToTalkShortcut || "Ctrl+Shift+Space";
  document.getElementById("markStepDoneShortcut").value = settings.markStepDoneShortcut || "Ctrl+Alt+1";
  document.getElementById("requestStepHelpShortcut").value = settings.requestStepHelpShortcut || "Ctrl+Alt+2";
  document.getElementById("recheckCurrentStepShortcut").value = settings.recheckCurrentStepShortcut || "Ctrl+Alt+3";
  document.getElementById("cancelActivePlanShortcut").value = settings.cancelActivePlanShortcut || "Ctrl+Alt+4";
  document.getElementById("previousStepShortcut").value = settings.previousStepShortcut || "Ctrl+Alt+5";
  document.getElementById("skipCurrentStepShortcut").value = settings.skipCurrentStepShortcut || "Ctrl+Alt+6";
  document.getElementById("regenerateCurrentStepShortcut").value = settings.regenerateCurrentStepShortcut || "Ctrl+Alt+7";

  setSelectValue("sttProvider", settings.sttProvider || "webspeech");
  setSelectValue("ttsProvider", settings.ttsProvider || "google");

  document.getElementById("elevenlabsApiKey").value  = settings.elevenlabsApiKey  || "";
  document.getElementById("elevenlabsVoiceId").value = settings.elevenlabsVoiceId || "";
  document.getElementById("openaiTtsApiKey").value   = settings.openaiTtsApiKey   || "";
  document.getElementById("openaiTtsBaseUrl").value  = settings.openaiTtsBaseUrl  || "https://api.openai.com/v1";
  document.getElementById("openaiTtsModel").value    = settings.openaiTtsModel    || "tts-1";
  document.getElementById("openaiTtsVoice").value    = settings.openaiTtsVoice    || "nova";
  document.getElementById("ttsEnabled").checked      = settings.ttsEnabled !== false;
  document.getElementById("ttsVolume").value         = String(normalizeTtsVolume(settings.ttsVolume));
  document.getElementById("ttsRate").value           = String(normalizeTtsRate(settings.ttsRate));
  updateTtsVolumeLabel();
  updateTtsRateLabel();

  toggleAssemblyKey();
  toggleElevenLabs();

  document.getElementById("sttProvider").addEventListener("change", toggleAssemblyKey);
  document.getElementById("ttsProvider").addEventListener("change", toggleElevenLabs);
  document.getElementById("ttsVolume").addEventListener("input", updateTtsVolumeLabel);
  document.getElementById("ttsRate").addEventListener("input", updateTtsRateLabel);

  document.getElementById("btn-save").addEventListener("click",   saveSettings);
  document.getElementById("btn-reset-all").addEventListener("click", resetAllSettings);
  document.getElementById("btn-cancel").addEventListener("click", () => window.openguider.invoke("close-settings"));
  document.getElementById("btn-close").addEventListener("click",  () => window.openguider.invoke("close-settings"));
  document.getElementById("btn-refresh-metrics").addEventListener("click", refreshMetrics);
  document.getElementById("btn-reset-metrics").addEventListener("click", resetMetrics);

  bindSettingsTabs();
  bindShortcutRecordButtons();
  await refreshMetrics();
}

function activateProvider(provider) {
  document.querySelectorAll(".provider-section").forEach(sec => {
    sec.classList.toggle("active", sec.id === `section-${provider}`);
  });
}

function setSelectValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function normalizeTtsVolume(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(0, Math.min(1, numeric));
}

function normalizeTtsRate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1.5;
  return Math.max(1, Math.min(2, numeric));
}

function updateTtsVolumeLabel() {
  const slider = document.getElementById("ttsVolume");
  const label = document.getElementById("ttsVolumeValue");
  if (!slider || !label) return;
  const volume = normalizeTtsVolume(slider.value);
  label.textContent = `${Math.round(volume * 100)}%`;
}

function updateTtsRateLabel() {
  const slider = document.getElementById("ttsRate");
  const label = document.getElementById("ttsRateValue");
  if (!slider || !label) return;
  const rate = normalizeTtsRate(slider.value);
  label.textContent = `${rate.toFixed(2)}x`;
}

function toggleAssemblyKey() {
  const stt = document.getElementById("sttProvider").value;
  document.getElementById("assemblyKey-group").style.display =
    (stt === "assemblyai") ? "flex" : "none";
    
  const showWhisper = (stt === "whisper");
  document.getElementById("whisperKey-group").style.display   = showWhisper ? "flex" : "none";
  document.getElementById("whisperApi-group").style.display   = showWhisper ? "flex" : "none";
  document.getElementById("whisperModel-group").style.display = showWhisper ? "flex" : "none";
}

function toggleElevenLabs() {
  const tts = document.getElementById("ttsProvider").value;
  const showEleven = tts === "elevenlabs";
  document.getElementById("elevenlabs-group").style.display       = showEleven ? "flex" : "none";
  document.getElementById("elevenlabs-voice-group").style.display = showEleven ? "flex" : "none";
  document.getElementById("openaiTts-group").style.display        = (tts === "openai") ? "flex" : "none";
}

function bindSettingsTabs() {
  const tabButtons = [...document.querySelectorAll(".settings-tab-btn")];
  const tabContents = [...document.querySelectorAll(".settings-tab-section")];
  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.tab;
      tabButtons.forEach((b) => b.classList.toggle("active", b === button));
      tabContents.forEach((section) => {
        section.classList.toggle("active", section.dataset.tabContent === target);
      });
    });
  });
}

function formatMetricsSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.metrics) || snapshot.metrics.length === 0) {
    return "No telemetry yet.";
  }

  const lines = [];
  lines.push(`Generated: ${snapshot.generatedAt}`);
  lines.push("");
  for (const metric of snapshot.metrics) {
    lines.push(
      `${metric.name}\n` +
      `  count=${metric.count} ok=${metric.successCount} err=${metric.errorCount}\n` +
      `  avg=${metric.avgDurationMs}ms p95=${metric.p95DurationMs}ms min=${metric.minDurationMs}ms max=${metric.maxDurationMs}ms last=${metric.lastDurationMs}ms`,
    );
    if (metric.lastMeta && Object.keys(metric.lastMeta).length > 0) {
      lines.push(`  lastMeta=${JSON.stringify(metric.lastMeta)}`);
    }
    lines.push("");
  }

  if (Array.isArray(snapshot.events) && snapshot.events.length > 0) {
    lines.push("Recent events:");
    snapshot.events.slice(0, 5).forEach((eventItem) => {
      lines.push(`- ${eventItem.ts} ${eventItem.name} ${JSON.stringify(eventItem.payload)}`);
    });
  }

  return lines.join("\n");
}

async function refreshMetrics() {
  const output = document.getElementById("metrics-output");
  if (!output) return;
  try {
    const snapshot = await window.openguider.invoke("get-performance-metrics");
    output.textContent = formatMetricsSnapshot(snapshot);
  } catch (error) {
    output.textContent = "Failed to load metrics.";
    showToast("Could not fetch metrics: " + error.message, true);
  }
}

async function resetMetrics() {
  try {
    await window.openguider.invoke("reset-performance-metrics");
    await refreshMetrics();
    showToast("Telemetry metrics reset");
  } catch (error) {
    showToast("Could not reset metrics: " + error.message, true);
  }
}

function normalizeShortcutFromEvent(event) {
  const acceleratorKey = normalizeAcceleratorKey(event);
  if (!acceleratorKey) return "";
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  parts.push(acceleratorKey);
  return parts.join("+");
}

function normalizeAcceleratorKey(event) {
  const code = String(event.code || "");
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;

  const codeMap = {
    Space: "Space",
    Tab: "Tab",
    Enter: "Return",
    NumpadEnter: "Return",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Escape: "Esc",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Minus: "Minus",
    Equal: "Plus",
  };
  if (codeMap[code]) return codeMap[code];

  const key = String(event.key || "").toLowerCase();
  if (!key || key === "control" || key === "shift" || key === "alt" || key === "meta") {
    return "";
  }

  const keyMap = {
    " ": "Space",
    spacebar: "Space",
    enter: "Return",
    return: "Return",
    escape: "Esc",
    esc: "Esc",
    arrowup: "Up",
    arrowdown: "Down",
    arrowleft: "Left",
    arrowright: "Right",
    pageup: "PageUp",
    pagedown: "PageDown",
    "+": "Plus",
    "-": "Minus",
  };
  if (keyMap[key]) return keyMap[key];

  if (key.length === 1) {
    if (/[a-z]/.test(key)) return key.toUpperCase();
    return key;
  }
  return key[0].toUpperCase() + key.slice(1);
}

function stopShortcutRecording(button) {
  if (!button) return;
  button.classList.remove("recording");
  button.textContent = "Record";
  if (recordingButton === button) {
    recordingButton = null;
  }
}

function bindShortcutRecordButtons() {
  const recordButtons = [...document.querySelectorAll(".record-shortcut-btn")];
  document.addEventListener("keydown", (event) => {
    if (!recordingButton) return;
    event.preventDefault();
    if (event.key === "Escape") {
      stopShortcutRecording(recordingButton);
      return;
    }
    const shortcut = normalizeShortcutFromEvent(event);
    if (!shortcut) return;
    const inputId = recordingButton.dataset.targetInput;
    const input = document.getElementById(inputId);
    if (input) {
      input.value = shortcut;
    }
    stopShortcutRecording(recordingButton);
  });

  recordButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (recordingButton && recordingButton !== button) {
        stopShortcutRecording(recordingButton);
      }
      if (recordingButton === button) {
        stopShortcutRecording(button);
        return;
      }
      recordingButton = button;
      recordingButton.classList.add("recording");
      recordingButton.textContent = "Press keys";
    });
  });
}

async function saveSettings() {
  // Collect model names typed by user for each provider
  const modelMap = {
    claude:     document.getElementById("claudeModel").value.trim(),
    openai:     document.getElementById("openaiModel").value.trim(),
    gemini:     document.getElementById("geminiModel").value.trim(),
    groq:       document.getElementById("groqModel").value.trim(),
    openrouter: document.getElementById("openrouterModel").value.trim(),
    ollama:     document.getElementById("ollamaModel").value.trim(),
  };

  const activeModel = modelMap[activeProvider] || "";

  const newSettings = {
    aiProvider:              activeProvider,
    aiModel:                 activeModel,
    claudeModelCustom:       modelMap.claude,
    openaiModelCustom:       modelMap.openai,
    geminiModelCustom:       modelMap.gemini,
    groqModelCustom:         modelMap.groq,
    openrouterModelCustom:   modelMap.openrouter,
    ollamaModelCustom:       modelMap.ollama,
    claudeApiKey:            document.getElementById("claudeApiKey").value.trim(),
    claudeBaseUrl:           document.getElementById("claudeBaseUrl").value.trim()        || "https://api.anthropic.com",
    openaiApiKey:            document.getElementById("openaiApiKey").value.trim(),
    openaiBaseUrl:           document.getElementById("openaiBaseUrl").value.trim()        || "https://api.openai.com/v1",
    geminiApiKey:            document.getElementById("geminiApiKey").value.trim(),
    geminiBaseUrl:           document.getElementById("geminiBaseUrl").value.trim()        || "https://generativelanguage.googleapis.com/v1beta",
    groqApiKey:              document.getElementById("groqApiKey").value.trim(),
    groqBaseUrl:             document.getElementById("groqBaseUrl").value.trim()          || "https://api.groq.com/openai/v1",
    openrouterApiKey:        document.getElementById("openrouterApiKey").value.trim(),
    openrouterBaseUrl:       document.getElementById("openrouterBaseUrl").value.trim()    || "https://openrouter.ai/api/v1",
    ollamaUrl:               document.getElementById("ollamaUrl").value.trim()            || "http://localhost:11434",
    assemblyaiApiKey:        document.getElementById("assemblyaiApiKey").value.trim(),
    whisperApiKey:           document.getElementById("whisperApiKey").value.trim(),
    whisperBaseUrl:          document.getElementById("whisperBaseUrl").value.trim() || "https://api.openai.com/v1",
    whisperModel:            document.getElementById("whisperModel").value.trim() || "whisper-1",
    elevenlabsApiKey:        document.getElementById("elevenlabsApiKey").value.trim(),
    elevenlabsVoiceId:       document.getElementById("elevenlabsVoiceId").value.trim(),
    openaiTtsApiKey:         document.getElementById("openaiTtsApiKey").value.trim(),
    openaiTtsBaseUrl:        document.getElementById("openaiTtsBaseUrl").value.trim() || "https://api.openai.com/v1",
    openaiTtsModel:          document.getElementById("openaiTtsModel").value.trim() || "tts-1",
    openaiTtsVoice:          document.getElementById("openaiTtsVoice").value.trim() || "nova",
    ttsRate:                 normalizeTtsRate(document.getElementById("ttsRate").value),
    ttsVolume:               normalizeTtsVolume(document.getElementById("ttsVolume").value),
    sttProvider:             document.getElementById("sttProvider").value,
    sttLanguage:             document.getElementById("sttLanguage").value,
    ttsProvider:             document.getElementById("ttsProvider").value,
    ttsEnabled:              document.getElementById("ttsEnabled").checked,
    pushToTalkShortcut:      document.getElementById("pushToTalkShortcut").value.trim(),
    markStepDoneShortcut:    document.getElementById("markStepDoneShortcut").value.trim(),
    requestStepHelpShortcut: document.getElementById("requestStepHelpShortcut").value.trim(),
    recheckCurrentStepShortcut: document.getElementById("recheckCurrentStepShortcut").value.trim(),
    cancelActivePlanShortcut: document.getElementById("cancelActivePlanShortcut").value.trim(),
    previousStepShortcut: document.getElementById("previousStepShortcut").value.trim(),
    skipCurrentStepShortcut: document.getElementById("skipCurrentStepShortcut").value.trim(),
    regenerateCurrentStepShortcut: document.getElementById("regenerateCurrentStepShortcut").value.trim(),
    includeScreenshotByDefault: true, // Always true — golden rule
  };

  try {
    const result = await window.openguider.invoke("save-settings", newSettings);
    if (result?.warnings?.length) {
      showToast(result.warnings[0], true);
    }
    showToast("✓ Settings saved");
    setTimeout(() => window.openguider.invoke("close-settings"), 800);
  } catch (err) {
    showToast("Save failed: " + err.message, true);
  }
}

async function resetAllSettings() {
  const confirmed = await confirmResetSettings();
  if (!confirmed) return;

  try {
    await window.openguider.invoke("reset-settings");
    showToast("✓ Factory defaults restored");
    setTimeout(() => window.location.reload(), 400);
  } catch (err) {
    showToast("Reset failed: " + err.message, true);
  }
}

function confirmResetSettings() {
  const overlay = document.getElementById("confirm-overlay");
  const cancelBtn = document.getElementById("confirm-cancel");
  const confirmBtn = document.getElementById("confirm-confirm");
  const message = document.getElementById("confirm-message");

  if (!overlay || !cancelBtn || !confirmBtn) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    if (message) {
      message.textContent = "This will remove all saved settings and restore factory defaults.";
    }
    overlay.classList.remove("hidden");
    confirmBtn.focus();

    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      overlay.classList.add("hidden");
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      overlay.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKeydown);
      resolve(result);
    }

    function onCancel() {
      finish(false);
    }

    function onConfirm() {
      finish(true);
    }

    function onBackdrop(event) {
      if (event.target === overlay) finish(false);
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

    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
    overlay.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKeydown);
  });
}

init();
