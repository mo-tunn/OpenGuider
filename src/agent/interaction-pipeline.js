const ocrEngine = require("../perception/ocr-engine");
const windowEnum = require("../perception/window-enum");
const embeddingMatcher = require("../context/embedding-matcher");
const promptEnricher = require("../context/prompt-enricher");
const elementResolver = require("../perception/ui-scanner");
const boundsValidator = require("../validation/bounds-validator");
const embeddingVerifier = require("../validation/semantic-verifier");
const { createFallbackManager } = require("./fallback-manager");
const { ElementCache } = require("../session/element-cache");
const { debugLog, DEBUG } = require("../utils/debug-logger");
const { analyzeContext } = require("../context/context-analyzer");

function logPreLayer(data) {
  debugLog("Pre-LLM", data);
}

function logPostLayer(data) {
  debugLog("Post-LLM", data);
}

class InteractionPipeline {
  constructor() {
    this.elementCache = new ElementCache();
    this.fallbackManager = createFallbackManager();
    this.ocrResult = null;
    this.windowInfo = null;
    this.uiElements = [];
    this.enabled = true;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
  }

  isDebugEnabled() {
    return DEBUG;
  }

  async preprocess({ images, step, sessionId, signal }) {
    if (!this.enabled) {
      return { enrichedPrompt: null, ocrResult: null, windowInfo: null, matchedElements: [] };
    }
    let ocrResult = null;
    let windowInfo = null;
    let matchedElements = [];
    try {
      logPreLayer("Starting preprocess...");
      if (images && images.length > 0 && images[0].base64Jpeg) {
        const imageBuffer = Buffer.from(images[0].base64Jpeg, "base64");
        logPreLayer("Running OCR on screenshot...");
        ocrResult = await ocrEngine.recognizeFromBuffer(imageBuffer);
        this.ocrResult = ocrResult;
        logPreLayer(`OCR complete: ${ocrResult.words?.length || 0} words, ${ocrResult.lines?.length || 0} lines, confidence: ${ocrResult.confidence?.toFixed(1)}%`);
      } else {
        logPreLayer("No image provided to OCR");
      }
      logPreLayer("Enumerating windows...");
      windowInfo = await windowEnum.enumerateActiveApp();
      this.windowInfo = windowInfo;
      logPreLayer(`Windows: focused="${windowInfo?.focusedWindow?.title || 'none'}", cursor: (${windowInfo?.cursorPosition?.x}, ${windowInfo?.cursorPosition?.y}), visible: ${windowInfo?.windows?.length || 0}`);
      if (step && step.instruction) {
        const instructionText = step.instruction;
        logPreLayer(`Matching elements for instruction: "${instructionText}"`);
        matchedElements = await this.findMatchingElements(instructionText, sessionId);
        this.elementCache.addBatch(sessionId, matchedElements);
        logPreLayer(`Matched ${matchedElements.length} elements`);
      }
    } catch (error) {
      console.error("[Pre-LLM] Error:", error.message);
    }
    return { ocrResult, windowInfo, matchedElements };
  }

  async findMatchingElements(query, sessionId) {
    const ocrResult = this.ocrResult;
    if (!query || !ocrResult) return [];
    const candidates = [];
    if (ocrResult.words) {
      for (const word of ocrResult.words) {
        candidates.push({
          text: word.text,
          bbox: word.bbox,
          type: "ocr",
        });
      }
    }
    if (ocrResult.lines) {
      for (const line of ocrResult.lines) {
        candidates.push({
          text: line.text,
          bbox: line.bbox,
          type: "ocr-line",
        });
      }
    }
    if (candidates.length === 0) return [];
    const embedded = await embeddingMatcher.embedElements(candidates, "text");
    const matches = await embeddingMatcher.findTopMatches(query, embedded, 10);
    return matches;
  }

  buildEnrichedContext(originalPrompt, context) {
    return promptEnricher.buildEnrichedPrompt({
      originalPrompt,
      ocrResult: context.ocrResult,
      windowInfo: context.windowInfo,
      matchedElements: context.matchedElements,
    });
  }

  async distillContext(originalPrompt, context, settings) {
    if (!this.enabled) return originalPrompt;
    
    // Call the fast text-only model to create a summary
    const summary = await analyzeContext(originalPrompt, context, settings);
    
    // Append the summary cleanly to the prompt
    return `${originalPrompt}\n\n---\n[SYSTEM ANALYSIS OF SCREEN STATE]\n${summary}`;
  }

