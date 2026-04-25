const { ipcMain } = require("electron");
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
const { ExecutionEngine } = require("../core/execution-engine");
const { registry } = require("../core/plugin-registry");
const { IntentRouter } = require("../core/intent-router");

const logger = createLogger("task-orchestrator");
const DECISION_TIMEOUT_MS = 120_000;

/** @typedef {'guide'|'hitl'|'auto'} ExecutionMode */

function normalizeExecutionMode(mode) {
  if (mode === "auto") {
    return "auto";
  }
  if (mode === "hitl" || mode === "supervised" || mode === "guide" || mode === "human-in-the-loop") {
    return "hitl";
  }
  return "hitl";
}

function normalizeTrustLevel(trustLevel, executionMode = "hitl") {
  if (normalizeExecutionMode(executionMode) === "auto") {
    return "autopilot";
  }
  if (trustLevel === "paranoid") {
    return "paranoid";
  }
  return "balanced";
}

class TaskOrchestrator {
  /**
   * @param {object} opts
   * @param {Function} opts.captureAllScreens
   * @param {object}   opts.sessionManager
   * @param {boolean}  [opts.prePostLayersEnabled]
   * @param {Function} [opts.getApprovalWindow] - returns the floating BrowserWindow for approvals
   */
  constructor({ captureAllScreens, sessionManager, prePostLayersEnabled = true, getApprovalWindow = null }) {
    this.captureAllScreens = captureAllScreens;
    this.sessionManager = sessionManager;
    this.prePostLayersEnabled = prePostLayersEnabled;
    this.interactionPipeline = createInteractionPipeline();
    this.setAwareAssistanceEnabled(prePostLayersEnabled);
    this._getApprovalWindow = getApprovalWindow;
    this._intentRouter = new IntentRouter();
    /** @type {ExecutionEngine|null} */
    this._activeEngine = null;
    this._activePlugin = null;
    this._activeTaskId = null;
    this._activeTrustLevel = null;
    this._pendingDecisionResolve = null;
    this._pendingDecisionListener = null;
    this._pendingDecisionTimeout = null;

    ipcMain.on("execution:trust-override", (_event, payload) => {
      if (!payload?.newTrustLevel) return;
      if (this._activeTaskId && payload?.taskId === this._activeTaskId) {
        this._activeTrustLevel = payload.newTrustLevel;
        logger.info("trust-override", { taskId: this._activeTaskId, newTrustLevel: payload.newTrustLevel });
      }
    });
  }

  getSnapshot() {
    return this.sessionManager.getSnapshot();
  }

  setAwareAssistanceEnabled(enabled) {
    this.prePostLayersEnabled = enabled === true;
    if (this.interactionPipeline && typeof this.interactionPipeline.setEnabled === "function") {
      this.interactionPipeline.setEnabled(this.prePostLayersEnabled);
      if (!this.prePostLayersEnabled && typeof this.interactionPipeline.clear === "function") {
        this.interactionPipeline.clear();
      }
    }
  }

