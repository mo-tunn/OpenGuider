Download [here](https://mo-tunn.github.io/OpenGuider/)

# OpenGuider

OpenGuider is an Electron desktop assistant that guides users through UI tasks with:

> OpenGuider was originally inspired by Clicky.

- Multi-provider LLM chat (Claude, OpenAI, Gemini, Groq, OpenRouter, Ollama)
- Screenshot-aware step-by-step planning
- Pointer guidance with screen coordinate hints
- Voice input/output (Web Speech, AssemblyAI, Whisper, Google TTS, OpenAI TTS, ElevenLabs)

## Live Preview

![OpenGuider tutorial](./tutorial.gif)

## Downloads

- Landing page: [https://mo-tunn.github.io/OpenGuider/](https://mo-tunn.github.io/OpenGuider/)
- Latest release: [https://github.com/mo-tunn/OpenGuider/releases/latest](https://github.com/mo-tunn/OpenGuider/releases/latest)
- Windows installer: [OpenGuider-windows-latest.exe](https://github.com/mo-tunn/OpenGuider/releases/latest/download/OpenGuider-windows-latest.exe)
- macOS installer: [OpenGuider-macos-latest.dmg](https://github.com/mo-tunn/OpenGuider/releases/latest/download/OpenGuider-macos-latest.dmg)
- Linux installer: [OpenGuider-linux-latest.AppImage](https://github.com/mo-tunn/OpenGuider/releases/latest/download/OpenGuider-linux-latest.AppImage)

## Quick Start

1. Install dependencies:
   - `npm install`
2. Start the app:
   - `npm run start`
3. Open Settings and configure:
   - AI provider + model + API key
   - Optional voice providers

## Development

- Run with inspector: `npm run dev`
- Run tests: `npm run test`

## Build Installers (Windows/macOS/Linux)

- Build all platform targets on your current OS: `npm run dist`
- Build only Windows NSIS installer (`.exe`): `npm run dist:win`
- Build only macOS installers (`.dmg` + `.zip`): `npm run dist:mac`
- Build only Linux packages (`.AppImage` + `.deb`): `npm run dist:linux`
- Output artifacts are written to `release/`

Installer behavior:

- Windows uses NSIS `oneClick` installer flow.
- Installer requests elevation automatically when required.
- Desktop and Start Menu shortcuts are created automatically.

## Architecture

- `main.js`: Electron main process (cross-platform lifecycle, IPC, tray, shortcuts, orchestration hooks)
- `preload.js`: Secure renderer bridge
- `src/ai/*`: Provider clients + structured response helpers
- `src/agent/*`: Planner / evaluator / replanner / orchestrator chains
- `src/session/*`: Session state model + persistence helpers
- `renderer/*`: Panel, widget, settings, cursor overlay UI

## Security Notes

- API keys are persisted via OS-protected secure storage (`keytar`) when available.
- If keychain is unavailable, encrypted fallback storage is used through Electron safe storage.
- Renderer runs with `contextIsolation: true` and `nodeIntegration: false`.
- Application data is stored in Electron `userData` path under a stable app identity (`OpenGuider`) so updates keep local settings/history.

## GitHub Release Automation

- Push a semantic version tag (example: `v0.2.0`) to trigger multi-platform release builds.
- Workflow: `.github/workflows/release-build.yml`
- The workflow builds artifacts on Windows/macOS/Linux and publishes them to the GitHub Release for that tag.

## Logging and Crash Reporting

- JSON structured logs are written under the app user-data logs directory.
- Log rotation keeps recent files and caps single-file size.
- Crash hooks capture:
  - `uncaughtException`
  - `unhandledRejection`
  - renderer process crash / gone events
- Runtime performance telemetry captures:
  - `ipc.capture-screenshot`
  - `ipc.start-goal-session`
  - `ipc.submit-user-message`
  - `ipc.send-message`
  - plus screenshot internal timing breakdown (`getSources`, `encode`, cache-hit)

## Provider Matrix

- **LLM**: Claude, OpenAI, Gemini, Groq, OpenRouter, Ollama
- **STT**: Web Speech, AssemblyAI, Whisper-compatible endpoint
- **TTS**: Google Translate TTS, OpenAI TTS, ElevenLabs

## Platform Readiness

- **Windows**: Fully usable for core AI/STT/TTS flows.
- **Linux**: Fully usable for core AI/STT/TTS flows.
- **macOS**: Fully usable for core AI/STT/TTS flows.

Runtime guard behavior:

- If an unsupported `ttsProvider` value is loaded/saved, settings are normalized to `google`.

## Known Limitations

- UI smoke tests are structural (DOM/id-level), not full browser automation tests.
- Pointer placement now uses per-display calibration from recent screenshots, but still depends on model output quality.
- Network/provider errors depend on each provider's API behavior and quotas.

## Test Coverage Included

- Unit:
  - `parsePointTag`
  - `normalizePlan`
  - `extractJSONObject`
- Integration:
  - `TaskOrchestrator` single-step manual completion flow
- UI smoke:
  - Panel control + onboarding/error container presence
  - Widget action controls presence