  async postprocess({ coordinate, label, step, sessionId, signal, options = {} }) {
    if (!this.enabled) {
      return {
        coordinate,
        verified: true,
        reason: "layers disabled",
        confidence: 1,
      };
    }
    let validatedCoordinate = coordinate;
    let verification = null;
    let boundsCheck = null;
    let snapped = null;
    try {
      logPostLayer(`Starting postprocess: raw coords (${coordinate?.x}, ${coordinate?.y}), label="${label || 'none'}"`);

      boundsCheck = boundsValidator.validateCoordinate(coordinate);
      logPostLayer(`Bounds check: valid=${boundsCheck?.valid}, reason=${boundsCheck?.reason || 'none'}`);
      if (boundsCheck && !boundsCheck.valid && boundsCheck.clamped) {
        validatedCoordinate = boundsCheck.clamped;
        logPostLayer(`Clamped to: (${validatedCoordinate.x}, ${validatedCoordinate.y})`);
      }

      logPostLayer("Querying UI Automation elements...");
      this.uiElements = await elementResolver.queryUIAutomation();
      logPostLayer(`Found ${this.uiElements.length} UI elements`);

      if (this.uiElements.length > 0 && coordinate && label) {
        const matched = elementResolver.findMatchingElements(label, this.uiElements);
        logPostLayer(`Matched ${matched.length} elements for label "${label}"`);
        if (matched.length > 0) {
          // LLM coordinate can be slightly off. If there's 1 exact match on screen, snap aggressively up to 200px.
          // Otherwise use a default tolerance of 100px.
          const customTolerance = matched.length === 1 ? 200 : 100;
          const snapResult = elementResolver.snapToNearestElement(coordinate, matched, customTolerance);
          if (snapResult) {
            snapped = snapResult;
            validatedCoordinate = snapResult.snappedCoordinate;
            logPostLayer(`Snapped to element: (${validatedCoordinate.x}, ${validatedCoordinate.y}), dist=${snapResult.distance.toFixed(1)}px`);
          }
        }
      }
      if (validatedCoordinate && label) {
        verification = await embeddingVerifier.verifyCoordinateWithElements(
          validatedCoordinate,
          label,
          this.uiElements,
          { tolerance: 100 }
        );
        logPostLayer(`Embedding verification: verified=${verification?.verified}, reason=${verification?.reason}, score=${verification?.score?.toFixed(2) || 'none'}`);
      }
    } catch (error) {
      console.error("[Post-LLM] Error:", error.message);
    }
    if (validatedCoordinate) {
      this.fallbackManager.record(validatedCoordinate, "postprocess");
    }
    const confidence = this.calculateConfidence({
      boundsCheck,
      verification,
      snapped: !!snapped,
    });
    logPostLayer(`Final: confidence=${confidence.toFixed(2)}, coords=(${validatedCoordinate?.x}, ${validatedCoordinate?.y})`);
    return {
      coordinate: validatedCoordinate,
      verified: verification?.verified || false,
      reason: verification?.reason || boundsCheck?.reason || "unknown",
      confidence,
      snapped: snapped ? snapped.element : null,
      boundsClamped: boundsCheck?.clamped ? true : false,
    };
  }

  calculateConfidence(options = {}) {
    const { boundsCheck, verification, snapped } = options;
    let confidence = 0.5;
    if (boundsCheck?.valid) confidence += 0.2;
    if (verification?.verified) confidence += 0.2;
    if (snapped) confidence += 0.1;
    return Math.min(1, Math.max(0, confidence));
  }

  getFallbackCoordinate() {
    return this.fallbackManager.getFallbackCoordinate();
  }

  shouldRecheck(coordinate) {
    return this.fallbackManager.shouldRecheck({ coordinate });
  }

  clear(sessionId) {
    if (sessionId) {
      this.elementCache.clear(sessionId);
    }
    this.ocrResult = null;
    this.windowInfo = null;
    this.uiElements = [];
    this.fallbackManager.clear();
  }

  getCachedElements(sessionId) {
    return this.elementCache.get(sessionId);
  }
}

function createInteractionPipeline() {
  return new InteractionPipeline();
}

module.exports = {
  InteractionPipeline,
  createInteractionPipeline,
};