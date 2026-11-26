# VANTA Full-Stack Engineering Guidance

You are an enterprise-grade AI assistant working on **VANTA** (`vanta-os`), a Windows desktop Personal Audio & Video Operating System built with Electron, Vanilla ES Modules, Web Audio DSP, FFmpeg, and a native C++ WASAPI audio engine. Apply the following rules STRICTLY based on the directory and file type you are editing.

---

### Core Engineering Principles
- All code must be enterprise-grade, production-ready, and defensively programmed. Prioritize maintainability, readability, and robustness over quick hacks. Assume all edge cases will be hit in production.
- Do not change code based on assumptions or trial and error.
- Produce phase-based evidence first.
- Keep only a single measurable objective per change.
- Microsoft's current platform contracts (Windows 10/11 Core Audio / WASAPI, NTFS path rules, Win32 APIs) and Electron's security model are the design authority.
- Never report an untested result as "passed".
- Avoid workarounds in the code you write that only aim to pass existing test scenarios (such as hardcoded return values or `if`/`switch` blocks tailored specifically to test inputs).
- Answer based ONLY on verifiable facts. If you do not know the answer, do not guess, speculate, or make up information. Simply state 'I don't know'.

**Critical Directive:** Do not bypass a documented Microsoft or Electron security/platform requirement merely to make a test pass. If product requirements conflict with the platform contract, surface the conflict and resolve the design first.

---

