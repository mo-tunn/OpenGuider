const Store = require("electron-store");
const schema = {
  aiProvider:   { type:"string", enum:["claude","openai","gemini","groq","ollama","openrouter"], default:"claude" },
  aiModel:      { type:"string", default:"" },
  claudeApiKey:     { type:"string", default:"" },
  claudeModelCustom: { type:"string", default:"" },
  // Custom base URL for Claude (e.g. proxy or compatible API); defaults to official Anthropic endpoint
  claudeBaseUrl:    { type:"string", default:"https://api.anthropic.com" },

  openaiApiKey:     { type:"string", default:"" },
  openaiModelCustom: { type:"string", default:"" },
  // Custom base URL for OpenAI (e.g. Azure OpenAI or local proxy); defaults to official OpenAI endpoint
  openaiBaseUrl:    { type:"string", default:"https://api.openai.com/v1" },

  geminiApiKey:     { type:"string", default:"" },
  geminiModelCustom: { type:"string", default:"" },
  // Custom base URL for Gemini; defaults to official Google Generative Language API endpoint
  geminiBaseUrl:    { type:"string", default:"https://generativelanguage.googleapis.com/v1beta" },

  groqApiKey:     { type:'string', default:'' },
  groqModelCustom: { type:'string', default:'' },
  // Custom base URL for Groq (e.g. a Groq-compatible service); defaults to official Groq endpoint
  groqBaseUrl:    { type:"string", default:"https://api.groq.com/openai/v1" },

  openrouterApiKey: { type:'string', default:'' },
  openrouterModelCustom: { type:'string', default:'' },
  openrouterMaxTokens: { type:"number", default:2048 },
  // Custom base URL for OpenRouter; defaults to official OpenRouter endpoint
  openrouterBaseUrl: { type:"string", default:"https://openrouter.ai/api/v1" },

  ollamaUrl:    { type:"string", default:"http://localhost:11434" },
  ollamaModelCustom: { type:"string", default:"" },
  sttProvider:  { type:"string", enum:["assemblyai","whisper"], default:"assemblyai" },
  assemblyaiApiKey: { type:"string", default:"" },
  whisperApiKey:    { type:"string", default:"" },
  whisperBaseUrl:   { type:"string", default:"https://api.openai.com/v1" },
  whisperModel:     { type:"string", default:"whisper-1" },
  sttLanguage:  { type:"string", default:"en-US" },
  ttsProvider:  { type:"string", enum:["google","elevenlabs","openai"], default:"google" },
  openaiTtsApiKey: { type:"string", default:"" },
  openaiTtsBaseUrl: { type:"string", default:"https://api.openai.com/v1" },
  openaiTtsModel: { type:"string", default:"tts-1" },
  openaiTtsVoice: { type:"string", default:"nova" },
  ttsRate: { type:"number", default:1.5 },
  ttsVolume: { type:"number", default:1 },
  ttsEnabled:   { type:"boolean", default:true },
  elevenlabsApiKey:   { type:"string", default:"" },
  elevenlabsVoiceId:  { type:"string", default:"EXAVITQu4vr4xnSDxMaL" },
  pushToTalkShortcut: { type:"string", default:"Ctrl+Shift+Space" },
  markStepDoneShortcut: { type:"string", default:"Ctrl+Alt+1" },
  requestStepHelpShortcut: { type:"string", default:"Ctrl+Alt+2" },
  recheckCurrentStepShortcut: { type:"string", default:"Ctrl+Alt+3" },
  cancelActivePlanShortcut: { type:"string", default:"Ctrl+Alt+4" },
  previousStepShortcut: { type:"string", default:"Ctrl+Alt+5" },
  skipCurrentStepShortcut: { type:"string", default:"Ctrl+Alt+6" },
  regenerateCurrentStepShortcut: { type:"string", default:"Ctrl+Alt+7" },
  executionMode: { type:"string", enum:["hitl","auto"], default:"hitl" },
  trustLevel: { type:"string", enum:["paranoid","balanced","autopilot"], default:"balanced" },
  browserAgentEnabled: { type:"boolean", default:true },
  browserHeadless: { type:"boolean", default:false },
  awareAssistanceEnabled: { type:"boolean", default:false },
  includeScreenshotByDefault: { type:"boolean", default:true },
  systemPromptOverride: { type:"string", default:"" },
  planningModeEnabled: { type:"boolean", default:false },
  assistantMode: { type:"string", enum:["planning","fast"], default:"fast" },
  onboardingCompleted: { type:"boolean", default:false },
  panelWindowX: { type:"number", default:-1 },
  panelWindowY: { type:"number", default:-1 },
  sessionSnapshotV1: { type: ["object", "null"], default: null },
};
function createStore() { return new Store({ schema, clearInvalidConfig: true }); }
module.exports = { createStore, schema };
