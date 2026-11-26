# VANTA — Personal Audio & Video OS: Implementation Walkthrough

## Summary of What Was Built (`C:\Vanta`)

We built **VANTA — Personal Audio & Video Operating System** as a standalone desktop project in `C:\Vanta` (completely independent of `c:\SecureShield`), using the **Spotify / Tidal desktop stack** (**Electron + Node.js + Chromium Web Audio DSP Graph + HTML5 Video + `electron-builder` NSIS Setup & Portable Executables**).

### Live Desktop Application Screenshot

![VANTA Live Desktop Window](/C:/Users/ahmt_/.gemini/antigravity/brain/80bbf5fe-f776-422f-a56e-70cb0bfa9d5b/vanta_live_window.png)

---

## Core Modules & File Inventory

### 1. Electron Main Process & Universal Media Services (`C:\Vanta\electron\`)
- [main.cjs](file:///C:/Vanta/electron/main.cjs) & [preload.cjs](file:///C:/Vanta/electron/preload.cjs):
  - Frameless custom desktop window (`1460x900`) with strict security (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`), global media key bindings (`MediaPlayPause`, `MediaNextTrack`, `MediaPreviousTrack`), and the custom `vanta-media://` protocol for zero-CORS streaming of local audio and video into the Chromium Web Audio graph.
- [sunoService.cjs](file:///C:/Vanta/electron/services/sunoService.cjs):
  - Single & batch **Suno** UUID, full `suno.com/song/...` URL, and `suno.com/s/...` shortlink resolver.
  - Downloads `.mp3` (`cdn1.suno.ai/<UUID>.mp3`), `.mp4` video clips (`cdn1.suno.ai/<UUID>.mp4`), and high-res `.jpeg` cover artwork (`cdn2.suno.ai/image_<UUID>.jpeg`) directly into `C:\Vanta\VantaVault\Suno\`, automatically embedding ID3v2 tags and cover art.
- [youtubeService.cjs](file:///C:/Vanta/electron/services/youtubeService.cjs):
  - Interfaces with `yt-dlp` and embedded `ffmpeg-static` to extract `320kbps MP3` audio (with embedded cover art & ID3v2 metadata) and `1080p MP4` video streams into `C:\Vanta\VantaVault\YouTube\`.
- [id3Service.cjs](file:///C:/Vanta/electron/services/id3Service.cjs):
  - Specification-compliant binary **ID3v2.3 / ID3v2.4 Reader & Writer** embedding and parsing `TIT2` (Title), `TPE1` (Artist), `TALB` (Album), `TCON` (Genre/Style), `TBPM` (BPM), `TKEY` (Musical Key), `TSRC` (UUID/ISRC), `USLT` (Lyrics/Prompt), `COMM` (AI Provenance), and `APIC` (JPEG/PNG Cover Artwork).
- [libraryService.cjs](file:///C:/Vanta/electron/services/libraryService.cjs):
  - Recursive media folder scanner (`MP3`, `FLAC`, `WAV`, `M4A`, `AAC`, `OGG`, `OPUS`, `MP4`, `WEBM`, `MKV`), **Quality & Metadata Doctor** (SHA-256 audio payload duplicate detection + 1-click ID3/APIC auto-repair), and **Portable Music Wallet (`.vanta.json`)** exporter.

### 2. Web Audio DSP, MIR Song DNA & 3-Column Master UI (`C:\Vanta\src\`)
- [index.html](file:///C:/Vanta/src/index.html) & [vanta.css](file:///C:/Vanta/src/styles/vanta.css):
  - 100% offline-first 3-Column Desktop UI with **3 live themes** (**`Obsidian`** default, **`Slate`**, **`Ice`**), **15 Custom Duotone Neon SVG Left Sidebar modules** (`Discover`, `Library`, `Sources`) with the glowing violet-cyan gradient-border active pill, **Hero Vibe Banner** with **Circular Batch Progress Ring**, **Tactile Recessed Universal Multi-ID Batch Importer**, **4 Vibe Discovery Cards**, **4-Mode Right Studio Stage** (`Wave` / `🎬 Video` / `💿 Vinyl` / `🎤 Lyric`), **Interactive 8-Band Equalizer**, and **Unified Bottom Master Player Bar**.
- [audioEngine.js](file:///C:/Vanta/src/js/audioEngine.js) & [visualizer.js](file:///C:/Vanta/src/js/visualizer.js):
  - 8-Band Parametric `BiquadFilterNode` Equalizer, Acoustic Device Compensation Profiles (*Headphones Profile*, *Studio Monitors*, *Late-Night Car*, *Concert Hall*), `-14.0 LUFS` Mastering `DynamicsCompressorNode`, Convolver Reverb, Mid-Side Karaoke Vocal Cancellation, Vinyl Soul (Tube Saturation `WaveShaperNode` + procedural needle crackle), Equal-Power Auto-DJ Crossfader, and 60 FPS Rounded-Bar + Curved Spline Spectrum Visualizer.
- [mirAnalyzer.js](file:///C:/Vanta/src/js/mirAnalyzer.js) & [vibeRecommender.js](file:///C:/Vanta/src/js/vibeRecommender.js):
  - PCM onset BPM estimator, Camelot Wheel harmonic key matcher, 6-dimensional **Song DNA** embedding generator, **Natural-Language Semantic Search** parser, **Vibe Radio** contextual bandit recommender, and **Time Capsule** analytics.

---

## Verification & Packaging Results

### 1. Automated Unit & Integration Tests (`6/6 Passing`)
```text
> vanta-os@1.0.0 test
> node --test tests/vanta.test.mjs

✔ 1. Universal Input Parser extracts & deduplicates Suno UUIDs, shortlinks, and YouTube IDs
✔ 2. Binary ID3v2 Engine embeds and parses Title, Artist, BPM, Key, Lyrics, Provenance & APIC Cover Art
✔ 3. Suno HTML Metadata Scraper & Batch Downloader write ID3v2-tagged MP3 files to Vault
✔ 4. Quality Doctor detects duplicates & missing cover art, auto-repairs them, and exports Portable Wallet
✔ 5. Web Audio DSP Math: Tube Saturation & Equal-Power Crossfade conserve energy
✔ 6. MIR Song DNA, PCM BPM Onset Estimator, Semantic Search & Vibe Radio AI
ℹ pass 6 | fail 0
```

### 2. Packaged Windows Setup & Portable Executables (`C:\Vanta\dist\`)
- **Windows Setup Installer (NSIS)**: `C:\Vanta\dist\VANTA Setup 1.0.0.exe` (~103.5 MB)
- **Windows Portable Single-File Executable**: `C:\Vanta\dist\VANTA 1.0.0.exe` (~103.3 MB)
- **Unpacked Instant Executable**: `C:\Vanta\dist\win-unpacked\VANTA.exe`
- **Default Media Vault**: `C:\Vanta\VantaVault\` (`/Suno`, `/YouTube`, `/Local`, `/Exports`)
