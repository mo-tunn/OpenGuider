const { getCurrentStep } = require("../session/session-schema");
const { streamAIResponse, parsePointTag } = require("../ai/index");
const { planGoal } = require("./planner-chain");
const { locateStepTarget } = require("./executor-chain");
const { evaluateStep } = require("./evaluator-chain");
const { replanGoal } = require("./replanner-chain");
const { captureScreenTool } = require("./tools/capture-screen-tool");
const { requestUserInputTool, updatePlanTool } = require("./tools/plan-tool");
const { createLogger } = require("../logger");
const { createInteractionPipeline } = require("./interaction-pipeline");

const logger = createLogger("task-orchestrator");

class TaskOrchestrator {
  constructor({ captureAllScreens, sessionManager, prePostLayersEnabled = true }) {
    this.captureAllScreens = captureAllScreens;
    this.sessionManager = sessionManager;
    this.prePostLayersEnabled = prePostLayersEnabled;
    this.interactionPipeline = prePostLayersEnabled ? createInteractionPipeline() : null;
  }

  getSnapshot() {
    return this.sessionManager.getSnapshot();
  }

  async resolveScreenshots(images) {
    if (Array.isArray(images) && images.length > 0) {
      this.sessionManager.setLastScreenshots(images);
      return images;
    }

    const existing = this.sessionManager.getSession().lastScreenshots;
    if (existing && existing.length > 0) {
      return existing;
    }

    const captured = await captureScreenTool({
      captureAllScreens: this.captureAllScreens,
      forceFresh: false,
      maxAgeMs: 900,
    });
    this.sessionManager.setLastScreenshots(captured);
    return captured;
  }

  buildStepMessage(step, pointer) {
    const hints = Array.isArray(step?.fallbackHints) && step.fallbackHints.length
      ? ` Hints: ${step.fallbackHints.join(" | ")}`
      : "";

    const explanation = pointer?.explanation ? ` ${pointer.explanation}` : "";
    return `${step?.instruction || ""}${explanation}${hints}`.trim();
  }

  ensurePointerForStep(pointer, step, reason = "") {
    const previousPointer = this.sessionManager.getSnapshot().lastPointer;
    const fallbackCoordinate = previousPointer?.coordinate || { x: 500, y: 500 };

    const safePointer = {
      coordinate: pointer?.coordinate || fallbackCoordinate,
      label: pointer?.label || step?.title || "Next click target",
      explanation: pointer?.explanation || reason || "Best guess pointer for the next action.",
      shouldPoint: true,
    };

    if (
      typeof safePointer.coordinate.x !== "number" ||
      typeof safePointer.coordinate.y !== "number"
    ) {
      safePointer.coordinate = { x: 500, y: 500 };
    }

    return safePointer;
  }

  async runSingleTurnFallback({ text, images, settings, signal }) {
    const snapshot = this.sessionManager.getSnapshot();
    const history = snapshot.messages.slice(-20);

    let enrichedText = text;
    let preprocessingContext = { ocrResult: null, windowInfo: null, matchedElements: [] };

    if (this.interactionPipeline && images.length > 0) {
      preprocessingContext = await this.interactionPipeline.preprocess({
        images,
        step: null,
        sessionId: snapshot.sessionId,
        signal,
      });

      if (preprocessingContext.ocrResult || preprocessingContext.windowInfo) {
        enrichedText = await this.interactionPipeline.distillContext(text, preprocessingContext, settings);
      }
    }

    const fullText = await streamAIResponse({
      text: enrichedText,
      images,
      history,
      settings,
      signal,
      onChunk: () => {},
    });

    const parsed = parsePointTag(fullText);
    let finalPointer = parsed.coordinate
      ? {
          coordinate: parsed.coordinate,
          label: parsed.label,
          explanation: parsed.spokenText,
          shouldPoint: true,
        }
      : null;

    if (this.interactionPipeline && finalPointer?.coordinate) {
      const postResult = await this.interactionPipeline.postprocess({
        coordinate: finalPointer.coordinate,
        label: finalPointer.label,
        step: null,
        sessionId: snapshot.sessionId,
        signal,
      });

      if (postResult.confidence > 0.5 && postResult.coordinate) {
        finalPointer = {
          ...finalPointer,
          coordinate: postResult.coordinate,
          explanation: (finalPointer.explanation || "") + ` [Verified: ${postResult.reason}]`,
        };
      } else if (postResult.confidence < 0.4 && this.interactionPipeline.shouldRecheck(finalPointer.coordinate)) {
        const fallback = this.interactionPipeline.getFallbackCoordinate();
        if (fallback) {
          finalPointer = {
            ...finalPointer,
            coordinate: fallback,
            explanation: (finalPointer.explanation || "") + " [Using fallback]",
          };
        }
      }
    }

    this.sessionManager.setActivePlan(null);
    this.sessionManager.setCurrentPointer(finalPointer);
    this.sessionManager.addMessage({
      role: "assistant",
      content: parsed.spokenText || fullText,
    });
    this.sessionManager.setStatus("idle");

    return {
      assistantMessage: parsed.spokenText || fullText,
      pointer: finalPointer,
      session: this.sessionManager.getSnapshot(),
      userInputRequest: null,
    };
  }

