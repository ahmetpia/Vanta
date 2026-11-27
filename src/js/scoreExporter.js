/**
 * @fileoverview VANTA Score Exporters (Phase 9.2).
 * Pure, zero-dependency generators for:
 * - Standard Type-1 Binary MIDI (.mid) with Conductor + Treble (RH) + Bass (LH) tracks
 * - MusicXML 4.0 Partwise (.musicxml) with Grand Staff, Key/Time Signatures, Harmonies, and Ties
 */

import { PPQ, PITCH_CLASS_FLAT, PITCH_CLASS_SHARP } from './scoreAnalyzer.js';

function encodeVlq(value) {
  let v = Math.max(0, Math.floor(value));
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

function buildMidiTrackChunk(events) {
  // Sort by tick, NoteOff before NoteOn on identical ticks
  const sorted = [...events].sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body = [];
  let prevTick = 0;

  for (const ev of sorted) {
    const delta = Math.max(0, ev.tick - prevTick);
    prevTick = ev.tick;
    body.push(...encodeVlq(delta), ...ev.bytes);
  }
  // End of Track meta event
  body.push(0x00, 0xff, 0x2f, 0x00);

  const chunk = new Uint8Array(8 + body.length);
  chunk[0] = 0x4d; // M
  chunk[1] = 0x54; // T
  chunk[2] = 0x72; // r
  chunk[3] = 0x6b; // k
  const len = body.length;
  chunk[4] = (len >>> 24) & 0xff;
  chunk[5] = (len >>> 16) & 0xff;
  chunk[6] = (len >>> 8) & 0xff;
  chunk[7] = len & 0xff;
  chunk.set(body, 8);
  return chunk;
}

/**
 * Serializes a VANTA Score Model into a Standard Type-1 Binary MIDI file (`Uint8Array`).
 * @param {object} scoreModel - Output of `buildScoreModel`.
 * @param {object} [meta={}] - Optional `{ title }`.
 * @returns {Uint8Array} Valid `.mid` binary payload.
 */
export function buildMidiBytes(scoreModel, meta = {}) {
  const quarterBpm = Math.max(30, Math.min(300, Number(scoreModel?.quarterBpm || scoreModel?.tempo || 120)));
  const usPerQuarter = Math.round(60000000 / quarterBpm);
  const num = Number(scoreModel?.num) || 4;
  const den = Number(scoreModel?.den) || 4;
  const denPow = Math.max(0, Math.round(Math.log2(den)));
  const fifths = Math.max(-7, Math.min(7, Number(scoreModel?.key?.fifths) || 0));
  const isMinor = scoreModel?.key?.mode === 'minor' ? 1 : 0;
  const trackNameBytes = Array.from(new TextEncoder().encode(String(meta.title || 'VANTA Score').slice(0, 80)));

  // Track 0: Conductor (Name, Tempo, TimeSig, KeySig)
  const conductorEvents = [
    { tick: 0, order: 0, bytes: [0xff, 0x03, trackNameBytes.length, ...trackNameBytes] },
    {
      tick: 0,
      order: 1,
      bytes: [0xff, 0x51, 0x03, (usPerQuarter >>> 16) & 0xff, (usPerQuarter >>> 8) & 0xff, usPerQuarter & 0xff]
    },
    { tick: 0, order: 2, bytes: [0xff, 0x58, 0x04, num & 0xff, denPow & 0xff, 24, 8] },
    { tick: 0, order: 3, bytes: [0xff, 0x59, 0x02, fifths & 0xff, isMinor] }
  ];

  const trebleEvents = [
    { tick: 0, order: 0, bytes: [0xc0, 0x00] } // Program 0 Acoustic Grand Piano Ch 0
  ];
  const bassEvents = [
    { tick: 0, order: 0, bytes: [0xc1, 0x00] } // Program 0 Acoustic Grand Piano Ch 1
  ];

  for (const n of scoreModel?.notes || []) {
    const ch = n.hand === 'bass' ? 1 : 0;
    const target = ch === 1 ? bassEvents : trebleEvents;
    const pitch = Math.max(0, Math.min(127, Math.round(n.pitch)));
    const vel = Math.max(1, Math.min(127, Math.round(n.velocity || 72)));
    const startTick = Math.max(0, Math.round(n.startTick || 0));
    const endTick = Math.max(startTick + 30, Math.round(n.endTick || startTick + 120));
    target.push({ tick: startTick, order: 2, bytes: [0x90 | ch, pitch, vel] });
    target.push({ tick: endTick, order: 1, bytes: [0x80 | ch, pitch, 0x00] });
  }

  const chunks = [
    buildMidiTrackChunk(conductorEvents),
    buildMidiTrackChunk(trebleEvents),
    buildMidiTrackChunk(bassEvents)
  ];

  const header = new Uint8Array(14);
  header.set([0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x01, 0x00, 0x03], 0);
  header[12] = (PPQ >>> 8) & 0xff;
  header[13] = PPQ & 0xff;

  const totalLen = header.length + chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  out.set(header, offset);
  offset += header.length;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function escapeXml(str) {
  return String(str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function splitPitchToXml(midi, preferFlats) {
  const m = Math.max(0, Math.min(127, Math.round(midi)));
  const pc = m % 12;
  const oct = Math.floor(m / 12) - 1;
  const names = preferFlats ? PITCH_CLASS_FLAT : PITCH_CLASS_SHARP;
  const raw = names[pc];
  const step = raw[0];
  const alter = raw.length > 1 ? (raw[1] === '#' ? 1 : -1) : 0;
  return { step, alter, oct };
}

function buildHarmonyXml(symbol) {
  if (!symbol || symbol === 'N.C.') return '';
  const match = /^([A-G])([#b]?)(.*)$/.exec(symbol);
  if (!match) return '';
  const rootStep = match[1];
  const alter = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;
  const suffix = match[3] || '';
  const kindMap = {
    '': 'major',
    m: 'minor',
    '7': 'dominant',
    maj7: 'major-seventh',
    m7: 'minor-seventh',
    sus4: 'suspended-fourth',
    dim: 'diminished'
  };
  const kind = kindMap[suffix] || 'major';
  return [
    '      <harmony>',
    '        <root>',
    `          <root-step>${rootStep}</root-step>`,
    ...(alter !== 0 ? [`          <root-alter>${alter}</root-alter>`] : []),
    '        </root>',
    `        <kind text="${escapeXml(suffix)}">${kind}</kind>`,
    '      </harmony>'
  ].join('\n');
}

function serializeStaffVoiceXml(events, measureTicks, staffNum, voiceNum, preferFlats) {
  const lines = [];
  let cursor = 0;

  // Group events at identical startTickInMeasure into chords
  const groups = [];
  for (const ev of events) {
    const last = groups[groups.length - 1];
    if (last && last.tick === ev.startTickInMeasure) {
      last.notes.push(ev);
    } else {
      groups.push({ tick: ev.startTickInMeasure, notes: [ev] });
    }
  }

  for (const grp of groups) {
    if (grp.tick > cursor) {
      const gap = grp.tick - cursor;
      lines.push(
        '      <note>',
        '        <rest/>',
        `        <duration>${gap}</duration>`,
        `        <voice>${voiceNum}</voice>`,
        `        <staff>${staffNum}</staff>`,
        '      </note>'
      );
      cursor = grp.tick;
    }

    const dur = Math.max(60, Math.min(measureTicks - cursor, grp.notes[0].durTicks));
    const typeName = grp.notes[0].notation?.type || 'eighth';
    const dots = grp.notes[0].notation?.dots || 0;

    grp.notes.forEach((ev, idx) => {
      const p = splitPitchToXml(ev.pitch, preferFlats);
      lines.push('      <note>');
      if (idx > 0) lines.push('        <chord/>');
      lines.push(
        '        <pitch>',
        `          <step>${p.step}</step>`,
        ...(p.alter !== 0 ? [`          <alter>${p.alter}</alter>`] : []),
        `          <octave>${p.oct}</octave>`,
        '        </pitch>',
        `        <duration>${dur}</duration>`,
        ...(ev.tieEnd ? ['        <tie type="stop"/>'] : []),
        ...(ev.tieStart ? ['        <tie type="start"/>'] : []),
        `        <voice>${voiceNum}</voice>`,
        `        <type>${typeName}</type>`,
        ...(dots > 0 ? ['        <dot/>'] : []),
        `        <staff>${staffNum}</staff>`,
        '      </note>'
      );
    });
    cursor += dur;
  }

  if (cursor < measureTicks) {
    const rem = measureTicks - cursor;
    lines.push(
      '      <note>',
      '        <rest/>',
      `        <duration>${rem}</duration>`,
      `        <voice>${voiceNum}</voice>`,
      `        <staff>${staffNum}</staff>`,
      '      </note>'
    );
  }
  return lines.join('\n');
}

/**
 * Serializes a VANTA Score Model into valid MusicXML 4.0 Partwise XML.
 * @param {object} scoreModel - Output of `buildScoreModel`.
 * @param {object} [meta={}] - Optional `{ title, artist }`.
 * @returns {string} UTF-8 MusicXML document.
 */
export function buildMusicXml(scoreModel, meta = {}) {
  const title = escapeXml(meta.title || 'VANTA Transcription');
  const artist = escapeXml(meta.artist || 'VANTA Score Studio');
  const preferFlats = Boolean(scoreModel?.key?.preferFlats);
  const fifths = Number(scoreModel?.key?.fifths) || 0;
  const mode = scoreModel?.key?.mode === 'minor' ? 'minor' : 'major';
  const num = Number(scoreModel?.num) || 4;
  const den = Number(scoreModel?.den) || 4;
  const measureTicks = Number(scoreModel?.measureTicks) || 1920;
  const tempo = Number(scoreModel?.tempo) || 100;

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="4.0">',
    '  <work>',
    `    <work-title>${title}</work-title>`,
    '  </work>',
    '  <identification>',
    `    <creator type="composer">${artist}</creator>`,
    '    <encoding><software>VANTA Score Studio</software></encoding>',
    '  </identification>',
    '  <part-list>',
    '    <score-part id="P1">',
    '      <part-name>Piano</part-name>',
    '    </score-part>',
    '  </part-list>',
    '  <part id="P1">'
  ];

  for (const m of scoreModel?.measures || []) {
    lines.push(`    <measure number="${m.measureNumber}">`);
    if (m.measureNumber === 1) {
      lines.push(
        '      <attributes>',
        `        <divisions>${PPQ}</divisions>`,
        '        <key>',
        `          <fifths>${fifths}</fifths>`,
        `          <mode>${mode}</mode>`,
        '        </key>',
        '        <time>',
        `          <beats>${num}</beats>`,
        `          <beat-type>${den}</beat-type>`,
        '        </time>',
        '        <staves>2</staves>',
        '        <clef number="1"><sign>G</sign><line>2</line></clef>',
        '        <clef number="2"><sign>F</sign><line>4</line></clef>',
        '      </attributes>',
        '      <direction placement="above">',
        '        <direction-type>',
        `          <metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(scoreModel?.quarterBpm || tempo)}</per-minute></metronome>`,
        '        </direction-type>',
        '      </direction>'
      );
    }

    const firstChord = m.chords?.[0]?.symbol;
    if (firstChord && firstChord !== 'N.C.') {
      lines.push(buildHarmonyXml(firstChord));
    }

    lines.push(serializeStaffVoiceXml(m.trebleEvents || [], measureTicks, 1, 1, preferFlats));
    lines.push(`      <backup><duration>${measureTicks}</duration></backup>`);
    lines.push(serializeStaffVoiceXml(m.bassEvents || [], measureTicks, 2, 2, preferFlats));
    lines.push('    </measure>');
  }

  lines.push('  </part>', '</score-partwise>');
  return lines.join('\n');
}

/**
 * Encodes normalized mono or stereo `Float32Array` channels (`[-1, 1]`) into a RIFF PCM 16-bit WAV byte buffer.
 * @param {Float32Array[]} channels - Array of 1 or 2 audio sample buffers.
 * @param {number} [sampleRate=44100] - Sample rate in Hz.
 * @returns {Uint8Array} Complete RIFF/WAVE PCM16 buffer.
 */
export function encodePcmToWavBytes(channels = [], sampleRate = 44100) {
  const numChannels = channels.length >= 2 ? 2 : 1;
  const ch0 = channels[0] instanceof Float32Array ? channels[0] : new Float32Array(0);
  const ch1 = numChannels === 2 && channels[1] instanceof Float32Array ? channels[1] : ch0;
  const numFrames = ch0.length;
  const rate = Math.max(8000, Math.min(192000, Math.round(Number(sampleRate) || 44100)));
  const dataBytes = numFrames * numChannels * 2;

  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    const s0 = Math.max(-1, Math.min(1, ch0[i] || 0));
    view.setInt16(offset, s0 < 0 ? Math.round(s0 * 32768) : Math.round(s0 * 32767), true);
    offset += 2;
    if (numChannels === 2) {
      const s1 = Math.max(-1, Math.min(1, ch1[i] || 0));
      view.setInt16(offset, s1 < 0 ? Math.round(s1 * 32768) : Math.round(s1 * 32767), true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}
