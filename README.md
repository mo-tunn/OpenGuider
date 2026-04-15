# OpenGuider

Download [here](https://mo-tunn.github.io/OpenGuider/)

![OpenGuider logo](./renderer/assets/logo.png)

![Landing Deploy](https://img.shields.io/github/actions/workflow/status/mo-tunn/OpenGuider/deploy-landing.yml?branch=main&label=landing%20deploy)
![Release Build](https://img.shields.io/github/actions/workflow/status/mo-tunn/OpenGuider/release-build.yml?label=release%20build)
![Tests](https://img.shields.io/github/actions/workflow/status/mo-tunn/OpenGuider/multi-platform-test.yml?branch=main&label=tests)
![Latest Release](https://img.shields.io/github/v/release/mo-tunn/OpenGuider?label=latest%20release)
![License](https://img.shields.io/github/license/mo-tunn/OpenGuider)

OpenGuider is an Electron desktop assistant that guides users through UI tasks with:

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
- macOS installer: [OpenGuider-macos-latest.zip](https://github.com/mo-tunn/OpenGuider/releases/latest/download/OpenGuider-macos-latest.zip)
- Linux installer: [OpenGuider-linux-latest.zip](https://github.com/mo-tunn/OpenGuider/releases/latest/download/OpenGuider-linux-latest.zip)

## Quick Start

1. Install dependencies: `npm install`
2. Start the app: `npm run start`
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

1. Push a semantic version tag (example: `v0.2.0`).
2. GitHub Actions runs `.github/workflows/release-build.yml`.
3. Installers are attached to the release:
   - `OpenGuider-windows-latest.exe`
   - `OpenGuider-macos-latest.zip`
   - `OpenGuider-linux-latest.zip`

## License

This project is licensed under the GNU General Public License v3.0.  
See [`LICENSE`](./LICENSE) for full terms.

Copyright (C) Metehan Kızılcık

If you create a derivative project, keep these GPLv3 basics:

1. Include the full GPLv3 license text in a `LICENSE` file.
2. Keep copyright notices (including `Metehan Kızılcık`).
3. Share source code of distributed modified versions under GPL-compatible terms.

## Acknowledgement

OpenGuider was originally inspired by Clicky.
