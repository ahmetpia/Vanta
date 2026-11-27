/**
 * @fileoverview VANTA Score Studio — Fullscreen Sheet Music, Piano Roll & Practice Controller (Phase 9.3).
 * Zero-bundler Vanilla ES Module strictly adhering to CSP (`style-src 'self'`, `script-src 'self'`).
 */

import {
  buildScoreModel,
  decomposeTicksToNotation,
  midiToNoteName,
  normalizeAnalysisWindowBounds,
  parseTimeWindowInput
} from './scoreAnalyzer.js';
import { buildMidiBytes, buildMusicXml } from './scoreExporter.js';
import { ScoreSynth, renderScoreAudioWav } from './scoreSynth.js';

const MEASURES_PER_PAGE = 12;
const BARS_PER_SYSTEM = 3;
const MAX_SCORE_WINDOW_SEC = 480;

function formatTimeSec(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }
  return `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * Converts a measure's events for one staff into VexFlow StaveNotes + explicit rests,
 * decomposes non-standard beat totals into intra-bar tied notes, and tracks barline ties.
 * @private
 */
function groupMeasureEventsByTick(events) {
  const groups = [];
  for (const ev of events) {
    const last = groups[groups.length - 1];
    if (last && last.tick === ev.startTickInMeasure) {
      last.notes.push(ev);
    } else {
      groups.push({ tick: ev.startTickInMeasure, notes: [ev] });
    }
  }
  return groups;
}

/**
 * Splits polyphonic events on one staff into upper (Voice 1, stems up) and lower sustained
 * accompaniment (Voice 2, stems down) whenever a held note overlaps later attacks by >120 ticks.
 * @private
 */
function partitionEventsTwoVoices(events, measureTicks) {
  const rawGroups = groupMeasureEventsByTick(events);
  let hasOverlap = false;
  for (let i = 0; i + 1 < rawGroups.length; i++) {
    const gap = rawGroups[i + 1].tick - rawGroups[i].tick;
    if (rawGroups[i].notes.some((n) => n.durTicks > gap + 120)) {
      hasOverlap = true;
      break;
    }
  }
  if (!hasOverlap || rawGroups.length <= 1) {
    return [events];
  }

  const v1 = [];
  const v2 = [];
  let v1Free = 0;
  let v2Free = 0;

  for (let gi = 0; gi < rawGroups.length; gi++) {
    const grp = rawGroups[gi];
    const t = grp.tick;
    const nextT = gi + 1 < rawGroups.length ? rawGroups[gi + 1].tick : measureTicks;
    const slotGap = Math.max(60, nextT - t);
    const futureMeanPitch = gi + 1 < rawGroups.length
      ? rawGroups[gi + 1].notes.reduce((a, b) => a + b.pitch, 0) / rawGroups[gi + 1].notes.length
      : 0;

    // Sort highest pitch first within this tick
    const sorted = [...grp.notes].sort((a, b) => b.pitch - a.pitch);
    const hasLong = sorted.some((n) => n.durTicks > slotGap + 120);
    const hasShort = sorted.some((n) => n.durTicks <= slotGap + 120);

    for (const ev of sorted) {
      const isHeldAcrossNext = ev.durTicks > slotGap + 120;
      let assignV2 = false;

      if (t < v1Free && t >= v2Free) {
        assignV2 = true;
      } else if (hasLong && hasShort) {
        assignV2 = isHeldAcrossNext && ev.pitch <= sorted[0].pitch && t >= v2Free;
      } else if (isHeldAcrossNext && gi + 1 < rawGroups.length) {
        // Lower sustained pedal/root under higher incoming notes goes to Voice 2
        assignV2 = ev.pitch < futureMeanPitch && t >= v2Free;
      }

      if (assignV2) {
        v2.push(ev);
        v2Free = Math.max(v2Free, t + Math.min(measureTicks - t, ev.durTicks));
      } else {
        v1.push(ev);
        v1Free = Math.max(v1Free, t + Math.min(measureTicks - t, ev.durTicks));
      }
    }
  }

  if (!v1.length || !v2.length) {
    return [events];
  }
  return [v1, v2];
}

/**
 * Builds one monophonic/chordal VexFlow voice with exact rests and tie metadata.
 * @private
 */
function buildSingleVexVoice(VF, events, measure, clef, voiceOpts = {}) {
  const measureTicks = measure.endTick - measure.startTick;
  const rawGroups = groupMeasureEventsByTick(events);

  // Smooth tiny inter-note gaps (< 180 ticks) to avoid cluttering 16th/32nd micro-rests
  const groups = rawGroups.map((g, idx) => {
    const nextTick = idx + 1 < rawGroups.length ? rawGroups[idx + 1].tick : measureTicks;
    const maxSlot = Math.max(60, nextTick - g.tick);
    const rawDur = Math.max(60, Math.min(maxSlot, g.notes[0].durTicks));
    const gapToNext = nextTick - (g.tick + rawDur);
    const snappedDur = gapToNext > 0 && gapToNext < 180 ? maxSlot : rawDur;
    return { tick: g.tick, durTicks: snappedDur, nextTick, notes: g.notes };
  });

  const staveNotes = [];
  const noteTimingMap = [];
  const intraTies = [];
  const crossTieOut = [];
  const crossTieIn = [];
  let cursor = 0;
  let renderedTicks = 0;
  const restKey = voiceOpts.restKey || (clef === 'bass' ? 'd/3' : 'b/4');
  const stemDirection = voiceOpts.stemDirection || 0;

  const pushRestSpan = (gapTicks) => {
    const snappedGap = Math.max(0, Math.round(gapTicks / 60) * 60);
    if (snappedGap < 60) return;
    const parts = decomposeTicksToNotation(snappedGap);
    let left = snappedGap;
    for (const part of parts) {
      if (left < 60) break;
      const sn = new VF.StaveNote({
        clef,
        keys: [restKey],
        duration: `${part.vf}r`,
        dots: part.dots || 0
      });
      if (part.dots > 0) VF.Dot.buildAndAttach([sn]);
      staveNotes.push(sn);
      noteTimingMap.push({ staveNote: sn, events: [] });
      cursor += part.ticks;
      renderedTicks += part.ticks;
      left -= part.ticks;
    }
  };

  for (const grp of groups) {
    const targetTick = Math.max(cursor, Math.round(grp.tick / 60) * 60);
    if (targetTick >= measureTicks) break;
    if (targetTick > cursor) {
      pushRestSpan(targetTick - cursor);
    }

    const maxAvail = Math.max(60, Math.min(measureTicks - cursor, grp.nextTick - cursor));
    const durTicks = Math.min(maxAvail, Math.max(60, Math.round(grp.durTicks / 60) * 60));
    const parts = decomposeTicksToNotation(durTicks);
    const keys = grp.notes.map((ev) => ev.vexKey || 'c/4');
    const partNotes = [];

    let remDur = durTicks;
    for (const part of parts) {
      if (remDur < 60 || cursor + part.ticks > measureTicks) break;
      const noteSpec = {
        clef,
        keys,
        duration: part.vf,
        dots: part.dots || 0
      };
      if (stemDirection === 1 || stemDirection === -1) {
        noteSpec.stemDirection = stemDirection;
      } else {
        noteSpec.autoStem = true;
      }
      const sn = new VF.StaveNote(noteSpec);
      if (part.dots > 0) VF.Dot.buildAndAttach([sn]);
      staveNotes.push(sn);
      noteTimingMap.push({ staveNote: sn, events: grp.notes });
      partNotes.push(sn);
      cursor += part.ticks;
      renderedTicks += part.ticks;
      remDur -= part.ticks;
    }

    // Connect compound split durations (e.g., quarter + 16th) inside the same bar via StaveTie
    for (let p = 0; p + 1 < partNotes.length; p++) {
      const idxList = keys.map((_, kIdx) => kIdx);
      intraTies.push({
        firstNote: partNotes[p],
        lastNote: partNotes[p + 1],
        firstIndexes: idxList,
        lastIndexes: idxList
      });
    }

    if (partNotes.length) {
      const firstSn = partNotes[0];
      const lastSn = partNotes[partNotes.length - 1];
      if (grp.tick === 0) {
        grp.notes.forEach((ev, kIdx) => {
          if (ev.tieEnd) {
            crossTieIn.push({ sourceNoteId: ev.sourceNoteId, pitch: ev.pitch, staveNote: firstSn, keyIndex: kIdx });
          }
        });
      }
      if (cursor >= measureTicks) {
        grp.notes.forEach((ev, kIdx) => {
          if (ev.tieStart) {
            crossTieOut.push({ sourceNoteId: ev.sourceNoteId, pitch: ev.pitch, staveNote: lastSn, keyIndex: kIdx });
          }
        });
      }
    }
  }

  if (measureTicks - cursor >= 60) {
    pushRestSpan(measureTicks - cursor);
  }

  // Fallback exact measure rest(s) matching time signature if bar has no notes for this clef
  if (!staveNotes.length) {
    if (measureTicks === 1920) {
      const wholeRest = new VF.StaveNote({ clef, keys: [restKey], duration: 'wr' });
      staveNotes.push(wholeRest);
      noteTimingMap.push({ staveNote: wholeRest, events: [] });
      renderedTicks = measureTicks;
    } else {
      pushRestSpan(measureTicks);
      if (!staveNotes.length) {
        const wholeRest = new VF.StaveNote({ clef, keys: [restKey], duration: 'wr' });
        staveNotes.push(wholeRest);
        noteTimingMap.push({ staveNote: wholeRest, events: [] });
      }
    }
  }

  const mode = renderedTicks === measureTicks ? VF.Voice.Mode.STRICT : VF.Voice.Mode.SOFT;
  const voice = new VF.Voice({
    numBeats: measure.num || 4,
    beatValue: measure.den || 4
  }).setMode(mode);
  voice.addTickables(staveNotes);

  return { voice, staveNotes, noteTimingMap, intraTies, crossTieOut, crossTieIn };
}

/**
 * Converts a measure's events for one staff into 1 or 2 VexFlow Voices (preserving sustained bass/pedal
 * notes beneath moving melodic phrases), decomposes non-standard beat totals into intra-bar ties,
 * and collects barline tie endpoints cleanly.
 * @private
 */
export function buildVexVoiceData(VF, events, measure, clef) {
  const measureTicks = measure.endTick - measure.startTick;
  const voiceGroups = events.length ? partitionEventsTwoVoices(events, measureTicks) : [[]];

  if (voiceGroups.length === 1) {
    const single = buildSingleVexVoice(VF, voiceGroups[0], measure, clef);
    return {
      ...single,
      voices: [single.voice],
      voiceNoteLists: [single.staveNotes]
    };
  }

  const v1 = buildSingleVexVoice(VF, voiceGroups[0], measure, clef, {
    stemDirection: 1,
    restKey: clef === 'bass' ? 'e/3' : 'c/5'
  });
  const v2 = buildSingleVexVoice(VF, voiceGroups[1], measure, clef, {
    stemDirection: -1,
    restKey: clef === 'bass' ? 'c/3' : 'a/4'
  });

  return {
    voice: v1.voice,
    voices: [v1.voice, v2.voice],
    staveNotes: [...v1.staveNotes, ...v2.staveNotes],
    voiceNoteLists: [v1.staveNotes, v2.staveNotes],
    noteTimingMap: [...v1.noteTimingMap, ...v2.noteTimingMap],
    intraTies: [...v1.intraTies, ...v2.intraTies],
    crossTieOut: [...v1.crossTieOut, ...v2.crossTieOut],
    crossTieIn: [...v1.crossTieIn, ...v2.crossTieIn]
  };
}

export class ScoreStudioController {
  /**
   * @param {object} hostApp - Callbacks to VantaStudioApp.
   */
  constructor(hostApp) {
    this.host = hostApp;
    this.isOpen = false;
    this.synth = new ScoreSynth();
    this.currentTrack = null;
    this.rawTranscription = null;
    this.scoreModel = null;
    this.engineStatus = null;
    this.activeJobId = '';
    this.isBusy = false;

    this.mode = 'htdemucs'; // 'htdemucs' | 'direct'
    this.focusProfile = 'solo';
    this.selectedStems = ['other'];
    this.analysisParams = {
      harmonicFilterStrength: 0.65,
      minConfidence: 0.32,
      minDurationSec: 0.06,
      splitMode: 'smart',
      bpm: 0, // 0 = auto
      timeSignature: '', // '' = auto
      forcedKey: '', // '' = auto
      transposeSemitones: 0,
      showGhostsInRoll: true
    };

    this.auditionMode = 'original'; // 'original' | 'mix' | 'synth'
    this.practiceSpeed = 1.0;
    this.loopBarA = null;
    this.loopBarB = null;
    this.pageIndex = 0;
    this.autoFollowPage = true;
    this.lastClockSec = 0;
    this.windowStartSec = 0;
    this.analysisWindow = {
      startSec: 0,
      endSec: MAX_SCORE_WINDOW_SEC,
      requestStartSec: 0,
      requestDurationSec: 0,
      trackDurationSec: 0,
      isLongTrack: false,
      initializedForPath: ''
    };

    this.renderedMeasuresMeta = [];
    this.pianoRollNoteBoxes = [];
    this.playheadEl = null;

    this._bindDom();
    this._bindProgressListener();
  }

  _bindProgressListener() {
    if (!window.vantaAPI?.onTranscriptionProgress) return;
    window.vantaAPI.onTranscriptionProgress((prog) => {
      if (!prog) return;
      if (prog.jobId !== this.activeJobId && prog.jobId !== 'model-download') return;
      this._setProgressUi(prog.pct, prog.detail || prog.stage || 'Processing...');
    });
  }

  _bindDom() {
    this.modalEl = document.getElementById('scoreStudioModal');
    if (!this.modalEl) return;

    document.getElementById('btnCloseScoreStudio')?.addEventListener('click', () => this.close());
    document.getElementById('btnScoreMaximizeWin')?.addEventListener('click', () => {
      window.vantaAPI?.windowControl?.('maximize');
    });
    this.modalEl.addEventListener('click', (e) => {
      if (e.target === this.modalEl) this.close();
    });

    // Engine Mode Toggle (HTDemucs vs Fast Direct)
    document.querySelectorAll('#scoreModeGroup .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.mode = btn.dataset.scoreMode === 'direct' ? 'direct' : 'htdemucs';
        this._syncConfigControls();
        void this._loadCachedForCurrentTrack().catch(() => {});
      });
    });

    // Stem Checkboxes (HTDemucs mode)
    document.querySelectorAll('[data-score-stem]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const stem = btn.dataset.scoreStem;
        if (!stem) return;
        if (this.selectedStems.includes(stem)) {
          if (this.selectedStems.length > 1) {
            this.selectedStems = this.selectedStems.filter((s) => s !== stem);
          }
        } else {
          this.selectedStems = [...this.selectedStems, stem];
        }
        this._syncConfigControls();
        void this._loadCachedForCurrentTrack().catch(() => {});
      });
    });

    document.getElementById('scoreFocusSelect')?.addEventListener('change', (e) => {
      this.focusProfile = e.target.value || 'solo';
      void this._loadCachedForCurrentTrack().catch(() => {});
    });

    document.getElementById('scoreWinStartInput')?.addEventListener('change', () => {
      this._commitWindowInputs('start');
    });
    document.getElementById('scoreWinEndInput')?.addEventListener('change', () => {
      this._commitWindowInputs('end');
    });
    document.getElementById('btnScoreWinCursor')?.addEventListener('click', () => {
      this._applyWindowFromPlayhead();
    });

    document.getElementById('btnScoreAnalyze')?.addEventListener('click', () => {
      void this.runAnalysis(false).catch(() => {});
    });
    document.getElementById('btnScoreReanalyze')?.addEventListener('click', () => {
      void this.runAnalysis(true).catch(() => {});
    });
    document.getElementById('btnScoreCancel')?.addEventListener('click', () => {
      if (this.activeJobId && window.vantaAPI?.cancelTranscription) {
        void window.vantaAPI.cancelTranscription({ jobId: this.activeJobId }).catch(() => {});
      }
      this._setBusy(false, 'Cancelled');
    });
    document.getElementById('btnScoreDownloadModel')?.addEventListener('click', () => {
      void this.downloadHtdemucsModel().catch(() => {});
    });

    // Live Post-Processing Sliders (instant <5ms re-render)
    document.getElementById('scoreHarmonicSlider')?.addEventListener('input', (e) => {
      this.analysisParams.harmonicFilterStrength = Number(e.target.value) / 100;
      const valEl = document.getElementById('scoreHarmonicVal');
      if (valEl) valEl.textContent = `${e.target.value}%`;
      this._recomputeAndRender();
    });
    document.getElementById('scoreConfidenceSlider')?.addEventListener('input', (e) => {
      this.analysisParams.minConfidence = Number(e.target.value) / 100;
      const valEl = document.getElementById('scoreConfidenceVal');
      if (valEl) valEl.textContent = this.analysisParams.minConfidence.toFixed(2);
      this._recomputeAndRender();
    });

    document.getElementById('scoreBpmInput')?.addEventListener('change', (e) => {
      const v = Number(e.target.value);
      this.analysisParams.bpm = v >= 40 && v <= 220 ? Math.round(v) : 0;
      this._recomputeAndRender();
    });
    document.getElementById('btnScoreHalfBpm')?.addEventListener('click', () => {
      const cur = this.analysisParams.bpm || this.scoreModel?.tempo || 100;
      this.analysisParams.bpm = Math.max(40, Math.round(cur / 2));
      this._recomputeAndRender();
    });
    document.getElementById('btnScoreDoubleBpm')?.addEventListener('click', () => {
      const cur = this.analysisParams.bpm || this.scoreModel?.tempo || 100;
      this.analysisParams.bpm = Math.min(220, Math.round(cur * 2));
      this._recomputeAndRender();
    });
    document.getElementById('scoreMeterSelect')?.addEventListener('change', (e) => {
      this.analysisParams.timeSignature = e.target.value || '';
      this._recomputeAndRender();
    });
    document.getElementById('scoreKeySelect')?.addEventListener('change', (e) => {
      this.analysisParams.forcedKey = e.target.value || '';
      this._recomputeAndRender();
    });
    document.getElementById('scoreSplitSelect')?.addEventListener('change', (e) => {
      this.analysisParams.splitMode = e.target.value || 'smart';
      this._recomputeAndRender();
    });
    document.getElementById('scoreTransposeSelect')?.addEventListener('change', (e) => {
      this.analysisParams.transposeSemitones = Number(e.target.value) || 0;
      this._recomputeAndRender();
    });

    // Audition & Practice Controls
    document.querySelectorAll('#scoreAuditionGroup .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.setAuditionMode(btn.dataset.audition || 'original');
      });
    });
    document.querySelectorAll('#scoreSpeedGroup .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rate = Number(btn.dataset.speed) || 1.0;
        this.practiceSpeed = rate;
        document.querySelectorAll('#scoreSpeedGroup .seg-btn').forEach((b) => {
          b.classList.toggle('active', b === btn);
        });
        this.host.setPracticePlaybackRate?.(rate);
      });
    });

    document.getElementById('btnScorePlayToggle')?.addEventListener('click', () => {
      this.host.togglePlay?.();
    });
    document.getElementById('btnScoreClearLoop')?.addEventListener('click', () => {
      this.loopBarA = null;
      this.loopBarB = null;
      this._syncLoopBadge();
      this._renderPianoRoll();
    });

    // Sheet Pagination
    document.getElementById('btnScorePrevPage')?.addEventListener('click', () => {
      if (this.pageIndex > 0) {
        this.pageIndex--;
        this._renderSheetMusic();
      }
    });
    document.getElementById('btnScoreNextPage')?.addEventListener('click', () => {
      const totalPages = Math.max(1, Math.ceil((this.scoreModel?.totalMeasures || 1) / MEASURES_PER_PAGE));
      if (this.pageIndex < totalPages - 1) {
        this.pageIndex++;
        this._renderSheetMusic();
      }
    });
    document.getElementById('btnScoreAutoFollow')?.addEventListener('click', (e) => {
      this.autoFollowPage = !this.autoFollowPage;
      e.currentTarget.classList.toggle('active', this.autoFollowPage);
    });

    // Piano Roll Canvas interactions (note audition + bar seek)
    const rollCanvas = document.getElementById('scorePianoRollCanvas');
    rollCanvas?.addEventListener('click', (e) => this._handlePianoRollClick(e));

    // Exports
    document.getElementById('btnExportScorePdf')?.addEventListener('click', () => void this.exportCurrentScore('pdf'));
    document.getElementById('btnExportScoreMidi')?.addEventListener('click', () => void this.exportCurrentScore('midi'));
    document.getElementById('btnExportScoreXml')?.addEventListener('click', () => void this.exportCurrentScore('musicxml'));
    document.getElementById('btnExportScoreAudio')?.addEventListener('click', () => void this.exportCurrentScore('audio'));
    document.getElementById('btnExportScoreSvg')?.addEventListener('click', () => void this.exportCurrentScore('svg'));

    // Right Dock shortcut
    document.getElementById('btnDockOpenScoreStudio')?.addEventListener('click', () => {
      const track = this.host.getActiveTrack?.();
      void this.open(track).catch((err) => {
        window.vantaAPI?.logClientEvent?.('warn', 'Score Studio open failed', {
          error: err?.message || String(err)
        });
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) {
        this.close();
      }
    });

    let resizeTimer = null;
    const scheduleReflow = () => {
      if (!this.isOpen || !this.scoreModel) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (this.isOpen && this.scoreModel) {
          this._renderSheetMusic();
          this._renderPianoRoll();
        }
      }, 70);
    };
    window.addEventListener('resize', scheduleReflow);
    const sheetHost = document.getElementById('scoreSheetContainer');
    if (sheetHost && typeof ResizeObserver !== 'undefined') {
      this._sheetResizeObserver = new ResizeObserver(() => scheduleReflow());
      this._sheetResizeObserver.observe(sheetHost);
    }
  }

  /**
   * Opens Score Studio for a specific track (defaults to currently active track).
   * @param {object|null} track - Track object.
   */
  async open(track = null) {
    if (!this.modalEl) return;
    this.isOpen = true;
    this.modalEl.classList.remove('hidden');
    if (track) {
      this.currentTrack = track;
    } else if (!this.currentTrack) {
      this.currentTrack = this.host.getActiveTrack?.() || null;
    }

    const activePath = this.currentTrack?.filePath || '';
    if (activePath !== this.analysisWindow.initializedForPath) {
      this._resetWindowForTrack(this.currentTrack);
    }
    if (this.currentTrack?.filePath && !(Number(this.currentTrack.durationSec) > 0) && window.vantaAPI?.probeTrackTech) {
      try {
        const probe = await window.vantaAPI.probeTrackTech({
          filePath: this.currentTrack.filePath,
          audioHash: this.currentTrack.audioHash,
          isVideo: Boolean(this.currentTrack.isVideo)
        });
        if (probe?.durationSec > 0 && this.currentTrack?.filePath === activePath) {
          this.currentTrack.durationSec = probe.durationSec;
          this._resetWindowForTrack(this.currentTrack);
        }
      } catch {
        // Ignore lightweight duration probe failure
      }
    }

    await this._refreshEngineStatus();
    this._syncTrackHeader();
    this._syncConfigControls();
    this._syncWindowControls();
    await this._loadCachedForCurrentTrack();
    requestAnimationFrame(() => {
      if (this.isOpen && this.scoreModel) {
        this._renderSheetMusic();
        this._renderPianoRoll();
      }
    });
  }

  close() {
    if (!this.modalEl) return;
    this.isOpen = false;
    this.modalEl.classList.add('hidden');
    this.synth.stopAll();
    if (this.auditionMode === 'synth') {
      this.setAuditionMode('original');
    }
  }

  /**
   * Called by VantaStudioApp whenever the active track changes so the Right Dock live chord strip
   * auto-loads cached score chords immediately if available.
   * @param {object|null} track - Newly selected track.
   */
  async onTrackChanged(track) {
    this.currentTrack = track || null;
    this.loopBarA = null;
    this.loopBarB = null;
    this.pageIndex = 0;
    this.lastClockSec = 0;
    this.windowStartSec = 0;
    this.synth.stopAll();
    this._resetWindowForTrack(this.currentTrack);
    this._syncTrackHeader();
    this._syncLoopBadge();
    this._syncWindowControls();
    await this._loadCachedForCurrentTrack();
  }

  _resetWindowForTrack(track) {
    const dur = Math.max(0, Math.round(Number(track?.durationSec) || 0));
    const norm = normalizeAnalysisWindowBounds({
      startSec: 0,
      endSec: dur > 0 ? Math.min(dur, MAX_SCORE_WINDOW_SEC) : MAX_SCORE_WINDOW_SEC,
      trackDurationSec: dur,
      maxWindowSec: MAX_SCORE_WINDOW_SEC
    });
    this.analysisWindow = {
      ...norm,
      trackDurationSec: dur,
      initializedForPath: track?.filePath || ''
    };
  }

  _syncWindowControls() {
    const startEl = document.getElementById('scoreWinStartInput');
    const endEl = document.getElementById('scoreWinEndInput');
    const cursorBtn = document.getElementById('btnScoreWinCursor');
    const capBadge = document.getElementById('scoreWindowCapBadge');
    const dur = Math.max(0, Math.round(Number(this.currentTrack?.durationSec) || 0));
    const hasTrack = Boolean(this.currentTrack?.filePath);

    if (startEl) {
      startEl.value = formatTimeSec(this.analysisWindow.startSec);
      startEl.disabled = this.isBusy || !hasTrack;
    }
    if (endEl) {
      endEl.value = formatTimeSec(this.analysisWindow.endSec);
      endEl.disabled = this.isBusy || !hasTrack;
    }
    if (cursorBtn) {
      cursorBtn.disabled = this.isBusy || !hasTrack;
    }
    if (capBadge) {
      const isLong = dur > MAX_SCORE_WINDOW_SEC;
      capBadge.classList.toggle('hidden', !isLong);
      if (isLong) {
        capBadge.textContent = `Track ${formatTimeSec(dur)} · Max 8:00`;
      }
    }
  }

  _commitWindowInputs(changedEdge) {
    const startEl = document.getElementById('scoreWinStartInput');
    const endEl = document.getElementById('scoreWinEndInput');
    const parsedStart = parseTimeWindowInput(startEl?.value);
    const parsedEnd = parseTimeWindowInput(endEl?.value);

    if (parsedStart === null || parsedEnd === null) {
      this._syncWindowControls();
      this.host.onToast?.('Invalid time format. Use mm:ss, hh:mm:ss, or seconds.');
      return;
    }

    const dur = Math.max(0, Math.round(Number(this.currentTrack?.durationSec) || 0));
    const norm = normalizeAnalysisWindowBounds({
      startSec: parsedStart,
      endSec: parsedEnd,
      trackDurationSec: dur,
      maxWindowSec: MAX_SCORE_WINDOW_SEC,
      changedEdge
    });

    this.analysisWindow = {
      ...norm,
      trackDurationSec: dur,
      initializedForPath: this.currentTrack?.filePath || ''
    };
    this._syncWindowControls();
    if (norm.exceedsMaxCap) {
      this.host.onToast?.(
        `Analysis window capped at 8:00 max (${formatTimeSec(norm.startSec)}–${formatTimeSec(norm.endSec)})`
      );
    }
    void this._loadCachedForCurrentTrack().catch(() => {});
  }

  _applyWindowFromPlayhead() {
    if (!this.currentTrack?.filePath) return;
    const dur = Math.max(0, Math.round(Number(this.currentTrack?.durationSec) || 0));
    const curPos = Math.max(0, Math.floor(Number(this.host.getPositionSec?.() ?? this.lastClockSec) || 0));
    const prevSpan = Math.max(30, Math.min(MAX_SCORE_WINDOW_SEC, (this.analysisWindow.endSec - this.analysisWindow.startSec) || 240));
    const startSec = dur > 5 && curPos >= dur - 5 ? Math.max(0, dur - prevSpan) : curPos;
    const endSec = dur > 0 ? Math.min(dur, startSec + prevSpan) : startSec + prevSpan;

    const norm = normalizeAnalysisWindowBounds({
      startSec,
      endSec,
      trackDurationSec: dur,
      maxWindowSec: MAX_SCORE_WINDOW_SEC,
      changedEdge: 'start'
    });
    this.analysisWindow = {
      ...norm,
      trackDurationSec: dur,
      initializedForPath: this.currentTrack.filePath
    };
    this._syncWindowControls();
    this.host.onToast?.(
      `Analysis window anchored at playhead: ${formatTimeSec(norm.startSec)}–${formatTimeSec(norm.endSec)}`
    );
    void this._loadCachedForCurrentTrack().catch(() => {});
  }

  async _refreshEngineStatus() {
    if (!window.vantaAPI?.getScoreEngineStatus) return;
    try {
      this.engineStatus = await window.vantaAPI.getScoreEngineStatus();
    } catch {
      this.engineStatus = null;
    }
    const modelBtn = document.getElementById('btnScoreDownloadModel');
    const statusPill = document.getElementById('scoreEngineBadge');
    if (this.engineStatus) {
      const hasStems = Boolean(this.engineStatus.readyStems);
      if (modelBtn) modelBtn.classList.toggle('hidden', hasStems);
      if (statusPill) {
        statusPill.textContent = hasStems
          ? 'HTDemucs (MIT) + Basic Pitch Ready'
          : 'Basic Pitch Ready · Download HTDemucs for 4-Stem';
      }
      if (!hasStems && this.mode === 'htdemucs') {
        this.mode = 'direct';
      }
    }
  }

  _syncTrackHeader() {
    const titleEl = document.getElementById('scoreTrackTitle');
    const subEl = document.getElementById('scoreTrackMeta');
    const analyzeBtn = document.getElementById('btnScoreAnalyze');
    const reanalyzeBtn = document.getElementById('btnScoreReanalyze');
    const t = this.currentTrack;
    if (titleEl) titleEl.textContent = t ? (t.title || t.fileName || 'Untitled Track') : 'No Track Selected';
    if (subEl) {
      subEl.textContent = t
        ? `${t.artist || 'Unknown Artist'} · ${t.bpm || '--'} BPM · ${t.key || '--'}`
        : 'Select an audio track from your library to transcribe notes & chords';
    }
    const canAnalyze = Boolean(t?.filePath);
    if (analyzeBtn) analyzeBtn.disabled = !canAnalyze || this.isBusy;
    if (reanalyzeBtn) reanalyzeBtn.disabled = !canAnalyze || this.isBusy;
  }

  _syncConfigControls() {
    document.querySelectorAll('#scoreModeGroup .seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.scoreMode === this.mode);
    });
    const stemsWrap = document.getElementById('scoreStemsWrap');
    const focusWrap = document.getElementById('scoreFocusWrap');
    if (stemsWrap) stemsWrap.classList.toggle('hidden', this.mode !== 'htdemucs');
    if (focusWrap) focusWrap.classList.toggle('hidden', this.mode !== 'direct');

    document.querySelectorAll('[data-score-stem]').forEach((btn) => {
      btn.classList.toggle('active', this.selectedStems.includes(btn.dataset.scoreStem));
    });
  }

  async _loadCachedForCurrentTrack() {
    const t = this.currentTrack;
    if (!t?.filePath || !window.vantaAPI?.getCachedScore) {
      this.rawTranscription = null;
      this.scoreModel = null;
      this.windowStartSec = 0;
      this._renderEmptyState();
      this._updateDockChordStrip(0);
      return;
    }

    const reqStart = Number(this.analysisWindow?.requestStartSec) || 0;
    const reqDur = Number(this.analysisWindow?.requestDurationSec) || 0;

    // Try exact requested window + mode first, then compatible cached variants
    let cached = await window.vantaAPI.getCachedScore({
      filePath: t.filePath,
      mode: this.mode,
      focusProfile: this.focusProfile,
      stems: this.selectedStems,
      startSec: reqStart,
      durationSec: reqDur
    });
    if (!cached && reqStart === 0 && reqDur > 0) {
      cached = await window.vantaAPI.getCachedScore({
        filePath: t.filePath,
        mode: this.mode,
        focusProfile: this.focusProfile,
        stems: this.selectedStems,
        startSec: 0,
        durationSec: 0
      });
    }
    if (!cached && this.mode === 'htdemucs') {
      cached = await window.vantaAPI.getCachedScore({
        filePath: t.filePath,
        mode: 'direct',
        focusProfile: this.focusProfile,
        startSec: reqStart,
        durationSec: reqDur
      });
    }

    if (cached && Array.isArray(cached.notes)) {
      this.rawTranscription = cached;
      this.analysisParams.bpm = 0;
      this.analysisParams.timeSignature = '';
      this.analysisParams.forcedKey = '';
      this._recomputeAndRender();
    } else {
      this.rawTranscription = null;
      this.scoreModel = null;
      this.windowStartSec = 0;
      this._renderEmptyState();
      this._updateDockChordStrip(0);
    }
  }

  async downloadHtdemucsModel() {
    if (!window.vantaAPI?.ensureHtdemucsModel || this.isBusy) return;
    this._setBusy(true, 'Downloading MIT HTDemucs ONNX weights (165 MB)...');
    try {
      const res = await window.vantaAPI.ensureHtdemucsModel();
      if (res?.ok) {
        this.host.onToast?.('HTDemucs 4-Stem model verified (SHA-256) and ready');
        await this._refreshEngineStatus();
      } else {
        this.host.onToast?.(`Model download failed: ${res?.error || 'Unknown error'}`);
      }
    } finally {
      this._setBusy(false);
    }
  }

  async runAnalysis(force = false) {
    const track = this.currentTrack;
    if (!track?.filePath || !window.vantaAPI?.transcribeTrack || this.isBusy) return;

    this.activeJobId = `job_${Date.now()}`;
    const reqStart = Number(this.analysisWindow?.requestStartSec) || 0;
    const reqDur = Number(this.analysisWindow?.requestDurationSec) || 0;
    this._setBusy(
      true,
      this.mode === 'htdemucs'
        ? `Initializing HTDemucs 4-Stem (${formatTimeSec(this.analysisWindow.startSec)}–${formatTimeSec(this.analysisWindow.endSec)})...`
        : `Pre-conditioning audio (${formatTimeSec(this.analysisWindow.startSec)}–${formatTimeSec(this.analysisWindow.endSec)})...`
    );

    try {
      const res = await window.vantaAPI.transcribeTrack({
        jobId: this.activeJobId,
        filePath: track.filePath,
        mode: this.mode,
        focusProfile: this.focusProfile,
        stems: this.selectedStems,
        startSec: reqStart,
        durationSec: reqDur,
        force
      });

      if (!res?.ok || !res.result) {
        this.host.onToast?.(`Transcription failed: ${res?.error || 'Unknown error'}`);
        return;
      }

      this.rawTranscription = res.result;
      this.analysisParams.bpm = 0;
      this.analysisParams.timeSignature = '';
      this.analysisParams.forcedKey = '';
      this.pageIndex = 0;
      this._recomputeAndRender();
      this.host.onToast?.(
        `Extracted ${this.scoreModel?.stats?.activeCount || 0} notes (${this.scoreModel?.key?.label || '--'} · ${this.scoreModel?.tempo || '--'} BPM)`
      );
    } finally {
      this.activeJobId = '';
      this._setBusy(false);
    }
  }

  _setBusy(busy, statusText = '') {
    this.isBusy = busy;
    const analyzeBtn = document.getElementById('btnScoreAnalyze');
    const reanalyzeBtn = document.getElementById('btnScoreReanalyze');
    const cancelBtn = document.getElementById('btnScoreCancel');
    const progWrap = document.getElementById('scoreProgressWrap');
    if (analyzeBtn) analyzeBtn.disabled = busy || !this.currentTrack?.filePath;
    if (reanalyzeBtn) reanalyzeBtn.disabled = busy || !this.currentTrack?.filePath;
    if (cancelBtn) cancelBtn.classList.toggle('hidden', !busy);
    if (progWrap) progWrap.classList.toggle('hidden', !busy);
    this._syncWindowControls();
    if (statusText) this._setProgressUi(busy ? 5 : 0, statusText);
  }

  _setProgressUi(pct, detail) {
    const bar = document.getElementById('scoreProgressFill');
    const label = document.getElementById('scoreProgressLabel');
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`;
    if (label) label.textContent = String(detail || '');
  }

  _recomputeAndRender() {
    if (!this.rawTranscription?.notes) {
      this.windowStartSec = 0;
      this._renderEmptyState();
      return;
    }

    this.windowStartSec = Math.max(0, Number(this.rawTranscription?.windowStartSec) || 0);
    const trackBpm = Number(this.currentTrack?.bpm) || 0;
    this.scoreModel = buildScoreModel(this.rawTranscription.notes, {
      harmonicFilterStrength: this.analysisParams.harmonicFilterStrength,
      minConfidence: this.analysisParams.minConfidence,
      minDurationSec: this.analysisParams.minDurationSec,
      splitMode: this.analysisParams.splitMode,
      bpmHint: trackBpm > 0 ? trackBpm : undefined,
      bpm: this.analysisParams.bpm || undefined,
      timeSignature: this.analysisParams.timeSignature || undefined,
      forcedKey: this.analysisParams.forcedKey || undefined,
      transposeSemitones: this.analysisParams.transposeSemitones
    });

    const bpmInput = document.getElementById('scoreBpmInput');
    if (bpmInput) bpmInput.value = String(this.scoreModel.tempo);
    const meterSelect = document.getElementById('scoreMeterSelect');
    if (meterSelect && !this.analysisParams.timeSignature) {
      meterSelect.value = '';
    }

    const summaryEl = document.getElementById('scoreStatsSummary');
    if (summaryEl) {
      const st = this.scoreModel.stats;
      const elapsed = this.rawTranscription.elapsedMs ? `${(this.rawTranscription.elapsedMs / 1000).toFixed(2)}s` : 'cached';
      const hasExplicitWin = this.windowStartSec > 0 || (Number(this.rawTranscription?.requestedDurationSec) || 0) > 0;
      const winPrefix = hasExplicitWin
        ? `Range ${formatTimeSec(this.windowStartSec)}–${formatTimeSec(this.windowStartSec + this.scoreModel.totalDurationSec)} · `
        : '';
      summaryEl.textContent = `${winPrefix}${st.activeCount} active notes (${st.overtoneCount} overtones suppressed) · ${this.scoreModel.key.label} · ${this.scoreModel.tempo} BPM (${this.scoreModel.timeSignature}) · ${this.scoreModel.totalMeasures} bars · ${elapsed}`;
    }

    ['btnExportScorePdf', 'btnExportScoreMidi', 'btnExportScoreXml', 'btnExportScoreAudio', 'btnExportScoreSvg'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = false;
    });

    if (this.isOpen) {
      this._renderSheetMusic();
      this._renderPianoRoll();
    }
    this._updateDockChordStrip(this.lastClockSec);
  }

  _renderEmptyState() {
    const sheetHost = document.getElementById('scoreSheetContainer');
    if (sheetHost) {
      sheetHost.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'score-empty-state';
      const title = document.createElement('h4');
      title.textContent = 'Ready to Transcribe Audio to Grand Staff & Chords';
      const desc = document.createElement('p');
      desc.textContent =
        'Choose "HTDemucs 4-Stem" to isolate Piano/Keys, Vocals, or Bass from full-mix songs, or "Fast Direct" for solo instruments. Click Analyze Track to generate interactive sheet music.';
      empty.appendChild(title);
      empty.appendChild(desc);
      sheetHost.appendChild(empty);
    }
    const summaryEl = document.getElementById('scoreStatsSummary');
    if (summaryEl) summaryEl.textContent = 'No transcription loaded for this track';
    const rollCanvas = document.getElementById('scorePianoRollCanvas');
    if (rollCanvas) {
      const ctx = rollCanvas.getContext('2d');
      ctx?.clearRect(0, 0, rollCanvas.width, rollCanvas.height);
    }
    ['btnExportScorePdf', 'btnExportScoreMidi', 'btnExportScoreXml', 'btnExportScoreAudio', 'btnExportScoreSvg'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    });
  }

  _renderSheetMusic() {
    const host = document.getElementById('scoreSheetContainer');
    const pageLabel = document.getElementById('scorePageLabel');
    if (!host || !this.scoreModel || !window.VexFlow) return;

    const model = this.scoreModel;
    const totalPages = Math.max(1, Math.ceil(model.totalMeasures / MEASURES_PER_PAGE));
    this.pageIndex = Math.max(0, Math.min(totalPages - 1, this.pageIndex));

    const startIdx = this.pageIndex * MEASURES_PER_PAGE;
    const endIdx = Math.min(model.measures.length, startIdx + MEASURES_PER_PAGE);
    const pageMeasures = model.measures.slice(startIdx, endIdx);

    if (pageLabel) {
      pageLabel.textContent = `Bars ${startIdx + 1}–${endIdx} / ${model.totalMeasures} (Page ${this.pageIndex + 1}/${totalPages})`;
    }

    host.style.width = '';
    host.replaceChildren();
    const stageEl = document.createElement('div');
    stageEl.className = 'score-svg-stage';
    host.appendChild(stageEl);

    const rawWidth = host.clientWidth || host.parentElement?.clientWidth || 1240;
    const containerWidth = Math.max(760, rawWidth - 36);
    const isIce = document.body.classList.contains('theme-ice');

    this._renderSheetPage(stageEl, pageMeasures, this.pageIndex, {
      width: containerWidth,
      inkColor: isIce ? '#0f172a' : '#e2e8f0',
      chordFill: isIce ? '#1d4ed8' : '#38bdf8',
      numFill: isIce ? '#64748b' : '#94a3b8',
      interactive: true
    });

    this._updateSheetCursor(this.lastClockSec);
  }

  _renderSheetPage(stageEl, pageMeasures, pageIdx, renderOpts = {}) {
    const VF = window.VexFlow;
    const model = this.scoreModel;
    if (!VF || !model || !stageEl || !pageMeasures.length) return;

    const containerWidth = Math.max(760, Number(renderOpts.width) || 1040);
    const inkColor = renderOpts.inkColor || '#0f172a';
    const chordFill = renderOpts.chordFill || '#1d4ed8';
    const numFill = renderOpts.numFill || '#64748b';
    const interactive = renderOpts.interactive !== false;

    const barsPerSys = containerWidth >= 1040 ? 4 : BARS_PER_SYSTEM;
    const systemWidth = containerWidth - 40;
    const numSystems = Math.ceil(pageMeasures.length / barsPerSys);
    const showBass = this.analysisParams.splitMode !== 'treble-only';

    // Precompute dynamic per-system vertical layout so high ledger lines, bass octaves,
    // measure numbers, and chord symbols never collide across rows or measures.
    const systemLayouts = [];
    let yCursor = 6;
    for (let sys = 0; sys < numSystems; sys++) {
      const sysBars = pageMeasures.slice(sys * barsPerSys, (sys + 1) * barsPerSys);
      let maxTreblePitch = 74;
      let maxUpStemTreblePitch = 71;
      let minTreblePitch = 64;
      let maxBassPitch = 57;
      let minBassPitch = 45;

      for (const m of sysBars) {
        const byTick = new Map();
        for (const ev of m.trebleEvents || []) {
          if (ev.pitch > maxTreblePitch) maxTreblePitch = ev.pitch;
          if (ev.pitch < minTreblePitch) minTreblePitch = ev.pitch;
          const bucket = byTick.get(ev.startTickInMeasure) || [];
          bucket.push(ev.pitch);
          byTick.set(ev.startTickInMeasure, bucket);
        }
        for (const pitches of byTick.values()) {
          const mean = pitches.reduce((a, b) => a + b, 0) / pitches.length;
          const hi = Math.max(...pitches);
          // Chords whose midpoint sits around/below middle treble line (B4/C#5) can stem upward
          if (mean <= 73 && hi > maxUpStemTreblePitch) {
            maxUpStemTreblePitch = hi;
          }
        }
        for (const ev of m.bassEvents || []) {
          if (ev.pitch > maxBassPitch) maxBassPitch = ev.pitch;
          if (ev.pitch < minBassPitch) minBassPitch = ev.pitch;
        }
      }

      const ledgerHeadroom =
        maxTreblePitch > 76 ? Math.ceil((maxTreblePitch - 76) * 3.1) + 16 : 20;
      const upStemHeadroom =
        maxUpStemTreblePitch > 71 ? Math.ceil((maxUpStemTreblePitch - 72) * 3.1) + 40 : 28;
      const trebleNoteHeadroom = Math.max(24, ledgerHeadroom, upStemHeadroom);
      const headerHeight = 44; // 14px top cap + 18px barNum-to-chord gap + 12px clearance
      const line0Y = yCursor + headerHeight + trebleNoteHeadroom;
      const yTreble = line0Y - 40; // VexFlow line 0 sits 40px below stave y

      const centerExtra =
        Math.max(0, 60 - minTreblePitch) * 2.1 + Math.max(0, maxBassPitch - 60) * 2.1;
      const trebleBassGap = 100 + Math.min(34, Math.round(centerExtra));
      const yBass = yTreble + trebleBassGap;
      const bassLine4Y = yBass + 80;
      const bassBottomOverhang =
        minBassPitch < 43 ? Math.max(22, Math.ceil((43 - minBassPitch) * 3.1) + 16) : 22;
      const estBottomY = (showBass ? bassLine4Y : line0Y + 40) + bassBottomOverhang;

      systemLayouts.push({
        sysBars,
        yCursor,
        yTreble,
        line0Y,
        yBass,
        bassLine4Y,
        estBottomY
      });
      yCursor = estBottomY + 12;
    }

    const totalHeight = Math.max(260, yCursor + 14);
    const renderer = new VF.Renderer(stageEl, VF.Renderer.Backends.SVG);
    renderer.resize(containerWidth, totalHeight);
    const ctx = renderer.getContext();
    ctx.setFillStyle(inkColor);
    ctx.setStrokeStyle(inkColor);

    const renderedMeta = interactive ? [] : null;
    if (interactive) this.renderedMeasuresMeta = renderedMeta;
    const headerLabels = [];
    const tieQueue = [];
    const barVoiceMap = new Map();

    for (let sys = 0; sys < systemLayouts.length; sys++) {
      const lay = systemLayouts[sys];
      const { sysBars, yTreble, line0Y, yBass, bassLine4Y } = lay;
      const barWidth = Math.floor(systemWidth / Math.max(1, sysBars.length));
      const sysLabels = [];
      let sysMinNoteTopY = line0Y - 14;
      let lastChordRightX = -Infinity;

      for (let b = 0; b < sysBars.length; b++) {
        const m = sysBars[b];
        const mMeta = { ...m, num: model.num, den: model.den };
        const x = 20 + b * barWidth;

        const trebleStave = new VF.Stave(x, yTreble, barWidth);
        if (b === 0) {
          trebleStave.addClef('treble').addKeySignature(model.key.vexKey);
          if (sys === 0 && pageIdx === 0) {
            trebleStave.addTimeSignature(model.timeSignature);
          }
        }
        trebleStave.setContext(ctx).draw();

        let bassStave = null;
        if (showBass) {
          bassStave = new VF.Stave(x, yBass, barWidth);
          if (b === 0) {
            bassStave.addClef('bass').addKeySignature(model.key.vexKey);
            if (sys === 0 && pageIdx === 0) {
              bassStave.addTimeSignature(model.timeSignature);
            }
          }
          bassStave.setContext(ctx).draw();

          if (b === 0) {
            new VF.StaveConnector(trebleStave, bassStave)
              .setType(VF.StaveConnector.type.BRACE)
              .setContext(ctx)
              .draw();
            new VF.StaveConnector(trebleStave, bassStave)
              .setType(VF.StaveConnector.type.SINGLE_LEFT)
              .setContext(ctx)
              .draw();
          }
          if (b === sysBars.length - 1) {
            new VF.StaveConnector(trebleStave, bassStave)
              .setType(VF.StaveConnector.type.SINGLE_RIGHT)
              .setContext(ctx)
              .draw();
          }
        }

        const contentStartX = Math.max(
          trebleStave.getNoteStartX(),
          bassStave ? bassStave.getNoteStartX() : 0
        );
        if (bassStave) {
          trebleStave.setNoteStartX(contentStartX);
          bassStave.setNoteStartX(contentStartX);
        }
        const contentEndX = x + barWidth - 10;

        try {
          const trebleData = buildVexVoiceData(VF, m.trebleEvents, mMeta, 'treble');
          const allVoices = [...trebleData.voices];
          let bassData = null;

          if (showBass && bassStave) {
            bassData = buildVexVoiceData(VF, m.bassEvents, mMeta, 'bass');
            allVoices.push(...bassData.voices);
          }

          VF.Accidental.applyAccidentals(trebleData.voices, model.key.vexKey);
          if (bassData) {
            VF.Accidental.applyAccidentals(bassData.voices, model.key.vexKey);
          }

          const availW = Math.max(60, contentEndX - contentStartX - 6);
          const formatter = new VF.Formatter().joinVoices(trebleData.voices);
          if (bassData) formatter.joinVoices(bassData.voices);
          formatter.format(allVoices, availW, { alignRests: false });

          // Keep multi-voice rest displacement strictly inside the 5 stave lines [1.2 .. 4.8]
          for (const sn of [...trebleData.staveNotes, ...(bassData ? bassData.staveNotes : [])]) {
            if (!sn.isRest?.()) continue;
            const kp = sn.getKeyProps?.()?.[0];
            if (kp && Number.isFinite(kp.line) && (kp.line < 1.2 || kp.line > 4.8)) {
              sn.setKeyLine(0, Math.max(1.2, Math.min(4.8, kp.line)));
              sn.setXShift?.((sn.getXShift?.() || 0) + 9);
            }
          }

          const tBeams = trebleData.voiceNoteLists.flatMap((vNotes, vIdx) =>
            VF.Beam.generateBeams(
              vNotes,
              trebleData.voiceNoteLists.length > 1
                ? { stemDirection: vIdx === 0 ? 1 : -1, maintainStemDirections: true }
                : undefined
            )
          );
          trebleData.voices.forEach((v) => v.draw(ctx, trebleStave));
          tBeams.forEach((bm) => bm.setContext(ctx).draw());
          tieQueue.push(...trebleData.intraTies);
          barVoiceMap.set(`t_${m.measureNumber}`, { sys, data: trebleData });

          for (const sn of trebleData.staveNotes) {
            const bb = sn.getBoundingBox?.();
            if (bb && Number.isFinite(bb.y)) {
              sysMinNoteTopY = Math.min(sysMinNoteTopY, bb.y);
            }
          }
          for (const bm of tBeams) {
            const bb = bm.getBoundingBox?.();
            if (bb && Number.isFinite(bb.y)) {
              sysMinNoteTopY = Math.min(sysMinNoteTopY, bb.y);
            }
          }

          if (showBass && bassStave && bassData) {
            const bBeams = bassData.voiceNoteLists.flatMap((vNotes, vIdx) =>
              VF.Beam.generateBeams(
                vNotes,
                bassData.voiceNoteLists.length > 1
                  ? { stemDirection: vIdx === 0 ? 1 : -1, maintainStemDirections: true }
                  : undefined
              )
            );
            bassData.voices.forEach((v) => v.draw(ctx, bassStave));
            bBeams.forEach((bm) => bm.setContext(ctx).draw());
            tieQueue.push(...bassData.intraTies);
            barVoiceMap.set(`b_${m.measureNumber}`, { sys, data: bassData });
          }

          if (renderedMeta) {
            renderedMeta.push({
              measureNumber: m.measureNumber,
              startSec: m.startSec,
              endSec: m.endSec,
              x,
              contentStartX,
              contentEndX,
              y: line0Y,
              width: barWidth,
              height: (showBass ? bassLine4Y : line0Y + 40) - line0Y,
              trebleNotes: trebleData.noteTimingMap,
              bassNotes: bassData ? bassData.noteTimingMap : []
            });
          }
        } catch (err) {
          window.vantaAPI?.logClientEvent?.('warn', 'Score measure engraving fallback', {
            bar: m.measureNumber,
            sig: model.timeSignature,
            error: err?.message || String(err)
          });
          if (renderedMeta) {
            renderedMeta.push({
              measureNumber: m.measureNumber,
              startSec: m.startSec,
              endSec: m.endSec,
              x,
              contentStartX,
              contentEndX,
              y: line0Y,
              width: barWidth,
              height: (showBass ? bassLine4Y : line0Y + 40) - line0Y,
              trebleNotes: [],
              bassNotes: []
            });
          }
        }

        // Queue measure number & chord labels (final Y assigned per system after measuring actual high notes)
        sysLabels.push({
          kind: 'measure',
          text: String(m.measureNumber),
          x: x + 3
        });

        if (Array.isArray(m.chords) && m.chords.length) {
          let prevBarSym = '';
          const barDur = Math.max(0.05, m.endSec - m.startSec);
          const chordSpan = Math.max(40, contentEndX - contentStartX - 18);
          m.chords.forEach((c) => {
            if (!c.symbol || c.symbol === 'N.C.' || c.symbol === prevBarSym) return;
            const frac = Math.max(0, Math.min(0.88, (c.startSec - m.startSec) / barDur));
            const rawCx = frac < 0.08 ? contentStartX : contentStartX + frac * chordSpan;
            const estW = c.symbol.length * 7.8 + 4;
            const cx = Math.max(Math.round(rawCx), Math.round(lastChordRightX + 10));
            if (cx + estW <= 20 + systemWidth + 4) {
              sysLabels.push({
                kind: 'chord',
                text: c.symbol,
                x: cx
              });
              lastChordRightX = cx + estW;
              prevBarSym = c.symbol;
            }
          });
        }
      }

      // Separate measure numbers (top strip) cleanly from chords (18px below, still above highest note/beam)
      const safeChordY = Math.max(lay.yCursor + 30, Math.min(line0Y - 18, Math.round(sysMinNoteTopY - 11)));
      const safeMeasureY = safeChordY - 18;
      for (const lbl of sysLabels) {
        headerLabels.push({
          ...lbl,
          y: lbl.kind === 'measure' ? safeMeasureY : safeChordY
        });
      }
    }

    // Draw intra-bar and cross-barline StaveTies
    for (const m of pageMeasures) {
      for (const prefix of ['t', 'b']) {
        const curEntry = barVoiceMap.get(`${prefix}_${m.measureNumber}`);
        if (!curEntry) continue;
        const nextEntry = barVoiceMap.get(`${prefix}_${m.measureNumber + 1}`);
        for (const outTie of curEntry.data.crossTieOut) {
          const matchIn = nextEntry?.data?.crossTieIn?.find(
            (inTie) => inTie.sourceNoteId === outTie.sourceNoteId && inTie.pitch === outTie.pitch
          );
          if (matchIn && nextEntry.sys === curEntry.sys) {
            tieQueue.push({
              firstNote: outTie.staveNote,
              lastNote: matchIn.staveNote,
              firstIndexes: [outTie.keyIndex],
              lastIndexes: [matchIn.keyIndex]
            });
          } else {
            tieQueue.push({
              firstNote: outTie.staveNote,
              firstIndexes: [outTie.keyIndex],
              lastIndexes: [outTie.keyIndex]
            });
          }
        }
        const prevEntry = barVoiceMap.get(`${prefix}_${m.measureNumber - 1}`);
        if (!prevEntry || prevEntry.sys !== curEntry.sys) {
          for (const inTie of curEntry.data.crossTieIn) {
            tieQueue.push({
              lastNote: inTie.staveNote,
              firstIndexes: [inTie.keyIndex],
              lastIndexes: [inTie.keyIndex]
            });
          }
        }
      }
    }
    for (const tSpec of tieQueue) {
      try {
        new VF.StaveTie(tSpec).setContext(ctx).draw();
      } catch {
        // Ignore non-renderable open tie pairs across empty gaps
      }
    }

    // Add SVG viewBox, aligned bar numbers & chord symbols, and interactive hit zones
    const svg = stageEl.querySelector('svg');
    if (svg) {
      svg.setAttribute('viewBox', `0 0 ${containerWidth} ${totalHeight}`);
      const ns = 'http://www.w3.org/2000/svg';
      for (const lbl of headerLabels) {
        const tEl = document.createElementNS(ns, 'text');
        tEl.setAttribute('x', String(lbl.x));
        tEl.setAttribute('y', String(lbl.y));
        if (lbl.kind === 'chord') {
          tEl.setAttribute('class', 'score-chord-label');
          tEl.setAttribute('fill', chordFill);
          tEl.setAttribute('font-family', 'Inter, Segoe UI, sans-serif');
          tEl.setAttribute('font-size', '12.5');
          tEl.setAttribute('font-weight', '700');
        } else {
          tEl.setAttribute('class', 'score-measure-num');
          tEl.setAttribute('fill', numFill);
          tEl.setAttribute('font-family', 'JetBrains Mono, Consolas, monospace');
          tEl.setAttribute('font-size', '10');
          tEl.setAttribute('font-weight', '600');
        }
        tEl.textContent = lbl.text;
        svg.appendChild(tEl);
      }

      if (interactive && renderedMeta) {
        for (const mBox of renderedMeta) {
          const hitRect = document.createElementNS(ns, 'rect');
          hitRect.setAttribute('x', String(mBox.x));
          hitRect.setAttribute('y', String(mBox.y));
          hitRect.setAttribute('width', String(mBox.width));
          hitRect.setAttribute('height', String(mBox.height));
          hitRect.setAttribute('class', 'score-bar-hit');
          hitRect.addEventListener('click', (ev) => {
            if (ev.shiftKey) {
              this._toggleLoopBar(mBox.measureNumber);
            } else {
              this.host.seekToSeconds?.((this.windowStartSec || 0) + mBox.startSec, true);
            }
          });
          svg.appendChild(hitRect);
        }

        const ph = document.createElementNS(ns, 'line');
        ph.setAttribute('class', 'score-svg-playhead hidden');
        ph.setAttribute('x1', '0');
        ph.setAttribute('x2', '0');
        ph.setAttribute('y1', '0');
        ph.setAttribute('y2', '0');
        svg.appendChild(ph);
        this.playheadEl = ph;
      }
    }
  }

  _toggleLoopBar(barNum) {
    if (this.loopBarA === null || (this.loopBarA !== null && this.loopBarB !== null)) {
      this.loopBarA = barNum;
      this.loopBarB = null;
    } else {
      this.loopBarB = Math.max(this.loopBarA, barNum);
      this.loopBarA = Math.min(this.loopBarA, barNum);
    }
    this._syncLoopBadge();
    this._renderPianoRoll();
  }

  _syncLoopBadge() {
    const lbl = document.getElementById('scoreLoopLabel');
    const clr = document.getElementById('btnScoreClearLoop');
    if (lbl) {
      if (this.loopBarA !== null && this.loopBarB !== null) {
        lbl.textContent = `Loop: Bars ${this.loopBarA}–${this.loopBarB}`;
      } else if (this.loopBarA !== null) {
        lbl.textContent = `Loop Start: Bar ${this.loopBarA} (Shift+Click end bar)`;
      } else {
        lbl.textContent = 'Shift+Click bar to loop A–B';
      }
    }
    if (clr) clr.disabled = this.loopBarA === null;
  }

  _renderPianoRoll() {
    const canvas = document.getElementById('scorePianoRollCanvas');
    if (!canvas || !this.scoreModel) return;

    const wrap = canvas.parentElement;
    const width = Math.max(640, wrap?.clientWidth || 1100);
    const height = Math.max(120, wrap?.clientHeight || 170);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const model = this.scoreModel;
    const totalSec = Math.max(2, model.totalDurationSec);
    const minPitch = 28;
    const maxPitch = 96;
    const pitchSpan = maxPitch - minPitch + 1;
    const headerH = 22;
    const plotH = height - headerH;
    const rowH = plotH / pitchSpan;
    const isIce = document.body.classList.contains('theme-ice');

    // Background & octave guides
    ctx.fillStyle = isIce ? 'rgba(226, 232, 240, 0.55)' : 'rgba(10, 12, 18, 0.72)';
    ctx.fillRect(0, 0, width, height);

    for (let p = minPitch; p <= maxPitch; p++) {
      if (p % 12 === 0) {
        const y = headerH + (maxPitch - p) * rowH;
        ctx.fillStyle = isIce ? 'rgba(100, 116, 139, 0.20)' : 'rgba(255, 255, 255, 0.08)';
        ctx.fillRect(0, y, width, 1);
        ctx.fillStyle = isIce ? '#475569' : '#94a3b8';
        ctx.font = '10px "JetBrains Mono Variable", monospace';
        ctx.fillText(midiToNoteName(p), 4, Math.max(headerH + 9, y - 1));
      }
    }

    // Measure ruler + A-B loop highlight
    for (const m of model.measures) {
      const x0 = (m.startSec / totalSec) * width;
      const x1 = (m.endSec / totalSec) * width;
      if (
        this.loopBarA !== null &&
        m.measureNumber >= this.loopBarA &&
        m.measureNumber <= (this.loopBarB ?? this.loopBarA)
      ) {
        ctx.fillStyle = 'rgba(0, 229, 255, 0.14)';
        ctx.fillRect(x0, headerH, x1 - x0, plotH);
      }
      ctx.fillStyle = isIce ? 'rgba(15, 23, 42, 0.14)' : 'rgba(255, 255, 255, 0.09)';
      ctx.fillRect(x0, 0, 1, height);

      if (x1 - x0 > 20) {
        ctx.font = '10px "JetBrains Mono Variable", monospace';
        const numText = String(m.measureNumber);
        const numW = ctx.measureText(numText).width;
        if (x1 - x0 >= numW + 6) {
          ctx.fillStyle = isIce ? '#475569' : '#cbd5e1';
          ctx.fillText(numText, x0 + 3, 13);
          const ch = m.chords?.[0]?.symbol;
          if (ch && ch !== 'N.C.') {
            const chW = ctx.measureText(ch).width;
            if (x1 - x0 >= numW + chW + 14) {
              ctx.fillStyle = isIce ? '#1d4ed8' : '#22d3ee';
              ctx.fillText(ch, x0 + 3 + numW + 5, 13);
            }
          }
        }
      }
    }

    // Notes
    const winOffset = this.windowStartSec || 0;
    const localClockSec = this.lastClockSec - winOffset;
    const handMap = new Map(model.notes.map((n) => [n.id, n.hand]));
    this.pianoRollNoteBoxes = [];
    for (const n of model.annotatedRawNotes) {
      if (n.pitch < minPitch || n.pitch > maxPitch) continue;
      if (!n.visible && !this.analysisParams.showGhostsInRoll) continue;

      const x = (n.startSec / totalSec) * width;
      const w = Math.max(3, ((n.endSec - n.startSec) / totalSec) * width);
      const y = headerH + (maxPitch - n.pitch) * rowH;
      const h = Math.max(3, rowH + 1);
      const isSounding = localClockSec >= n.startSec && localClockSec <= n.endSec;

      if (!n.visible) {
        ctx.fillStyle = isIce ? 'rgba(148, 163, 184, 0.25)' : 'rgba(148, 163, 184, 0.18)';
      } else if (isSounding) {
        ctx.fillStyle = '#4ade80';
      } else {
        const hand = handMap.get(n.id) || (n.pitch >= 60 ? 'treble' : 'bass');
        ctx.fillStyle = hand === 'bass' ? '#a78bfa' : '#00e5ff';
      }
      ctx.fillRect(x, y, w, h);

      if (n.visible) {
        this.pianoRollNoteBoxes.push({ x, y, w, h, note: n });
      }
    }

    // Playhead
    if (localClockSec >= -0.05 && localClockSec <= totalSec + 0.05) {
      const px = Math.max(0, Math.min(width, (localClockSec / totalSec) * width));
      ctx.fillStyle = '#f43f5e';
      ctx.fillRect(px, 0, 2, height);
    }
  }

  _handlePianoRollClick(e) {
    if (!this.scoreModel) return;
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const winOffset = this.windowStartSec || 0;

    // Top ruler click seeks
    if (cy <= 24) {
      const targetSec = (cx / Math.max(1, rect.width)) * this.scoreModel.totalDurationSec;
      if (e.shiftKey) {
        const bar = this.scoreModel.measures.find((m) => targetSec >= m.startSec && targetSec <= m.endSec);
        if (bar) this._toggleLoopBar(bar.measureNumber);
      } else {
        this.host.seekToSeconds?.(winOffset + targetSec, true);
      }
      return;
    }

    // Note click auditions sound
    const hit = this.pianoRollNoteBoxes.find(
      (b) => cx >= b.x - 2 && cx <= b.x + b.w + 2 && cy >= b.y - 3 && cy <= b.y + b.h + 3
    );
    if (hit) {
      this.synth.triggerNote(hit.note.pitch, Math.min(1.2, hit.note.durationSec), hit.note.velocity);
      const infoEl = document.getElementById('scoreInspectorTip');
      if (infoEl) {
        infoEl.textContent = `${midiToNoteName(hit.note.pitch, this.scoreModel.key.preferFlats)} · ${formatTimeSec(winOffset + hit.note.startSec)} · Amp ${(hit.note.amplitude * 100).toFixed(0)}%`;
      }
    } else {
      const targetSec = (cx / Math.max(1, rect.width)) * this.scoreModel.totalDurationSec;
      this.host.seekToSeconds?.(winOffset + targetSec, true);
    }
  }

  /**
   * Switches between Original Audio, Mix + MIDI Synth, and Solo MIDI Synth audition.
   * @param {'original'|'mix'|'synth'} mode - Audition mode.
   */
  setAuditionMode(mode) {
    const next = ['original', 'mix', 'synth'].includes(mode) ? mode : 'original';
    this.auditionMode = next;
    document.querySelectorAll('#scoreAuditionGroup .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.audition === next);
    });
    this.host.setScoreMuteOriginal?.(next === 'synth');
  }

  /**
   * Called every playback tick (`updateTimelineUi`) across both Studio DSP and WASAPI Exclusive.
   * Updates Right Dock chord strip, sheet cursor, piano roll playhead, A-B loop, and synth clock.
   * @param {number} positionSec - Current track position in seconds.
   */
  syncPlayhead(positionSec) {
    const prevTrackSec = this.lastClockSec;
    const curTrackSec = Math.max(0, Number(positionSec) || 0);
    this.lastClockSec = curTrackSec;

    this._updateDockChordStrip(curTrackSec);
    if (!this.scoreModel) return;

    const winOffset = this.windowStartSec || 0;
    const prevLocalSec = prevTrackSec - winOffset;
    const curLocalSec = curTrackSec - winOffset;
    const inWindow = curLocalSec >= -0.05 && curLocalSec <= this.scoreModel.totalDurationSec + 0.5;

    // A-B Loop Practice enforcement (anchored inside current analysis window)
    if (this.loopBarA !== null && this.loopBarB !== null) {
      const mA = this.scoreModel.measures[this.loopBarA - 1];
      const mB = this.scoreModel.measures[this.loopBarB - 1];
      if (mA && mB && curLocalSec >= mA.startSec && curLocalSec >= mB.endSec - 0.03) {
        this.host.seekToSeconds?.(winOffset + mA.startSec, true);
        return;
      }
    }

    if (this.isOpen) {
      if ((this.auditionMode === 'mix' || this.auditionMode === 'synth') && curLocalSec >= 0 && prevLocalSec >= -0.25 && Math.abs(curLocalSec - prevLocalSec) < 1.0) {
        this.synth.syncClockStep(Math.max(0, prevLocalSec), Math.max(0, curLocalSec), this.scoreModel.notes);
      }

      if (inWindow && this.autoFollowPage) {
        const activeM = this.scoreModel.measures.find((m) => curLocalSec >= m.startSec && curLocalSec < m.endSec);
        if (activeM) {
          const targetPage = Math.floor((activeM.measureNumber - 1) / MEASURES_PER_PAGE);
          if (targetPage !== this.pageIndex) {
            this.pageIndex = targetPage;
            this._renderSheetMusic();
          }
        }
      }

      this._updateSheetCursor(inWindow ? curLocalSec : -1);
      this._renderPianoRoll();
    }
  }

  _updateSheetCursor(curSec) {
    if (!this.playheadEl || !this.renderedMeasuresMeta.length) return;
    const activeBox = this.renderedMeasuresMeta.find((m) => curSec >= m.startSec && curSec < m.endSec);
    if (!activeBox) {
      this.playheadEl.classList.add('hidden');
      return;
    }

    const span = Math.max(0.05, activeBox.endSec - activeBox.startSec);
    const ratio = Math.max(0, Math.min(1, (curSec - activeBox.startSec) / span));
    const startX = Number.isFinite(activeBox.contentStartX) ? activeBox.contentStartX : activeBox.x + 18;
    const endX = Number.isFinite(activeBox.contentEndX) ? activeBox.contentEndX : activeBox.x + activeBox.width - 6;
    const px = startX + ratio * Math.max(20, endX - startX);
    this.playheadEl.setAttribute('x1', px.toFixed(1));
    this.playheadEl.setAttribute('x2', px.toFixed(1));
    this.playheadEl.setAttribute('y1', String(activeBox.y));
    this.playheadEl.setAttribute('y2', String(activeBox.y + activeBox.height));
    this.playheadEl.classList.remove('hidden');

    // Highlight sounding VexFlow notes
    for (const m of this.renderedMeasuresMeta) {
      const allMappings = [...m.trebleNotes, ...m.bassNotes];
      for (const item of allMappings) {
        const svgEl = item.staveNote?.getSVGElement?.();
        if (!svgEl) continue;
        const active = item.events.some((ev) => curSec >= ev.startSec && curSec <= ev.endSec);
        svgEl.classList.toggle('score-vf-note-active', active);
      }
    }
  }

  _updateDockChordStrip(curTrackSec) {
    const curEl = document.getElementById('dockChordCurrent');
    const nextEl = document.getElementById('dockChordNext');
    const keyEl = document.getElementById('dockChordKey');
    if (!curEl || !nextEl || !keyEl) return;

    if (!this.scoreModel?.chords?.length) {
      curEl.textContent = '--';
      nextEl.textContent = 'Score Ready';
      keyEl.textContent = this.currentTrack?.key || 'Key --';
      return;
    }

    const winOffset = this.windowStartSec || 0;
    const curSec = curTrackSec - winOffset;
    if (curSec < -0.1 || curSec > this.scoreModel.totalDurationSec + 0.5) {
      curEl.textContent = '--';
      nextEl.textContent = `Range ${formatTimeSec(winOffset)}–${formatTimeSec(winOffset + this.scoreModel.totalDurationSec)}`;
      keyEl.textContent = `${this.scoreModel.key.label} · ${this.scoreModel.tempo} BPM`;
      return;
    }

    const chords = this.scoreModel.chords;
    let idx = chords.findIndex((c) => curSec >= c.startSec && curSec < c.endSec);
    if (idx < 0) idx = 0;

    const currentSym = chords[idx]?.symbol || '--';
    let nextSym = '--';
    for (let j = idx + 1; j < chords.length; j++) {
      if (chords[j].symbol && chords[j].symbol !== 'N.C.' && chords[j].symbol !== currentSym) {
        nextSym = chords[j].symbol;
        break;
      }
    }

    curEl.textContent = currentSym;
    nextEl.textContent = `Next: ${nextSym}`;
    keyEl.textContent = `${this.scoreModel.key.label} · ${this.scoreModel.tempo} BPM`;
  }

  async exportCurrentScore(format) {
    if (!this.scoreModel || !window.vantaAPI?.exportScore) return;
    const title = this.currentTrack?.title || this.currentTrack?.fileName || 'VANTA_Score';
    const artist = this.currentTrack?.artist || 'VANTA Score Studio';

    let res;
    if (format === 'midi') {
      const bytes = buildMidiBytes(this.scoreModel, { title });
      res = await window.vantaAPI.exportScore({
        format: 'midi',
        title,
        bytes
      });
    } else if (format === 'musicxml') {
      const xml = buildMusicXml(this.scoreModel, { title, artist });
      res = await window.vantaAPI.exportScore({
        format: 'musicxml',
        title,
        text: xml
      });
    } else if (format === 'svg') {
      const svg = document.querySelector('#scoreSheetContainer svg');
      if (!svg) return;
      const serializer = new XMLSerializer();
      res = await window.vantaAPI.exportScore({
        format: 'svg',
        title,
        text: serializer.serializeToString(svg)
      });
    } else if (format === 'pdf') {
      this.host.onToast?.('Rendering multi-page print PDF...');
      const totalPages = Math.max(1, Math.ceil(this.scoreModel.totalMeasures / MEASURES_PER_PAGE));
      const offscreenStage = document.createElement('div');
      offscreenStage.className = 'hidden';
      document.body.appendChild(offscreenStage);
      const svgPages = [];
      const serializer = new XMLSerializer();
      try {
        for (let p = 0; p < totalPages; p++) {
          offscreenStage.replaceChildren();
          const slice = this.scoreModel.measures.slice(p * MEASURES_PER_PAGE, (p + 1) * MEASURES_PER_PAGE);
          this._renderSheetPage(offscreenStage, slice, p, {
            width: 1040,
            inkColor: '#0f172a',
            chordFill: '#1d4ed8',
            numFill: '#475569',
            interactive: false
          });
          const pageSvg = offscreenStage.querySelector('svg');
          if (pageSvg) svgPages.push(serializer.serializeToString(pageSvg));
        }
      } finally {
        offscreenStage.remove();
      }
      if (!svgPages.length) return;
      const metaLine = `${this.scoreModel.key.label} · ${this.scoreModel.tempo} BPM (${this.scoreModel.timeSignature}) · ${this.scoreModel.totalMeasures} bars`;
      res = await window.vantaAPI.exportScore({
        format: 'pdf',
        title,
        artist,
        metaLine,
        svgPages
      });
    } else if (format === 'audio') {
      this.host.onToast?.('Synthesizing score audio...');
      const wavBytes = await renderScoreAudioWav(this.scoreModel, {
        playbackRate: this.practiceSpeed
      });
      res = await window.vantaAPI.exportScore({
        format: 'audio',
        title,
        bytes: wavBytes
      });
    }

    if (res?.ok) {
      this.host.onToast?.(`Exported score to ${res.filePath}`);
    } else if (res && !res.canceled) {
      this.host.onToast?.(`Export failed: ${res.error || 'Unknown error'}`);
    }
  }
}