  async guideCurrentStep({
    settings,
    userNote,
    signal,
    forceFreshCapture = false,
    forcePointing = true,
  }) {
    const snapshot = this.sessionManager.getSnapshot();
    const plan = snapshot.activePlan;
    const step = getCurrentStep(plan);
    if (!plan || !step) {
      return {
        assistantMessage: "There is no active step right now.",
        pointer: null,
        session: snapshot,
        userInputRequest: null,
      };
    }

    this.sessionManager.setStatus("executing");
    const images = forceFreshCapture
      ? await captureScreenTool({
          captureAllScreens: this.captureAllScreens,
          forceFresh: true,
          maxAgeMs: 0,
        })
      : await this.resolveScreenshots(snapshot.lastScreenshots);
    this.sessionManager.setLastScreenshots(images);

    let preprocessingContext = { ocrResult: null, windowInfo: null, matchedElements: [] };
    if (this.interactionPipeline && images.length > 0) {
      preprocessingContext = await this.interactionPipeline.preprocess({
        images,
        step,
        sessionId: snapshot.sessionId,
        signal,
      });
    }

    let pointer = null;
    let llmRawCoordinate = null;
    try {
      const llmResult = await locateStepTarget({
        plan,
        step,
        images,
        settings,
        userNote,
        signal,
        forcePointing,
        preprocessing: preprocessingContext,
      });
      llmRawCoordinate = llmResult?.coordinate;
      pointer = llmResult;
    } catch (error) {
      console.error("===== LLM LOCATOR THREW ERROR =====", error);
      pointer = this.ensurePointerForStep(
        null,
        step,
        "I could not locate the exact UI element, so this is the strongest estimated click point.",
      );
      this.sessionManager.appendEvaluation({
        kind: "locator_fallback",
        stepId: step.id,
        status: "uncertain",
        confidence: 0,
        rationale: error.message,
        suggestedAction: "repeat_guidance",
      });
    }

    if (this.interactionPipeline && pointer?.coordinate) {
      const postResult = await this.interactionPipeline.postprocess({
        coordinate: pointer.coordinate,
        label: pointer.label,
        step,
        sessionId: snapshot.sessionId,
        signal,
      });
      if (postResult.confidence > 0.5 && postResult.coordinate) {
        if (postResult.boundsClamped || postResult.snapped) {
          pointer = {
            ...pointer,
            coordinate: postResult.coordinate,
            explanation: (pointer.explanation || "") + ` [Verified: ${postResult.reason}]`,
          };
        }
      } else if (postResult.confidence < 0.4 && this.interactionPipeline.shouldRecheck(pointer.coordinate)) {
        const fallback = this.interactionPipeline.getFallbackCoordinate();
        if (fallback) {
          pointer = {
            ...pointer,
            coordinate: fallback,
            explanation: (pointer.explanation || "") + " [Using fallback coordinate]",
          };
        }
      }
    }

    if (forcePointing) {
      pointer = this.ensurePointerForStep(
        pointer,
        step,
        "Using the most likely click point for this step.",
      );
    }

    this.sessionManager.setCurrentPointer(pointer);
    const assistantMessage = this.buildStepMessage(step, pointer);
    this.sessionManager.addMessage({ role: "assistant", content: assistantMessage });
    this.sessionManager.setStatus("waiting_user");

    return {
      assistantMessage,
      pointer,
      session: this.sessionManager.getSnapshot(),
      userInputRequest: requestUserInputTool({ step }),
    };
  }

