export function createPanelState() {
  const state = {
    settings: {},
    conversationHistory: [],
    sessionSnapshot: null,
    activePlan: null,
    agentState: "idle",
    pointer: null,
    pendingScreenshots: null,
    includeScreen: false,
    isRecording: false,
    isStreaming: false,
    recognition: null,
    waveInterval: null,
    streamingBubble: null,
    streamingText: "",
    googleAudioQueue: [],
    googleCurrentAudio: null,
    typingCounter: 0,
    toastTimer: null,
    pttCleanup: null,
  };

  function getSettings() {
    return state.settings;
  }

  function setSettings(nextSettings) {
    state.settings = nextSettings || {};
  }

  function getSetting(key) {
    return state.settings[key];
  }

  function setSetting(key, value) {
    state.settings[key] = value;
  }

  function getConversationHistory() {
    return state.conversationHistory;
  }

  function addConversationMessage(message) {
    state.conversationHistory.push(message);
  }

  function replaceConversationHistory(nextHistory) {
    state.conversationHistory = nextHistory;
  }

  function clearConversationHistory() {
    state.conversationHistory = [];
  }

  function getSessionSnapshot() {
    return state.sessionSnapshot;
  }

  function setSessionSnapshot(snapshot) {
    state.sessionSnapshot = snapshot || null;
    state.conversationHistory = Array.isArray(snapshot?.messages) ? snapshot.messages.slice() : [];
    state.activePlan = snapshot?.activePlan || null;
    state.agentState = snapshot?.status || "idle";
    state.pointer = snapshot?.lastPointer || null;
  }

  function getActivePlan() {
    return state.activePlan;
  }

  function setActivePlan(plan) {
    state.activePlan = plan || null;
  }

  function getAgentState() {
    return state.agentState;
  }

  function setAgentState(value) {
    state.agentState = value || "idle";
  }

  function getPointer() {
    return state.pointer;
  }

  function setPointer(pointer) {
    state.pointer = pointer || null;
  }

  function getPendingScreenshots() {
    return state.pendingScreenshots;
  }

  function setPendingScreenshots(screenshots) {
    state.pendingScreenshots = screenshots;
  }

  function getIncludeScreen() {
    return state.includeScreen;
  }

  function setIncludeScreen(value) {
    state.includeScreen = value;
  }

  function isRecording() {
    return state.isRecording;
  }

  function setRecording(value) {
    state.isRecording = value;
  }

  function isStreaming() {
    return state.isStreaming;
  }

  function setStreaming(value) {
    state.isStreaming = value;
  }

  function getRecognition() {
    return state.recognition;
  }

  function setRecognition(value) {
    state.recognition = value;
  }

  function getWaveInterval() {
    return state.waveInterval;
  }

  function setWaveInterval(value) {
    state.waveInterval = value;
  }

  function getStreamingBubble() {
    return state.streamingBubble;
  }

  function setStreamingBubble(value) {
    state.streamingBubble = value;
  }

  function getStreamingText() {
    return state.streamingText;
  }

  function setStreamingText(value) {
    state.streamingText = value;
  }

  function appendStreamingText(chunk) {
    state.streamingText += chunk;
  }

  function clearStreamingSession() {
    state.streamingBubble = null;
    state.streamingText = "";
  }

  function replaceGoogleAudioQueue(chunks) {
    state.googleAudioQueue = Array.isArray(chunks) ? chunks.slice() : [];
  }

  function shiftGoogleAudioQueue() {
    return state.googleAudioQueue.shift();
  }

  function getGoogleAudioQueueLength() {
    return state.googleAudioQueue.length;
  }

  function clearGoogleAudioQueue() {
    state.googleAudioQueue = [];
  }

  function getGoogleCurrentAudio() {
    return state.googleCurrentAudio;
  }

  function setGoogleCurrentAudio(audio) {
    state.googleCurrentAudio = audio;
  }

  function nextTypingId() {
    state.typingCounter += 1;
    return state.typingCounter;
  }

  function getToastTimer() {
    return state.toastTimer;
  }

  function setToastTimer(timer) {
    state.toastTimer = timer;
  }

  function setPttCleanup(cleanup) {
    state.pttCleanup = cleanup;
  }

  function runPttCleanup() {
    if (typeof state.pttCleanup === "function") {
      const cleanup = state.pttCleanup;
      state.pttCleanup = null;
      cleanup();
    }
  }

  return {
    addConversationMessage,
    appendStreamingText,
    getActivePlan,
    getAgentState,
    clearConversationHistory,
    clearGoogleAudioQueue,
    clearStreamingSession,
    getConversationHistory,
    getGoogleAudioQueueLength,
    getGoogleCurrentAudio,
    getIncludeScreen,
    getPendingScreenshots,
    getPointer,
    getRecognition,
    getSessionSnapshot,
    getSetting,
    getSettings,
    getStreamingBubble,
    getStreamingText,
    getToastTimer,
    getWaveInterval,
    isRecording,
    isStreaming,
    nextTypingId,
    replaceConversationHistory,
    replaceGoogleAudioQueue,
    runPttCleanup,
    setActivePlan,
    setAgentState,
    setGoogleCurrentAudio,
    setIncludeScreen,
    setPendingScreenshots,
    setPointer,
    setPttCleanup,
    setRecognition,
    setRecording,
    setSessionSnapshot,
    setSetting,
    setSettings,
    setStreaming,
    setStreamingBubble,
    setStreamingText,
    setToastTimer,
    setWaveInterval,
    shiftGoogleAudioQueue,
  };
}
