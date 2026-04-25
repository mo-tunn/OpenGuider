function normalizeSubstepDescription(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function getBrowserExecutionSubstepTtsText(progress = {}) {
  if (String(progress?.event || "") !== "substep_start") {
    return "";
  }

  return normalizeSubstepDescription(progress?.description);
}

function createBrowserExecutionTtsController({
  getSettings,
  speak,
  getSender,
  logger = () => {},
} = {}) {
  let latestRequestId = 0;

  function invalidate() {
    latestRequestId += 1;
  }

  async function handleSubstepProgress(progress) {
    const text = getBrowserExecutionSubstepTtsText(progress);
    if (!text || typeof getSettings !== "function" || typeof speak !== "function") {
      return false;
    }

    const requestId = ++latestRequestId;

    try {
      const settings = await getSettings();
      await speak(text, settings, typeof getSender === "function" ? getSender() : null, {
        shouldAbort: () => requestId !== latestRequestId,
      });
      return true;
    } catch (error) {
      logger("browser-execution-tts-error", {
        error: error?.message || String(error),
        event: progress?.event || "unknown",
        stepNumber: progress?.stepNumber || 0,
      });
      return false;
    }
  }

  return {
    handleSubstepProgress,
    invalidate,
  };
}

module.exports = {
  createBrowserExecutionTtsController,
  getBrowserExecutionSubstepTtsText,
};