  finishPlanWithMessage(message) {
    const assistantMessage = message || "Plan completed successfully.";
    this.sessionManager.addMessage({ role: "assistant", content: assistantMessage });
    this.sessionManager.setCurrentPointer(null);
    this.sessionManager.setActivePlan(null);
    this.sessionManager.setStatus("idle");

    return {
      assistantMessage,
      pointer: null,
      session: this.sessionManager.getSnapshot(),
    };
  }

  async startGoalSession({ text, images, settings, signal, requestId }) {
    logger.info("start-goal-session", { requestId, textLength: text?.length || 0, imageCount: images?.length || 0 });
    this.sessionManager.addMessage({ role: "user", content: text });
    this.sessionManager.setGoalIntent(text);
    const nextImages = await this.resolveScreenshots(images);

    this.sessionManager.setStatus("planning");
    let plan;
    try {
      plan = await planGoal({
        goal: text,
        images: nextImages,
        sessionSnapshot: this.sessionManager.getSnapshot(),
        settings,
        signal,
      });
    } catch (error) {
      this.sessionManager.appendEvaluation({
        kind: "planner_fallback",
        status: "uncertain",
        confidence: 0,
        rationale: error.message,
        suggestedAction: "repeat_guidance",
      });
      return this.runSingleTurnFallback({
        text,
        images: nextImages,
        settings,
        signal,
      });
    }

    updatePlanTool({ sessionManager: this.sessionManager, plan });
    this.sessionManager.addMessage({
      role: "assistant",
      content: `I built a step-by-step plan for "${plan.goal}". I will guide you through one step at a time.`,
    });

    return this.guideCurrentStep({
      settings,
      signal,
      forceFreshCapture: false,
      forcePointing: true,
    });
  }

  async handleEvaluationResult({ evaluation, settings, signal }) {
    const snapshot = this.sessionManager.getSnapshot();
    const plan = snapshot.activePlan;

    this.sessionManager.appendEvaluation(evaluation);

    if (!plan) {
      return {
        assistantMessage: evaluation.assistantResponse,
        pointer: null,
        session: this.sessionManager.getSnapshot(),
      };
    }

    if (evaluation.status === "done" || evaluation.suggestedAction === "advance") {
      const updatedPlan = this.sessionManager.completeCurrentStep();

      if (updatedPlan?.status === "completed") {
        return this.finishPlanWithMessage("All steps are complete. The plan is finished.");
      }

      this.sessionManager.addMessage({
        role: "assistant",
        content: evaluation.assistantResponse || "Great, that step is done. Moving to the next one.",
      });

      return this.guideCurrentStep({
        settings,
        signal,
        forceFreshCapture: false,
        forcePointing: true,
      });
    }

    if (evaluation.suggestedAction === "replan" || evaluation.status === "blocked") {
      this.sessionManager.setStatus("planning");
      const currentStep = getCurrentStep(plan);
      const nextImages = await this.resolveScreenshots(snapshot.lastScreenshots);
      const replanned = await replanGoal({
        plan,
        step: currentStep,
        evaluation,
        images: nextImages,
        settings,
        signal,
      });

      updatePlanTool({ sessionManager: this.sessionManager, plan: replanned.plan });
      this.sessionManager.addMessage({
        role: "assistant",
        content: replanned.assistantResponse,
      });

      return this.guideCurrentStep({
        settings,
        signal,
        forceFreshCapture: false,
        forcePointing: true,
      });
    }

    this.sessionManager.addMessage({
      role: "assistant",
      content: evaluation.assistantResponse,
    });
    return this.guideCurrentStep({
      settings,
      signal,
      forceFreshCapture: false,
      forcePointing: true,
    });
  }