  isAwareAssistanceEnabled() {
    return this.prePostLayersEnabled === true && Boolean(this.interactionPipeline);
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

    if (this.isAwareAssistanceEnabled() && images.length > 0) {
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

    if (this.isAwareAssistanceEnabled() && finalPointer?.coordinate) {
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
    this.sessionManager.clearBrowserExecution();
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
    if (this.isAwareAssistanceEnabled() && images.length > 0) {
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

    if (this.isAwareAssistanceEnabled() && pointer?.coordinate) {
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
    const executionMode = normalizeExecutionMode(settings?.executionMode);

    if (executionMode === "hitl" || executionMode === "auto") {
      return this._runPluginExecutionMode({
        text,
        images,
        settings,
        signal,
        executionMode,
      });
    }

    const nextImages = await this.resolveScreenshots(images);

    return this._startGuideModeSession({
      text,
      images: nextImages,
      settings,
      signal,
    });
  }

  async _startGuideModeSession({ text, images, settings, signal }) {
    this.sessionManager.clearBrowserExecution();
    this.sessionManager.setStatus("planning");
    let plan;
    try {
      plan = await planGoal({
        goal: text,
        images,
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
        images,
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

  async _runPluginExecutionMode({ text, images, settings, signal, executionMode }) {
    const route = await this._intentRouter.route(
      text,
      "",
      registry.listPlugins(),
      settings,
      signal,
    );
    logger.info("intent-router-routed", {
      pluginId: route.pluginId,
      trust: route.trust,
      executionMode,
    });

    if (!route.pluginId) {
      const nextImages = await this.resolveScreenshots(images);
      return this._startGuideModeSession({
        text,
        images: nextImages,
        settings,
        signal,
      });
    }

    let plugin;
    try {
      plugin = registry.getPlugin(route.pluginId);
    } catch (err) {
      const msg = `${route.pluginId} plugin is not available. Falling back to guide mode.`;
      logger.warn("plugin-route-fallback", { pluginId: route.pluginId, error: err?.message });
      this.sessionManager.addMessage({ role: "assistant", content: msg });
      const nextImages = await this.resolveScreenshots(images);
      return this._startGuideModeSession({
        text,
        images: nextImages,
        settings,
        signal,
      });
    }

    const trustLevel = this._resolveRunTrustLevel({ executionMode, route, settings });
    const approvalWindow = this._getApprovalWindow ? this._getApprovalWindow() : null;
    const taskId = route.goal || text;

    this._activePlugin = plugin;
    this._activeTaskId = taskId;
    this._activeTrustLevel = trustLevel;
    this.sessionManager.setActivePlan(null);
    this.sessionManager.setCurrentPointer(null);
    this.sessionManager.startBrowserExecution({
      taskId,
      goal: taskId,
      pluginId: route.pluginId,
      pluginName: plugin.name || route.pluginId,
      mode: executionMode,
      trustLevel,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      finalMessage: "",
      substeps: [],
    });
    this.sessionManager.setStatus("executing");

    try {
      const goalResult = await plugin.runGoal(taskId, {
        trustLevel,
        onSubStep: async (subStep) => this._handleSubStep(subStep, approvalWindow, taskId),
      });

      const summary = goalResult?.summary || (goalResult?.success ? "Goal completed." : "Goal finished with issues.");
      const finalStatus = !goalResult?.success && /abort/i.test(summary)
        ? "aborted"
        : (goalResult?.success ? "success" : "failed");

      if (finalStatus === "aborted") {
        this._sendToApprovalWindow(approvalWindow, "execution:aborted", { taskId });
      }
      this.sessionManager.finishBrowserExecution({
        status: finalStatus,
        finalMessage: summary,
      });
      this.sessionManager.addMessage({
        role: "assistant",
        content: summary,
      });
      this.sessionManager.setStatus("idle");

      return {
        assistantMessage: summary,
        pointer: null,
        session: this.sessionManager.getSnapshot(),
        userInputRequest: null,
      };
    } catch (err) {
      logger.error("plugin-run-goal-error", { pluginId: route.pluginId, error: err?.message });
      const message = `Execution failed: ${err?.message || "Unknown error"}`;
      this.sessionManager.finishBrowserExecution({
        status: "failed",
        finalMessage: message,
      });
      this.sessionManager.addMessage({
        role: "assistant",
        content: message,
      });
      this.sessionManager.setStatus("idle");
      return {
        assistantMessage: message,
        pointer: null,
        session: this.sessionManager.getSnapshot(),
        userInputRequest: null,
      };
    } finally {
      if (this._pendingDecisionResolve) {
        this._pendingDecisionResolve({ decision: "abort" });
        this._pendingDecisionResolve = null;
      }
      if (this._pendingDecisionListener) {
        ipcMain.removeListener("execution:step-decision", this._pendingDecisionListener);
        this._pendingDecisionListener = null;
      }
      if (this._pendingDecisionTimeout) {
        clearTimeout(this._pendingDecisionTimeout);
        this._pendingDecisionTimeout = null;
      }
      this._activePlugin = null;
      this._activeTaskId = null;
      this._activeTrustLevel = null;
    }
  }

  _resolveRunTrustLevel({ executionMode, route, settings }) {
    if (executionMode === "auto") {
      return "autopilot";
    }

    const candidate = normalizeTrustLevel(settings?.trustLevel, executionMode);
    if (candidate === "paranoid" || candidate === "balanced") {
      return candidate;
    }

    return "balanced";
  }

  async _handleSubStep(subStep, approvalWindow, taskId) {
    const normalized = {
      event: subStep?.event || "substep_start",
      stepNumber: Number(subStep?.stepNumber) || 0,
      actionType: subStep?.actionType || "action",
      action: subStep?.action || {},
      description: subStep?.description || "Browser action",
      screenshotBefore: subStep?.screenshotBefore || "",
      screenshotAfter: subStep?.screenshotAfter || "",
      riskScore: Number(subStep?.riskScore) || 3,
      success: typeof subStep?.success === "boolean" ? subStep.success : undefined,
      message: subStep?.message || "",
      error: subStep?.error || null,
      timestamp: Number(subStep?.timestamp) || Date.now(),
    };

    logger.info("browser-substep-progress", {
      taskId,
      event: normalized.event,
      stepNumber: normalized.stepNumber,
      actionType: normalized.actionType,
      description: normalized.description,
      riskScore: normalized.riskScore,
    });

    if (normalized.event === "substep_start") {
      this.sessionManager.upsertBrowserExecutionSubstepStart({
        id: String(normalized.stepNumber || Date.now()),
        stepNumber: normalized.stepNumber,
        actionType: normalized.actionType,
        description: normalized.description,
        riskScore: normalized.riskScore,
        status: "running",
        message: "",
        error: null,
        startedAt: new Date(normalized.timestamp).toISOString(),
        finishedAt: null,
      });
    } else {
      this.sessionManager.upsertBrowserExecutionSubstepEnd({
        id: String(normalized.stepNumber || Date.now()),
        stepNumber: normalized.stepNumber,
        actionType: normalized.actionType,
        description: normalized.description,
        riskScore: normalized.riskScore,
        status: normalized.success === false ? "failed" : "done",
        message: normalized.message || "",
        error: normalized.error || null,
        startedAt: new Date(normalized.timestamp).toISOString(),
        finishedAt: new Date(normalized.timestamp).toISOString(),
      });
    }

    this._sendToApprovalWindow(approvalWindow, "execution:substep-progress", {
      taskId,
      ...normalized,
    });
    this.sessionManager.emitBrowserExecutionSubstepProgress({
      taskId,
      ...normalized,
    });

    if (normalized.event !== "substep_start") {
      return "continue";
    }

    if (String(normalized.actionType || "").toLowerCase() === "done") {
      logger.info("browser-substep-auto-approved", {
        taskId,
        stepNumber: normalized.stepNumber,
        actionType: normalized.actionType,
      });
      return "continue";
    }

    if (this._activeTrustLevel === "autopilot") {
      return "continue";
    }

    const stepId = String(normalized.stepNumber || Date.now());
    logger.info("browser-substep-awaiting-decision", {
      taskId,
      stepId,
      stepNumber: normalized.stepNumber,
      actionType: normalized.actionType,
      description: normalized.description,
      riskScore: normalized.riskScore,
    });
    this._sendToApprovalWindow(approvalWindow, "execution:step-pending", {
      taskId,
        step: {
          id: stepId,
          stepNumber: normalized.stepNumber,
          action: normalized.action,
          actionType: normalized.actionType,
        },
        description: normalized.description,
        riskScore: normalized.riskScore,
      screenshotBefore: normalized.screenshotBefore,
    });

    const decision = await this._waitForUserDecision(stepId, taskId);
    logger.info("browser-substep-decision", {
      taskId,
      stepId,
      stepNumber: normalized.stepNumber,
      actionType: normalized.actionType,
      decision: decision.decision || "continue",
    });
    if (decision.decision === "abort") {
      if (this._activePlugin && typeof this._activePlugin.abort === "function") {
        try {
          await this._activePlugin.abort();
        } catch (err) {
          logger.warn("active-plugin-abort-error", { error: err?.message });
        }
      }
      this._sendToApprovalWindow(approvalWindow, "execution:aborted", { taskId });
      return "abort";
    }
    if (decision.decision === "replan") {
      logger.info("browser-substep-replan-requested", {
        taskId,
        stepId,
        stepNumber: normalized.stepNumber,
      });
      this.sessionManager.upsertBrowserExecutionSubstepEnd({
        id: String(normalized.stepNumber || Date.now()),
        stepNumber: normalized.stepNumber,
        actionType: normalized.actionType,
        description: "Re-planning from the current browser state.",
        riskScore: normalized.riskScore,
        status: "done",
        message: "Re-planning from the current browser state.",
        error: null,
        startedAt: new Date(normalized.timestamp).toISOString(),
        finishedAt: new Date().toISOString(),
      });
      return "replan";
    }
    if (decision.decision === "skip") {
      return "skip";
    }
    return "continue";
  }

  _waitForUserDecision(stepId, taskId) {
    return new Promise((resolve) => {
      if (this._pendingDecisionListener) {
        ipcMain.removeListener("execution:step-decision", this._pendingDecisionListener);
        this._pendingDecisionListener = null;
      }
      if (this._pendingDecisionTimeout) {
        clearTimeout(this._pendingDecisionTimeout);
        this._pendingDecisionTimeout = null;
      }

      const settle = (payload) => {
        if (this._pendingDecisionTimeout) {
          clearTimeout(this._pendingDecisionTimeout);
          this._pendingDecisionTimeout = null;
        }
        if (this._pendingDecisionListener) {
          ipcMain.removeListener("execution:step-decision", this._pendingDecisionListener);
          this._pendingDecisionListener = null;
        }
        this._pendingDecisionResolve = null;
        resolve(payload);
      };

      this._pendingDecisionResolve = settle;
      this._pendingDecisionTimeout = setTimeout(() => {
        logger.warn("decision-timeout", { stepId, taskId });
        settle({ decision: "abort", stepId, taskId });
      }, DECISION_TIMEOUT_MS);

      const onDecision = (_event, payload) => {
        if (payload?.taskId && payload.taskId !== taskId) {
          return;
        }
        if (String(payload?.stepId) !== String(stepId)) {
          return;
        }
        settle(payload);
      };

      this._pendingDecisionListener = onDecision;
      ipcMain.on("execution:step-decision", onDecision);
    });
  }

  _sendToApprovalWindow(approvalWindow, channel, payload) {
    if (approvalWindow && !approvalWindow.isDestroyed()) {
      if ((channel === "execution:step-pending" || channel === "execution:substep-progress") && !approvalWindow.isVisible()) {
        approvalWindow.show();
      }
      approvalWindow.webContents.send(channel, payload);
    }
  }

  /**
   * Run a plan through the ExecutionEngine (supervised / auto modes).
   * Converts planner steps → Steps with browser_action type and enqueues them.
   * @private
   */
  async _runInExecutionMode({ plan, settings, signal, executionMode }) {
    let plugin;
    try {
      plugin = registry.getPlugin('browser');
    } catch (err) {
      const msg = 'Browser agent is not available. Please install it from Settings.';
      this.sessionManager.addMessage({ role: 'assistant', content: msg });
      this.sessionManager.setStatus('idle');
      return {
        assistantMessage: msg,
        pointer: null,
        session: this.sessionManager.getSnapshot(),
        userInputRequest: null,
      };
    }

    const trustLevel = executionMode === 'auto'
      ? 'autopilot'
      : (settings?.trustLevel || 'balanced');

    const approvalWindow = this._getApprovalWindow ? this._getApprovalWindow() : null;

    const engine = new ExecutionEngine({
      plugin,
      trustLevel,
      approvalWindow,
      taskId: plan.goal,
    });
    this._activeEngine = engine;
    engine.listenForTrustOverrides();

    // Convert planner steps to browser_action Steps
    const snapshot = this.sessionManager.getSnapshot();
    const lastScreenshot = snapshot?.lastScreenshots?.[0]?.base64Jpeg || '';

    for (const planStep of (plan.steps || [])) {
      engine.enqueueStep({
        id:        planStep.id || `step_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        type:      'browser_action',
        payload: {
          instruction:     planStep.instruction,
          successCriteria: planStep.successCriteria,
        },
        context: {
          screenshot: lastScreenshot,
          notes:      (planStep.fallbackHints || []).join('; '),
        },
        trustLevel,
      });
    }

    // Wait for all steps to finish (non-blocking in the IPC handler sense —
    // the approval window drives interaction; we just need to update session when done)
    this.sessionManager.setStatus('executing');
    engine.drain().then(() => {
      this._activeEngine = null;
      this.sessionManager.setStatus('idle');
      this.sessionManager.addMessage({
        role: 'assistant',
        content: 'All steps completed. Check the execution log for results.',
      });
    }).catch((err) => {
      logger.error('engine-drain-error', { error: err?.message });
    });

    return {
      assistantMessage: `Executing plan: "${plan.goal}". The approval window will guide you through each step.`,
      pointer: null,
      session: this.sessionManager.getSnapshot(),
      userInputRequest: null,
    };
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
    if (this._pendingDecisionResolve) {
      this._pendingDecisionResolve({ decision: "abort" });
      this._pendingDecisionResolve = null;
    }
    if (this._pendingDecisionListener) {
      ipcMain.removeListener("execution:step-decision", this._pendingDecisionListener);
      this._pendingDecisionListener = null;
    }
    if (this._pendingDecisionTimeout) {
      clearTimeout(this._pendingDecisionTimeout);
      this._pendingDecisionTimeout = null;
    }
    if (this._activeEngine && typeof this._activeEngine.abort === "function") {
      void this._activeEngine.abort().catch((err) => {
        logger.warn("active-engine-abort-error", { error: err?.message });
      });
    }
    if (this._activePlugin && typeof this._activePlugin.abort === "function") {
      void this._activePlugin.abort().catch((err) => {
        logger.warn("active-plugin-abort-error", { error: err?.message });
      });
    }
    this.sessionManager.clearSession();
    if (this.interactionPipeline) {
      this.interactionPipeline.clear();
    }
    return this.sessionManager.getSnapshot();
  }

  abortActiveExecution({ requestId } = {}) {
    logger.info("abort-active-execution", { requestId });
    if (this._pendingDecisionResolve) {
      this._pendingDecisionResolve({ decision: "abort" });
      this._pendingDecisionResolve = null;
    }
    if (this._pendingDecisionListener) {
      ipcMain.removeListener("execution:step-decision", this._pendingDecisionListener);
      this._pendingDecisionListener = null;
    }
    if (this._pendingDecisionTimeout) {
      clearTimeout(this._pendingDecisionTimeout);
      this._pendingDecisionTimeout = null;
    }
    if (this._activeEngine && typeof this._activeEngine.abort === "function") {
      void this._activeEngine.abort().catch((err) => {
        logger.warn("active-engine-abort-error", { error: err?.message });
      });
    }
    if (this._activePlugin && typeof this._activePlugin.abort === "function") {
      void this._activePlugin.abort().catch((err) => {
        logger.warn("active-plugin-abort-error", { error: err?.message });
      });
    }
  }

  cancelActivePlan({ silent = false, requestId } = {}) {
    logger.info("cancel-active-plan", { requestId, silent });
    const hasPlan = Boolean(this.sessionManager.getSnapshot().activePlan) || this.sessionManager.getSnapshot().status === "executing";
    const hasBrowserExecution = Boolean(this.sessionManager.getSnapshot().browserExecution);
    if (this._pendingDecisionResolve) {
      this._pendingDecisionResolve({ decision: "abort" });
      this._pendingDecisionResolve = null;
    }
    if (this._pendingDecisionListener) {
      ipcMain.removeListener("execution:step-decision", this._pendingDecisionListener);
      this._pendingDecisionListener = null;
    }
    if (this._pendingDecisionTimeout) {
      clearTimeout(this._pendingDecisionTimeout);
      this._pendingDecisionTimeout = null;
    }
    if (this._activeEngine && typeof this._activeEngine.abort === "function") {
      void this._activeEngine.abort().catch((err) => {
        logger.warn("active-engine-abort-error", { error: err?.message });
      });
    }
    if (this._activePlugin && typeof this._activePlugin.abort === "function") {
      void this._activePlugin.abort().catch((err) => {
        logger.warn("active-plugin-abort-error", { error: err?.message });
      });
    }
    this.sessionManager.setCurrentPointer(null);
    this.sessionManager.setActivePlan(null);

    const assistantMessage = hasPlan
      ? "Plan cancelled. You can start a new goal anytime."
      : "There is no active plan to cancel.";
    if (hasBrowserExecution && hasPlan) {
      this.sessionManager.finishBrowserExecution({
        status: "aborted",
        finalMessage: assistantMessage,
      });
    }
    this.sessionManager.setStatus("idle");
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
