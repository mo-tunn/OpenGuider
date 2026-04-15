const SESSION_SNAPSHOT_KEY = "sessionSnapshotV1";

function saveSessionSnapshot(store, snapshot) {
  if (!store) {
    return;
  }
  if (!snapshot) {
    store.set(SESSION_SNAPSHOT_KEY, null);
    return;
  }
  const persisted = {
    sessionId: snapshot.sessionId,
    messages: Array.isArray(snapshot.messages) ? snapshot.messages.slice(-80) : [],
    goalIntent: snapshot.goalIntent || "",
    activePlan: snapshot.activePlan || null,
    currentStepId: snapshot.currentStepId || null,
    manualConfirmation: snapshot.manualConfirmation || null,
    lastScreenshots: [],
    evaluationHistory: Array.isArray(snapshot.evaluationHistory)
      ? snapshot.evaluationHistory.slice(-40)
      : [],
    status: snapshot.status || "idle",
    lastPointer: snapshot.lastPointer || null,
    updatedAt: snapshot.updatedAt,
  };
  store.set(SESSION_SNAPSHOT_KEY, persisted);
}

function loadSessionSnapshot(store) {
  if (!store) {
    return null;
  }
  return store.get(SESSION_SNAPSHOT_KEY, null);
}

function clearSessionSnapshot(store) {
  if (!store) {
    return;
  }
  store.delete(SESSION_SNAPSHOT_KEY);
}

module.exports = {
  clearSessionSnapshot,
  loadSessionSnapshot,
  saveSessionSnapshot,
};