  async evaluateCurrentStep({ settings, userNote, forceFreshCapture = true, signal }) {
    const snapshot = this.sessionManager.getSnapshot();
    const plan = snapshot.activePlan;
    const step = getCurrentStep(plan);

    if (!plan || !step) {
      return {
        assistantMessage: "There is no active plan to evaluate.",
        pointer: null,
        session: snapshot,
      };
    }

    this.sessionManager.setStatus("evaluating");
    const images = forceFreshCapture
      ? await captureScreenTool({
          captureAllScreens: this.captureAllScreens,
          forceFresh: true,
          maxAgeMs: 0,
        })
      : await this.resolveScreenshots(snapshot.lastScreenshots);

    this.sessionManager.setLastScreenshots(images);
    let evaluation;
    try {
      evaluation = await evaluateStep({
        plan,
        step,
        images,
        settings,
        userNote,
        signal,
      });
    } catch (error) {
      this.sessionManager.setManualConfirmation({
        stepId: step.id,
        reason: error.message,
      });
      this.sessionManager.setStatus("waiting_user");

      const assistantMessage = "I could not verify this step from the screenshot. If you completed it, press Mark done again to confirm manually. Otherwise use Need help or Re-check.";
      this.sessionManager.addMessage({
        role: "assistant",
        content: assistantMessage,
      });

      return {
        assistantMessage,
        pointer: null,
        session: this.sessionManager.getSnapshot(),
        userInputRequest: requestUserInputTool({ step }),
      };
    }

    return this.handleEvaluationResult({ evaluation, settings, signal });
  }

  async submitUserMessage({ text, images, settings, signal, requestId }) {
    logger.info("submit-user-message", { requestId, textLength: text?.length || 0, imageCount: images?.length || 0 });
    const snapshot = this.sessionManager.getSnapshot();

    if (snapshot.activePlan && snapshot.activePlan.status === "active") {
      this.sessionManager.addMessage({ role: "user", content: text });
      if (images?.length) {
        this.sessionManager.setLastScreenshots(images);
      }
      return this.evaluateCurrentStep({
        settings,
        userNote: text,
        forceFreshCapture: !images?.length,
        signal,
      });
    }

    return this.startGoalSession({ text, images, settings, signal });
  }

  async markStepDone({ settings, signal, requestId }) {
    logger.info("mark-step-done", { requestId });
    const snapshot = this.sessionManager.getSnapshot();
    const plan = snapshot.activePlan;
    const step = getCurrentStep(plan);

    if (
      plan &&
      step &&
      snapshot.manualConfirmation &&
      snapshot.manualConfirmation.stepId === step.id
    ) {
      const updatedPlan = this.sessionManager.completeCurrentStep();
      if (updatedPlan?.status === "completed") {
        return this.finishPlanWithMessage("I manually confirmed the last step. The plan is now complete.");
      }

      this.sessionManager.addMessage({
        role: "assistant",
        content: "I manually confirmed that step and moved to the next one.",
      });

      return this.guideCurrentStep({
        settings,
        userNote: "Manual confirmation accepted.",
        signal,
        forceFreshCapture: true,
        forcePointing: true,
      });
    }

    return this.evaluateCurrentStep({
      settings,
      userNote: "The user marked the current step as done.",
      forceFreshCapture: true,
      signal,
    });
  }

  async requestStepHelp({ settings, signal, requestId }) {
    logger.info("request-step-help", { requestId });
    const snapshot = this.sessionManager.getSnapshot();
    const plan = snapshot.activePlan;
    const step = getCurrentStep(plan);

    if (!plan || !step) {
      return {
        assistantMessage: "There is no active step to explain right now.",
        pointer: null,
        session: snapshot,
      };
    }

    this.sessionManager.addMessage({
      role: "assistant",
      content: `Let's focus on "${step.title}" again.`,
    });

    return this.guideCurrentStep({
      settings,
      userNote: "The user asked for more help.",
      signal,
      forceFreshCapture: true,
      forcePointing: true,
    });
  }

  async recheckCurrentStep({ settings, signal, requestId }) {
    logger.info("recheck-current-step", { requestId });
    const snapshot = this.sessionManager.getSnapshot();
    const originalGoal = (snapshot.goalIntent || "").trim();
    const lastUserMessage = [...(snapshot.messages || [])]
      .reverse()
      .find((message) => message?.role === "user" && message?.content)?.content;
    const fallbackGoal = snapshot.activePlan?.goal || "";
    const goalText = (originalGoal || fallbackGoal || lastUserMessage || "").trim();

    if (!goalText) {
      return {
        assistantMessage: "I could not find a user goal to rebuild the plan. Please send your goal again.",
        pointer: null,
        session: snapshot,
      };
    }

    this.sessionManager.setGoalIntent(goalText);

    this.sessionManager.setStatus("planning");
    const images = await captureScreenTool({
      captureAllScreens: this.captureAllScreens,
      forceFresh: true,
      maxAgeMs: 0,
    });
    this.sessionManager.setLastScreenshots(images);

    const rebuiltPlan = await planGoal({
      goal: goalText,
      images,
      sessionSnapshot: this.sessionManager.getSnapshot(),
      settings,
      signal,
    });

    updatePlanTool({ sessionManager: this.sessionManager, plan: rebuiltPlan });
    this.sessionManager.addMessage({
      role: "assistant",
      content: `I rebuilt the plan from your request: "${goalText}".`,
    });

    return this.guideCurrentStep({
      settings,
      userNote: "User requested a full re-check and plan rebuild from their goal.",
      signal,
      forceFreshCapture: false,
      forcePointing: true,
    });
  }