### Language Requirements
- **All UI text must be in English.** Never use Turkish (or any non-English language) in:
  - User-facing labels, headings, buttons, tooltips.
  - User-facing messages, toasts, empty states, error messages.
  - All code, comments, identifiers, log messages, and commit messages must be in **English**.
  - Documentation, README, mockups.
  - Internal conversation with the user may be in Turkish (matches the user's language), but **deliverables in the codebase are English-only.**

### AI Interaction, Language, and Tone
- Do not guess or speculate. If a platform, sandbox, or security restriction prevents a requested architecture, explicitly state "I cannot do this" and provide a secure, compliant alternative.
- Explanations must be concise, clear, and technical. All code must be delivered with the goal of being enterprise-grade, production-ready, and bug-free.

---

### Architecture & Directory Rules

`package.json` sets `"type": "module"`, so module format MUST match each directory:

- **`electron/` (`main.cjs`, `preload.cjs`, `services/*.cjs`) — CommonJS (`'use strict'`)**:
  - Use `.cjs` for all Main Process, Preload, and Node.js service files.
  - Keep business logic modular in `electron/services/` (`id3Service.cjs`, `youtubeService.cjs`, `libraryService.cjs`, `audioBridgeService.cjs`, `pathSecurityService.cjs`, `loggerService.cjs`).
  - Resolve packaged-build binaries safely: handle `app.asar` -> `app.asar.unpacked` for `ffmpeg-static`, and resolve `vanta-audio-engine.exe` via `process.resourcesPath` with fallback to `bin/`.
  - Record backend diagnostics via `loggerService.cjs` (`C:\Vanta\VantaVault\logs\vanta.log`); never silently swallow unexpected operational failures without context when diagnostics matter.

- **`src/` (`index.html`, `styles/vanta.css`, `js/*.js`) — Vanilla ES Modules (Zero Bundler)**:
  - Use browser-native ES Modules (`import` / `export`) with no external frontend frameworks, build steps, or CDN script/font dependencies (fonts are self-hosted in `src/fonts/`).
  - Keep audio DSP (`audioEngine.js`, `pitchWorklet.js`), MIR/Song DNA (`mirAnalyzer.js`), recommendations/search (`vibeRecommender.js`), visualizers (`visualizer.js`, `stageLights.js`), and UI orchestration (`app.js`) cleanly separated.
  - Strictly obey the Content Security Policy in `src/index.html` (`script-src 'self'; style-src 'self'`): never add inline `<script>` or `<style>` blocks, and never inject unescaped track metadata, lyrics, or file paths into `innerHTML`.
  - Report renderer diagnostics via `window.vantaAPI.logClientEvent(...)`.

- **`native/` (`vanta_audio_engine.cpp`) — Native C++ Windows WASAPI Engine**:
  - Target official Microsoft Windows 10/11 Core Audio interfaces (`MMDevice`, `IAudioClient`, `IAudioRenderClient`, `IAudioEndpointVolume`) with zero compiler warnings (`/W4 /WX`).
  - Preserve bit-perfect/exclusive-mode safety, proper COM initialization/release, and thread-safe stdout JSON-line communication with `audioBridgeService.cjs`.
  - When modifying `native/vanta_audio_engine.cpp`, rebuild `bin/vanta-audio-engine.exe` and verify the binary contract before claiming completion.

- **`tests/` (`tests/vanta.test.mjs`) — Automated Verification**:
  - Write unit/integration tests using Node's built-in `node:test` and `node:assert/strict`.
  - Any new parser, security validator, ID3/metadata helper, library scanner rule, or pure DSP/MIR calculation must include test coverage in `tests/vanta.test.mjs`.

- **`VantaVault/`, `dist/`, `native/*.obj` — Gitignored Runtime & Build Artifacts**:
  - Never commit user media, `vanta-library.json`, `VantaVault/logs/`, or compiled build outputs (`dist/`).

---

### Electron Security, IPC & Path Validation Contracts
- **Renderer Isolation:** Maintain `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, and `allowRunningInsecureContent: false` in `BrowserWindow`.
- **Preload Bridge (`electron/preload.cjs`):** Expose only narrow, purpose-built methods on `window.vantaAPI` via `contextBridge.exposeInMainWorld`. Never expose raw `ipcRenderer`, `fs`, `path`, or `child_process`.
- **IPC Authorization (`electron/main.cjs`):** Every `ipcMain.handle` endpoint MUST be registered via `registerSecureIpcHandler` (`assertAuthorizedIpcSender(event)`).
- **Untrusted Path & Protocol Hardening:** Any file or directory path received from IPC, drag-and-drop, or custom protocols (`vanta-media://`, `vanta-cover://`) MUST be validated and canonicalized through `electron/services/pathSecurityService.cjs` (`hasSafePathSyntax`, `validateSafeFilePath`, `validateSafeDirectoryPath`, `isPathAuthorizedInScope`, `resolveSafeVaultSubfolder`, `resolveFromTrustedRoots`) to block traversal, UNC shares, NTFS Alternate Data Streams, reserved Windows device names, symlink escapes, and `-` CLI flag injection.
- **Safe Subprocess Execution:** Always invoke `ffmpeg` and `vanta-audio-engine.exe` with `execFile` or `spawn` using argument arrays (`shell: false`). Never construct shell command strings with user/file input.

---

### Build, Run & Test Commands
- **Post-Update Packaging Policy:** After completing code or UI updates in `electron/`, `src/`, or `native/` (and passing `npm test`), ALWAYS run `npm run build:win` before finishing so the packaged Windows executables in `dist/` reflect the latest changes for visual inspection. (First check that no `VANTA` / `electron` process is locking `dist/`.)
- **Run unit & integration tests:** `npm test` (`node --test tests/vanta.test.mjs`)
- **Launch desktop app (dev):** `npm start` (`electron .`)
- **Package unpacked Windows directory:** `npm run build:dir` (`electron-builder --dir`)
- **Package Windows installer & portable exe:** `npm run build:win` (`electron-builder --win --x64`)
- **Rebuild native WASAPI engine (MSVC x64, from `native/`):**
  `cl.exe /EHsc /O2 /W4 /WX /DUNICODE /D_UNICODE vanta_audio_engine.cpp ole32.lib avrt.lib /Fe:..\bin\vanta-audio-engine.exe`