  resetSession({ requestId } = {}) {
    logger.info("reset-session", { requestId });
    this.sessionManager.clearSession();
    if (this.interactionPipeline) {
      this.interactionPipeline.clear();
    }
    return this.sessionManager.getSnapshot();
  }

  cancelActivePlan({ silent = false, requestId } = {}) {
    logger.info("cancel-active-plan", { requestId, silent });
    const hasPlan = Boolean(this.sessionManager.getSnapshot().activePlan);
    this.sessionManager.setCurrentPointer(null);
    this.sessionManager.setActivePlan(null);
    this.sessionManager.setStatus("idle");

    const assistantMessage = hasPlan
      ? "Plan cancelled. You can start a new goal anytime."
      : "There is no active plan to cancel.";
    if (!silent) {
      this.sessionManager.addMessage({
        role: "assistant",
        content: assistantMessage,
      });
    }

    return {
      assistantMessage,
      pointer: null,
      session: this.sessionManager.getSnapshot(),
    };
  }

  async regenerateCurrentStep({ settings, signal, requestId }) {
    logger.info("regenerate-current-step", { requestId });
    const snapshot = this.sessionManager.getSnapshot();
    const plan = snapshot.activePlan;
    const step = getCurrentStep(plan);
    if (!plan || !step) {
      return {
        assistantMessage: "There is no active step to regenerate.",
        pointer: null,
        session: snapshot,
      };
    }
    this.sessionManager.addMessage({
      role: "assistant",
      content: `Regenerating guidance for "${step.title}".`,
    });
    return this.guideCurrentStep({
      settings,
      userNote: "Regenerate this step with refreshed guidance.",
      signal,
      forceFreshCapture: true,
      forcePointing: true,
    });
  }

  async previousStep({ settings, signal, requestId }) {
    logger.info("previous-step", { requestId });
    const snapshot = this.sessionManager.getSnapshot();
    const plan = snapshot.activePlan;
    if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
      return {
        assistantMessage: "There is no active plan step to go back to.",
        pointer: null,
        session: snapshot,
      };
    }

    this.sessionManager.goToPreviousStep();
    const updatedSnapshot = this.sessionManager.getSnapshot();
    const activeStep = getCurrentStep(updatedSnapshot.activePlan);
    this.sessionManager.addMessage({
      role: "assistant",
      content: activeStep
        ? `Moved back to "${activeStep.title}".`
        : "Moved to the previous step.",
    });

    return this.guideCurrentStep({
      settings,
      userNote: "User requested previous step.",
      signal,
      forceFreshCapture: true,
      forcePointing: true,
    });
  }

  async skipCurrentStep({ settings, signal, requestId }) {
    logger.info("skip-current-step", { requestId });
    const snapshot = this.sessionManager.getSnapshot();
    const plan = snapshot.activePlan;
    const step = getCurrentStep(plan);
    if (!plan || !step) {
      return {
        assistantMessage: "There is no active step to skip.",
        pointer: null,
        session: snapshot,
      };
    }

    const updatedPlan = this.sessionManager.completeCurrentStep();
    if (updatedPlan?.status === "completed") {
      return this.finishPlanWithMessage(`Skipped "${step.title}". All steps are now complete.`);
    }

    this.sessionManager.addMessage({
      role: "assistant",
      content: `Skipped "${step.title}". Moving to the next step.`,
    });

    return this.guideCurrentStep({
      settings,
      userNote: "User skipped the current step.",
      signal,
      forceFreshCapture: true,
      forcePointing: true,
    });
  }
}

module.exports = {
  TaskOrchestrator,
};
