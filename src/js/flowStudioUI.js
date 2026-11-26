/**
 * @fileoverview VANTA Playlist Flow Studio — Fullscreen DAG Visual Node-Graph Modal Controller.
 * Zero-bundler Vanilla ES Module with strict CSP compliance (programmatic DOM, no inline HTML injection).
 */

import { CAMELOT_KEY_MAP, evaluateHarmonicCompatibility } from './mirAnalyzer.js';
import { GENRE_TAXONOMY } from './vibeRecommender.js';
import {
  FLOW_NODE_CATEGORIES,
  FLOW_NODE_REGISTRY,
  FLOW_PRESET_TEMPLATES,
  buildFlowSchedule,
  executeFlowGraph,
  getTrackIdentityKey,
  hasPlaylistReferenceCycle,
  validateFlowGraph
} from './playlistFlowEngine.js';

const NODE_WIDTH = 216;
const NODE_HEIGHT = 96;
const OUTPUT_PORT_Y = 50;
const SINGLE_INPUT_Y = 50;
const DUAL_INPUT_Y = [36, 70];

function formatDurationClock(totalSec) {
  const sec = Math.max(0, Math.round(Number(totalSec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function getCamelotCode(keyStr) {
  return CAMELOT_KEY_MAP[keyStr]?.code || String(keyStr || '8A');
}

function createSvgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

/**
 * Interactive fullscreen modal controller for creating and editing DAG Flow Playlists.
 */
export class FlowStudioController {
  /**
   * @param {object} hostApp - Bridge callbacks to VantaStudioApp.
   */
  constructor(hostApp) {
    this.host = hostApp;
    this.isOpen = false;
    this.editingFlowId = null;
    this.flowName = '';
    this.flowDescription = '';
    this.draftVisual = { mode: 'auto', presetKey: 'synth', imagePath: '' };
    this.nodes = {};
    this.edges = [];
    this.selectedNodeId = null;
    this.wiringFromId = null;
    this.rightTapMode = 'output'; // 'output' | 'selected'
    this.paletteQuery = '';
    this.nextSeq = 1;
    this.runningBatchIdx = -1;
    this.isSaving = false;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this._previewWireEl = null;
    this._lastEval = null;
    this._nodeDomById = new Map();
    this._bound = false;
  }

  /**
   * Binds DOM event listeners once after document ready.
   */
  bindEvents() {
    if (this._bound) return;
    const modal = document.getElementById('flowStudioModal');
    if (!modal) return;
    this._bound = true;

    document.getElementById('btnCloseFlowStudio')?.addEventListener('click', () => this.close());
    document.getElementById('btnCancelFlowStudio')?.addEventListener('click', () => this.close());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) this.close();
    });

    document.getElementById('flowStudioNameInput')?.addEventListener('input', (e) => {
      this.flowName = String(e.target.value || '').trim().replace(/\s+/g, ' ');
      this._updateValidationAndCover();
    });

    document.getElementById('flowStudioDescInput')?.addEventListener('input', (e) => {
      this.flowDescription = String(e.target.value || '').trim().slice(0, 140);
    });

    document.getElementById('flowPaletteSearch')?.addEventListener('input', (e) => {
      this.paletteQuery = String(e.target.value || '').trim().toLowerCase();
      this._renderPalette();
    });

    document.getElementById('btnFlowAutoLayout')?.addEventListener('click', () => this.autoLayout());
    document.getElementById('btnFlowRunBatch')?.addEventListener('click', () => this.simulateBatchRun());
    document.getElementById('btnFlowTapOutput')?.addEventListener('click', () => {
      this.rightTapMode = 'output';
      this._renderStreamTap();
    });
    document.getElementById('btnFlowTapSelected')?.addEventListener('click', () => {
      this.rightTapMode = 'selected';
      this._renderStreamTap();
    });

    document.getElementById('btnFlowPlayOutput')?.addEventListener('click', () => {
      const tracks = this._lastEval?.outputTracks || [];
      if (!tracks.length) {
        this.host.onToast?.('Flow currently produces 0 tracks');
        return;
      }
      this.host.onPlayTracks?.(tracks, this.flowName || 'Flow Preview');
    });

    document.getElementById('btnFlowExportM3u8')?.addEventListener('click', async () => {
      const tracks = this._lastEval?.outputTracks || [];
      if (!tracks.length) {
        this.host.onToast?.('Flow currently produces 0 tracks to export');
        return;
      }
      const btn = document.getElementById('btnFlowExportM3u8');
      if (btn) btn.disabled = true;
      try {
        await this.host.onExportM3u8?.(tracks, this.flowName || 'VANTA_Flow');
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    document.getElementById('btnSaveFlowStudio')?.addEventListener('click', () => this.save());

    document.getElementById('btnUploadFlowCover')?.addEventListener('click', async () => {
      const res = await this.host.pickCoverImage?.(this.editingFlowId || `flow-draft-${Date.now()}`);
      if (!res || res.canceled) return;
      if (res.error || !res.imagePath) {
        this.host.onToast?.(`Cover upload info: ${res.error || 'Could not load image'}`);
        return;
      }
      this.draftVisual = { mode: 'image', presetKey: this.draftVisual.presetKey || 'synth', imagePath: res.imagePath };
      this._renderCoverSwatches();
      this._updateValidationAndCover();
    });

    document.getElementById('btnFlowZoomOut')?.addEventListener('click', () => this.setZoom(this.zoom - 0.15));
    document.getElementById('btnFlowZoomIn')?.addEventListener('click', () => this.setZoom(this.zoom + 0.15));
    document.getElementById('btnFlowZoomFit')?.addEventListener('click', () => this.fitToView({ maxZoom: 1.05 }));

    const viewport = document.getElementById('flowCanvasViewport');
    viewport?.addEventListener('mousemove', (e) => this._updateWiringRubberBand(e));
    viewport?.addEventListener('wheel', (e) => {
      if (!this.isOpen) return;
      e.preventDefault();
      const step = e.deltaY < 0 ? 0.1 : -0.1;
      this.setZoom(this.zoom + step, e.clientX, e.clientY);
    }, { passive: false });

    viewport?.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.flow-node-card, .flow-wire-hit, .flow-canvas-hud, .flow-port-btn')) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const origPanX = this.panX;
      const origPanY = this.panY;
      let panned = false;
      viewport.classList.add('is-panning');

      const onMove = (mv) => {
        const dx = mv.clientX - startX;
        const dy = mv.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panned = true;
        this.panX = Math.round(origPanX + dx);
        this.panY = Math.round(origPanY + dy);
        this._applyCanvasTransform();
      };

      const onUp = () => {
        viewport.classList.remove('is-panning');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (!panned && this.wiringFromId) {
          this.wiringFromId = null;
          this._clearPreviewWire();
          this._renderStatusBar();
          this._renderCanvas();
        }
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    document.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (e.key === 'Escape') {
        if (this.wiringFromId) {
          this.wiringFromId = null;
          this._clearPreviewWire();
          this._renderCanvas();
        } else {
          this.close();
        }
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedNodeId) {
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        this.deleteNode(this.selectedNodeId);
      }
    });
  }

  /**
   * Opens the Flow Studio modal for creating a new flow or editing an existing flow playlist.
   * @param {object|null} [existingFlow=null] - Existing saved flow object, or null for new flow.
   */
  open(existingFlow = null) {
    this.bindEvents();
    const modal = document.getElementById('flowStudioModal');
    if (!modal) return;

    this.isOpen = true;
    this.wiringFromId = null;
    this.runningBatchIdx = -1;
    this.rightTapMode = 'output';
    this.paletteQuery = '';
    const searchEl = document.getElementById('flowPaletteSearch');
    if (searchEl) searchEl.value = '';

    if (existingFlow && existingFlow.kind === 'flow') {
      this.editingFlowId = existingFlow.id;
      this.flowName = existingFlow.name || '';
      this.flowDescription = existingFlow.description || '';
      this.draftVisual = existingFlow.visual && typeof existingFlow.visual === 'object'
        ? {
            mode: existingFlow.visual.mode || 'auto',
            presetKey: existingFlow.visual.presetKey || 'synth',
            imagePath: existingFlow.visual.imagePath || ''
          }
        : { mode: 'auto', presetKey: 'synth', imagePath: '' };
      this.nodes = JSON.parse(JSON.stringify(existingFlow.graph?.nodes || {}));
      this.edges = JSON.parse(JSON.stringify(existingFlow.graph?.edges || []));
    } else {
      this.editingFlowId = null;
      const tpl = FLOW_PRESET_TEMPLATES[0];
      this.flowName = '';
      this.flowDescription = '';
      this.draftVisual = { mode: 'auto', presetKey: 'synth', imagePath: '' };
      this.nodes = JSON.parse(JSON.stringify(tpl.graph.nodes));
      this.edges = JSON.parse(JSON.stringify(tpl.graph.edges));
    }

    this._syncNextSeq();
    const outNode = Object.values(this.nodes).find((n) => n.type === 'output:playlist');
    this.selectedNodeId = outNode?.id || Object.keys(this.nodes)[0] || null;

    const nameInp = document.getElementById('flowStudioNameInput');
    const descInp = document.getElementById('flowStudioDescInput');
    const titleEl = document.getElementById('flowStudioTitle');
    const saveBtn = document.getElementById('btnSaveFlowStudio');
    if (nameInp) nameInp.value = this.flowName;
    if (descInp) descInp.value = this.flowDescription;
    if (titleEl) titleEl.textContent = this.editingFlowId ? 'Edit Flow Playlist' : 'VANTA Playlist Flow Studio';
    if (saveBtn) saveBtn.textContent = this.editingFlowId ? 'Update Flow' : 'Save Flow';

    this._evaluate();
    this._renderAll();
    modal.classList.remove('hidden');
    this.fitToView({ maxZoom: 1 });
    requestAnimationFrame(() => {
      if (this.isOpen) this.fitToView({ maxZoom: 1 });
    });
    nameInp?.focus();
  }

  /**
   * Closes the Flow Studio modal without persisting unsaved changes.
   */
  close() {
    const modal = document.getElementById('flowStudioModal');
    if (!modal) return;
    this.isOpen = false;
    this.wiringFromId = null;
    this._clearPreviewWire();
    modal.classList.add('hidden');
  }

  /**
   * Loads a starter preset template onto the Flow Studio canvas.
   * @param {string} templateKey - Template key from `FLOW_PRESET_TEMPLATES`.
   */
  loadTemplate(templateKey) {
    const tpl = FLOW_PRESET_TEMPLATES.find((t) => t.key === templateKey);
    if (!tpl) return;
    this.nodes = JSON.parse(JSON.stringify(tpl.graph.nodes));
    this.edges = JSON.parse(JSON.stringify(tpl.graph.edges));
    if (!this.editingFlowId) {
      this.flowName = tpl.name;
      this.flowDescription = tpl.description;
      this.draftVisual = { ...tpl.visual };
      const nameInp = document.getElementById('flowStudioNameInput');
      const descInp = document.getElementById('flowStudioDescInput');
      if (nameInp) nameInp.value = this.flowName;
      if (descInp) descInp.value = this.flowDescription;
    }
    this._syncNextSeq();
    const outNode = Object.values(this.nodes).find((n) => n.type === 'output:playlist');
    this.selectedNodeId = outNode?.id || Object.keys(this.nodes)[0] || null;
    this.wiringFromId = null;
    this._evaluate();
    this._renderAll();
    this.fitToView({ maxZoom: 1 });
    this.host.onToast?.(`Loaded template: "${tpl.name}"`);
  }

  _syncNextSeq() {
    let maxNum = 0;
    for (const id of Object.keys(this.nodes)) {
      const m = /(\d+)$/.exec(id);
      if (m) maxNum = Math.max(maxNum, Number(m[1]));
    }
    this.nextSeq = maxNum + 1;
  }

  _buildContext() {
    const catalog = this.host.getCatalog?.() || [];
    return {
      id: this.editingFlowId || '__draft_flow__',
      catalog,
      anchorTrack: this.host.getAnchorTrack?.() || catalog[0] || null,
      banditRewards: this.host.getBanditRewards?.() || {},
      playbackHistory: this.host.getPlaybackHistory?.() || [],
      currentQueue: this.host.getCurrentQueue?.() || [],
      smartPlaylists: this.host.getSmartPlaylists?.() || []
    };
  }

  _evaluate() {
    const ctx = this._buildContext();
    const flowObj = {
      id: ctx.id,
      name: this.flowName || 'Draft Flow',
      kind: 'flow',
      graph: { nodes: this.nodes, edges: this.edges }
    };
    const validation = validateFlowGraph(flowObj, ctx);
    const exec = executeFlowGraph(flowObj, ctx);
    this._lastEval = { ...exec, validation };
    return this._lastEval;
  }

  _renderAll() {
    this._renderTemplatesBar();
    this._renderPalette();
    this._renderCoverSwatches();
    this._renderStatusBar();
    this._renderCanvas();
    this._renderInspector();
    this._renderStreamTap();
    this._updateValidationAndCover();
  }

  _renderTemplatesBar() {
    const host = document.getElementById('flowTemplatesList');
    if (!host) return;
    host.replaceChildren();
    for (const tpl of FLOW_PRESET_TEMPLATES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'flow-tpl-chip';
      btn.textContent = tpl.name;
      btn.title = tpl.description;
      btn.addEventListener('click', () => this.loadTemplate(tpl.key));
      host.appendChild(btn);
    }
  }

  _renderPalette() {
    const host = document.getElementById('flowPaletteList');
    if (!host) return;
    host.replaceChildren();
    const q = this.paletteQuery;

    for (const [catKey, cat] of Object.entries(FLOW_NODE_CATEGORIES)) {
      const defs = Object.values(FLOW_NODE_REGISTRY).filter((d) => {
        if (d.category !== catKey) return false;
        if (!q) return true;
        return d.title.toLowerCase().includes(q) || d.type.toLowerCase().includes(q) || cat.label.toLowerCase().includes(q);
      });
      if (!defs.length) continue;

      const sec = document.createElement('div');
      sec.className = 'flow-palette-group';

      const hdr = document.createElement('div');
      hdr.className = 'flow-palette-heading';
      const dot = document.createElement('span');
      dot.className = 'flow-cat-dot';
      dot.style.backgroundColor = cat.accent;
      hdr.append(dot, cat.label);
      sec.appendChild(hdr);

      for (const def of defs) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'flow-palette-item';
        btn.dataset.nodeType = def.type;
        const lbl = document.createElement('span');
        lbl.textContent = def.title;
        const plus = document.createElement('span');
        plus.className = 'flow-palette-plus';
        plus.textContent = '+';
        btn.append(lbl, plus);
        btn.addEventListener('click', () => this.addNode(def.type));
        sec.appendChild(btn);
      }

      host.appendChild(sec);
    }
  }

  _renderCoverSwatches() {
    const host = document.getElementById('flowCoverSwatches');
    if (!host) return;
    this.host.renderCoverSwatches?.(host, this.draftVisual, (nextVisual) => {
      this.draftVisual = nextVisual;
      this._renderCoverSwatches();
      this._updateValidationAndCover();
    });
  }

  _renderStatusBar() {
    const badge = document.getElementById('flowDagStatusBadge');
    const schedEl = document.getElementById('flowScheduleSummary');
    const wireBanner = document.getElementById('flowWireBanner');
    if (wireBanner) wireBanner.classList.toggle('hidden', !this.wiringFromId);

    const ev = this._lastEval;
    if (badge) {
      if (ev?.hasCycle) {
        badge.textContent = 'Cycle Detected';
        badge.className = 'flow-dag-badge error';
      } else if (ev?.validation && !ev.validation.valid) {
        badge.textContent = 'Check Warnings';
        badge.className = 'flow-dag-badge warn';
      } else {
        badge.textContent = `DAG Valid · ${ev?.schedule?.length || 0} Batches`;
        badge.className = 'flow-dag-badge ok';
      }
    }
    if (schedEl) {
      const nodeCount = Object.keys(this.nodes).length;
      const edgeCount = this.edges.length;
      const levels = (ev?.schedule || []).map((b, i) => `L${i + 1}[${b.length}]`).join(' → ');
      schedEl.textContent = `${nodeCount} nodes · ${edgeCount} wires${levels ? ` · ${levels}` : ''}`;
    }
  }

  _getPortAnchorCoords(node, kind, slot = 0) {
    if (!node) return { x: 0, y: 0 };
    if (kind === 'out') {
      return { x: node.x + NODE_WIDTH, y: node.y + OUTPUT_PORT_Y };
    }
    const def = FLOW_NODE_REGISTRY[node.type];
    const yOff = def?.inputs === 2 ? (DUAL_INPUT_Y[slot] ?? DUAL_INPUT_Y[0]) : SINGLE_INPUT_Y;
    return { x: node.x, y: node.y + yOff };
  }

  _renderWiresOnly() {
    const svg = document.getElementById('flowWireSvg');
    if (!svg) return;
    svg.replaceChildren();
    this._previewWireEl = null;

    for (const edge of this.edges) {
      const [srcId, dstId, rawSlot] = edge;
      const src = this.nodes[srcId];
      const dst = this.nodes[dstId];
      if (!src || !dst) continue;
      const dstDef = FLOW_NODE_REGISTRY[dst.type];
      const slot = dstDef?.inputs === 2 ? (rawSlot === 1 ? 1 : 0) : 0;

      const p1 = this._getPortAnchorCoords(src, 'out', 0);
      const p2 = this._getPortAnchorCoords(dst, 'in', slot);
      let d;
      if (p2.x > p1.x + 18) {
        const dx = Math.max(46, Math.abs(p2.x - p1.x) * 0.5);
        d = `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;
      } else {
        // S-channel routing through inter-row lane when wrapping to next row
        const stub = 18;
        const r = 10;
        const laneY = Math.abs(p2.y - p1.y) >= 48
          ? Math.round((p1.y + p2.y) / 2)
          : Math.round(Math.max(p1.y, p2.y) + 74);
        const dir1 = laneY >= p1.y ? 1 : -1;
        const dir2 = p2.y >= laneY ? 1 : -1;
        d = [
          `M ${p1.x} ${p1.y}`,
          `L ${p1.x + stub - r} ${p1.y}`,
          `Q ${p1.x + stub} ${p1.y} ${p1.x + stub} ${p1.y + dir1 * r}`,
          `L ${p1.x + stub} ${laneY - dir1 * r}`,
          `Q ${p1.x + stub} ${laneY} ${p1.x + stub - r} ${laneY}`,
          `L ${p2.x - stub + r} ${laneY}`,
          `Q ${p2.x - stub} ${laneY} ${p2.x - stub} ${laneY + dir2 * r}`,
          `L ${p2.x - stub} ${p2.y - dir2 * r}`,
          `Q ${p2.x - stub} ${p2.y} ${p2.x - stub + r} ${p2.y}`,
          `L ${p2.x} ${p2.y}`
        ].join(' ');
      }

      const srcDef = FLOW_NODE_REGISTRY[src.type];
      const color = FLOW_NODE_CATEGORIES[srcDef?.category || 'source']?.accent || '#38bdf8';

      const line = createSvgEl('path', {
        d,
        class: 'flow-wire-path',
        stroke: color
      });
      const hit = createSvgEl('path', {
        d,
        class: 'flow-wire-hit'
      });
      hit.addEventListener('click', (e) => {
        e.stopPropagation();
        this.edges = this.edges.filter((ed) => ed !== edge);
        this._evaluate();
        this._renderStatusBar();
        this._renderCanvas();
        this._renderStreamTap();
        this.host.onToast?.('Removed wire connection');
      });

      svg.append(line, hit);
    }
  }

  _clearPreviewWire() {
    if (this._previewWireEl) {
      this._previewWireEl.remove();
      this._previewWireEl = null;
    }
  }

  _updateWiringRubberBand(mouseEvent) {
    if (!this.wiringFromId) return;
    const svg = document.getElementById('flowWireSvg');
    const stage = document.getElementById('flowCanvasStage');
    if (!svg || !stage) return;

    const src = this.nodes[this.wiringFromId];
    if (!src) return;
    const rect = stage.getBoundingClientRect();
    const scale = this.zoom || 1;
    const mx = (mouseEvent.clientX - rect.left) / scale;
    const my = (mouseEvent.clientY - rect.top) / scale;
    const p1 = this._getPortAnchorCoords(src, 'out', 0);
    const dx = Math.max(40, Math.abs(mx - p1.x) * 0.45);
    const d = `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${mx - dx} ${my}, ${mx} ${my}`;

    if (!this._previewWireEl) {
      this._previewWireEl = createSvgEl('path', { class: 'flow-wire-preview' });
      svg.appendChild(this._previewWireEl);
    }
    this._previewWireEl.setAttribute('d', d);
  }

  _applyCanvasTransform() {
    const world = document.getElementById('flowCanvasWorld');
    const viewport = document.getElementById('flowCanvasViewport');
    const zoomLabel = document.getElementById('flowZoomLabel');
    if (world) {
      world.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    }
    if (viewport) {
      const step = Math.max(8, 20 * this.zoom);
      viewport.style.backgroundSize = `${step}px ${step}px`;
      viewport.style.backgroundPosition = `${this.panX}px ${this.panY}px`;
    }
    if (zoomLabel) {
      zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    }
  }

  /**
   * Adjusts canvas zoom level, optionally preserving the point under `(pivotClientX, pivotClientY)`.
   * @param {number} nextZoom - Target zoom factor.
   * @param {number} [pivotClientX] - Optional mouse clientX for anchored zoom.
   * @param {number} [pivotClientY] - Optional mouse clientY for anchored zoom.
   */
  setZoom(nextZoom, pivotClientX = null, pivotClientY = null) {
    const clamped = Math.max(0.45, Math.min(1.6, Number(nextZoom) || 1));
    const viewport = document.getElementById('flowCanvasViewport');
    if (viewport && pivotClientX !== null && pivotClientY !== null) {
      const rect = viewport.getBoundingClientRect();
      const vx = pivotClientX - rect.left;
      const vy = pivotClientY - rect.top;
      const worldX = (vx - this.panX) / this.zoom;
      const worldY = (vy - this.panY) / this.zoom;
      this.zoom = clamped;
      this.panX = Math.round(vx - worldX * this.zoom);
      this.panY = Math.round(vy - worldY * this.zoom);
    } else {
      this.zoom = clamped;
    }
    this._applyCanvasTransform();
  }

  /**
   * Fits and centers all current graph nodes comfortably inside the center canvas viewport.
   * @param {object} [options={}] - Fit bounds options.
   * @param {number} [options.maxZoom=1] - Upper cap on zoom scale so normal graphs remain crisp.
   */
  fitToView(options = {}) {
    const viewport = document.getElementById('flowCanvasViewport');
    const allNodes = Object.values(this.nodes);
    if (!viewport || !viewport.clientWidth || !viewport.clientHeight || !allNodes.length) {
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;
      this._applyCanvasTransform();
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of allNodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + NODE_WIDTH);
      maxY = Math.max(maxY, n.y + NODE_HEIGHT);
    }

    const contentW = Math.max(100, maxX - minX);
    const contentH = Math.max(100, maxY - minY);
    const pad = 28;
    const availW = Math.max(180, viewport.clientWidth - pad * 2);
    const availH = Math.max(180, viewport.clientHeight - pad * 2);
    const maxZ = options.maxZoom ?? 1.0;
    const scale = Math.max(0.45, Math.min(maxZ, availW / contentW, availH / contentH));

    this.zoom = Number(scale.toFixed(3));
    this.panX = Math.round((viewport.clientWidth - contentW * this.zoom) / 2 - minX * this.zoom);
    this.panY = Math.round((viewport.clientHeight - contentH * this.zoom) / 2 - minY * this.zoom);
    this._applyCanvasTransform();
  }

  _renderCanvas() {
    const stage = document.getElementById('flowCanvasStage');
    const nodesLayer = document.getElementById('flowNodesLayer');
    if (!stage || !nodesLayer) return;

    const allNodes = Object.values(this.nodes);
    const maxX = allNodes.reduce((m, n) => Math.max(m, n.x + NODE_WIDTH + 160), 1400);
    const maxY = allNodes.reduce((m, n) => Math.max(m, n.y + NODE_HEIGHT + 160), 760);
    stage.style.width = `${maxX}px`;
    stage.style.height = `${maxY}px`;
    this._applyCanvasTransform();

    this._renderWiresOnly();
    nodesLayer.replaceChildren();
    this._nodeDomById.clear();

    const ctx = this._buildContext();
    const activeBatch = this.runningBatchIdx >= 0
      ? (this._lastEval?.schedule?.[this.runningBatchIdx] || [])
      : [];

    for (const node of allNodes) {
      const def = FLOW_NODE_REGISTRY[node.type];
      if (!def) continue;
      const cat = FLOW_NODE_CATEGORIES[def.category];
      const tracks = this._lastEval?.nodeResults?.get(node.id) || [];
      const err = this._lastEval?.nodeErrors?.get(node.id) || '';
      const totalSec = tracks.reduce((acc, t) => acc + (Number(t.durationSec) || 180), 0);

      const card = document.createElement('div');
      card.className = 'flow-node-card';
      if (def.inputs === 2) card.classList.add('has-dual-inputs');
      if (this.selectedNodeId === node.id) card.classList.add('selected');
      if (activeBatch.includes(node.id)) card.classList.add('running');
      if (err) card.classList.add('has-error');
      card.style.left = `${node.x}px`;
      card.style.top = `${node.y}px`;
      card.dataset.nodeId = node.id;

      const hdr = document.createElement('div');
      hdr.className = 'flow-node-hdr';
      hdr.style.borderTopColor = cat.accent;

      const titleWrap = document.createElement('div');
      titleWrap.className = 'flow-node-title-wrap';
      const dot = document.createElement('span');
      dot.className = 'flow-cat-dot';
      dot.style.backgroundColor = cat.accent;
      const title = document.createElement('span');
      title.className = 'flow-node-title';
      title.textContent = def.title;
      titleWrap.append(dot, title);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'flow-node-del';
      delBtn.textContent = '×';
      delBtn.title = `Delete ${def.title}`;
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteNode(node.id);
      });

      hdr.append(titleWrap, delBtn);

      const body = document.createElement('div');
      body.className = 'flow-node-body';

      const desc = document.createElement('div');
      desc.className = 'flow-node-desc';
      const mergedParams = { ...def.defaults, ...(node.params || {}) };
      desc.textContent = err || def.summarize(mergedParams, ctx);
      if (err) desc.classList.add('error-text');

      const footer = document.createElement('div');
      footer.className = 'flow-node-footer';
      const countBadge = document.createElement('span');
      countBadge.className = 'flow-node-count';
      countBadge.textContent = `${tracks.length} track${tracks.length === 1 ? '' : 's'} · ${formatDurationClock(totalSec)}`;
      const idEl = document.createElement('span');
      idEl.className = 'flow-node-id';
      idEl.textContent = `#${node.id}`;
      footer.append(countBadge, idEl);

      body.append(desc, footer);
      card.append(hdr, body);

      // Input Port(s)
      for (let slot = 0; slot < def.inputs; slot++) {
        const portBtn = document.createElement('button');
        portBtn.type = 'button';
        portBtn.className = 'flow-port-btn in';
        const topPx = def.inputs === 2 ? DUAL_INPUT_Y[slot] : SINGLE_INPUT_Y;
        portBtn.style.top = `${topPx - 7}px`;
        const slotLabel = def.inputLabels?.[slot] || 'In';
        portBtn.title = `Input ${slotLabel}`;
        if (def.inputs === 2) {
          const tag = document.createElement('span');
          tag.className = 'flow-port-tag';
          tag.textContent = slotLabel.slice(0, 1);
          portBtn.appendChild(tag);
        }
        portBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.wiringFromId && this.wiringFromId !== node.id) {
            this.connectNodes(this.wiringFromId, node.id, slot);
          }
        });
        card.appendChild(portBtn);
      }

      // Output Port
      if (def.outputs > 0) {
        const outBtn = document.createElement('button');
        outBtn.type = 'button';
        const activeWireSrc = this.wiringFromId === node.id;
        outBtn.className = `flow-port-btn out${activeWireSrc ? ' active' : ''}`;
        outBtn.style.top = `${OUTPUT_PORT_Y - 7}px`;
        outBtn.style.backgroundColor = cat.accent;
        outBtn.title = 'Output stream (click then click target input port)';
        outBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.wiringFromId = activeWireSrc ? null : node.id;
          if (!this.wiringFromId) this._clearPreviewWire();
          this._renderStatusBar();
          this._renderCanvas();
        });
        card.appendChild(outBtn);
      }

      // Drag & Select without recreating DOM on every mousemove
      card.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || e.target.closest('button')) return;
        e.preventDefault();
        if (this.selectedNodeId !== node.id) {
          this.selectedNodeId = node.id;
          this._nodeDomById.forEach((el, id) => el.classList.toggle('selected', id === node.id));
          this._renderInspector();
          if (this.rightTapMode === 'selected') this._renderStreamTap();
        }

        const startX = e.clientX;
        const startY = e.clientY;
        const origX = node.x;
        const origY = node.y;

        const onMove = (mv) => {
          const scale = this.zoom || 1;
          node.x = Math.max(12, Math.round(origX + (mv.clientX - startX) / scale));
          node.y = Math.max(12, Math.round(origY + (mv.clientY - startY) / scale));
          card.style.left = `${node.x}px`;
          card.style.top = `${node.y}px`;
          this._renderWiresOnly();
        };

        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      this._nodeDomById.set(node.id, card);
      nodesLayer.appendChild(card);
    }
  }

  _collectCatalogFieldOptions() {
    const catalog = this.host.getCatalog?.() || [];
    const folders = new Set();
    const albums = new Set();
    const artists = new Set();
    const genres = new Set();

    for (const cat of GENRE_TAXONOMY) {
      genres.add(cat.main);
      for (const s of cat.subs) genres.add(s);
    }

    for (const t of catalog) {
      if (t.filePath) {
        const norm = String(t.filePath).replace(/\\/g, '/');
        const idx = norm.lastIndexOf('/');
        if (idx > 0) folders.add(String(t.filePath).slice(0, idx));
      }
      if (t.album && !/^vanta media vault$/i.test(t.album)) albums.add(t.album);
      if (t.artist) artists.add(t.artist);
      if (t.genre) genres.add(t.genre);
    }

    return {
      folders: [...folders].sort((a, b) => a.localeCompare(b)),
      albums: [...albums].sort((a, b) => a.localeCompare(b)),
      artists: [...artists].sort((a, b) => a.localeCompare(b)),
      genres: [...genres].sort((a, b) => a.localeCompare(b)),
      tracks: catalog
    };
  }

  _renderInspector() {
    const body = document.getElementById('flowInspectorBody');
    const catPill = document.getElementById('flowInspectorCatPill');
    if (!body) return;
    body.replaceChildren();

    const node = this.nodes[this.selectedNodeId];
    if (!node) {
      if (catPill) {
        catPill.textContent = 'None';
        catPill.style.backgroundColor = '';
      }
      const msg = document.createElement('div');
      msg.className = 'flow-inspector-empty';
      msg.textContent = 'Select any node on the canvas to configure its parameters.';
      body.appendChild(msg);
      return;
    }

    const def = FLOW_NODE_REGISTRY[node.type];
    if (!def) return;
    const cat = FLOW_NODE_CATEGORIES[def.category];
    if (catPill) {
      catPill.textContent = cat.label;
      catPill.style.borderColor = cat.accent;
      catPill.style.color = cat.accent;
    }

    const hdr = document.createElement('div');
    hdr.className = 'flow-inspector-node-hdr';
    const nameEl = document.createElement('div');
    nameEl.className = 'flow-inspector-node-name';
    nameEl.textContent = `${def.title} (#${node.id})`;
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-ghost btn-compact-sm btn-danger-ghost';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => this.deleteNode(node.id));
    hdr.append(nameEl, delBtn);
    body.appendChild(hdr);

    const params = { ...def.defaults, ...(node.params || {}) };
    node.params = params;
    const catalogOpts = this._collectCatalogFieldOptions();
    const onFieldChange = (reRender) => {
      this._evaluate();
      this._renderStatusBar();
      this._renderCanvas();
      this._renderStreamTap();
      this._updateValidationAndCover();
      if (reRender) this._renderInspector();
    };

    if (!def.fields.length) {
      const p = document.createElement('div');
      p.className = 'flow-inspector-empty';
      p.textContent = 'This node requires no extra configuration parameters.';
      body.appendChild(p);
    }

    for (const field of def.fields) {
      if (field.kind === 'checkbox') {
        const lbl = document.createElement('label');
        lbl.className = 'flow-inspector-check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = Boolean(params[field.key]);
        cb.addEventListener('change', () => {
          params[field.key] = cb.checked;
          onFieldChange(false);
        });
        const sp = document.createElement('span');
        sp.textContent = field.label;
        lbl.append(cb, sp);
        body.appendChild(lbl);
        continue;
      }

      const wrap = document.createElement('label');
      wrap.className = 'flow-inspector-field';
      const lbl = document.createElement('span');
      lbl.className = 'smart-rule-label';
      lbl.textContent = field.label;
      wrap.appendChild(lbl);

      if (field.kind === 'number' || field.kind === 'text') {
        const inp = document.createElement('input');
        inp.type = field.kind;
        inp.className = 'smart-rule-input';
        if (field.kind === 'number') {
          if (field.min !== undefined) inp.min = String(field.min);
          if (field.max !== undefined) inp.max = String(field.max);
          inp.value = String(params[field.key] ?? '');
          inp.addEventListener('input', () => {
            params[field.key] = Number(inp.value);
            onFieldChange(false);
          });
        } else {
          inp.placeholder = field.placeholder || '';
          inp.value = String(params[field.key] ?? '');
          inp.addEventListener('input', () => {
            params[field.key] = inp.value;
            onFieldChange(false);
          });
        }
        wrap.appendChild(inp);
        body.appendChild(wrap);
        continue;
      }

      const sel = document.createElement('select');
      sel.className = 'smart-rule-input';
      const optList = [];

      if (field.kind === 'select') {
        optList.push(...field.options);
      } else if (field.kind === 'smart_playlist_select') {
        optList.push({ value: '', label: '-- Select Saved Playlist --' });
        const all = this.host.getSmartPlaylists?.() || [];
        const selfId = this.editingFlowId || '__draft_flow__';
        for (const sp of all) {
          if (sp.id === selfId) continue;
          const tag = sp.kind === 'flow' ? '[FLOW]' : '[RULE]';
          const wouldCycle = sp.kind === 'flow' && this.editingFlowId
            ? hasPlaylistReferenceCycle(this.editingFlowId, sp.id, all)
            : false;
          if (!wouldCycle) optList.push({ value: sp.id, label: `${tag} ${sp.name}` });
        }
      } else if (field.kind === 'folder_select') {
        optList.push({ value: '', label: 'All Folders' });
        for (const f of catalogOpts.folders) optList.push({ value: f, label: f });
      } else if (field.kind === 'album_select') {
        optList.push({ value: '', label: '-- Select Album --' });
        for (const a of catalogOpts.albums) optList.push({ value: a, label: a });
      } else if (field.kind === 'artist_select') {
        optList.push({ value: '', label: '-- Select Artist --' });
        for (const ar of catalogOpts.artists) optList.push({ value: ar, label: ar });
      } else if (field.kind === 'genre_select') {
        optList.push({ value: '', label: 'Any Genre' });
        for (const g of catalogOpts.genres) optList.push({ value: g, label: g });
      } else if (field.kind === 'track_select') {
        optList.push({ value: '', label: '-- First / Active Track --' });
        for (const t of catalogOpts.tracks.slice(0, 200)) {
          const k = getTrackIdentityKey(t);
          optList.push({ value: k, label: `${t.title || t.fileName} — ${t.artist || 'Unknown'} (${t.bpm || 124} BPM)` });
        }
      }

      const curVal = String(params[field.key] ?? '');
      if (curVal && !optList.some((o) => String(o.value) === curVal)) {
        optList.push({ value: curVal, label: curVal });
      }

      for (const o of optList) {
        const opt = document.createElement('option');
        opt.value = String(o.value);
        opt.textContent = o.label;
        opt.selected = String(o.value) === curVal;
        sel.appendChild(opt);
      }

      sel.addEventListener('change', () => {
        params[field.key] = field.parse ? field.parse(sel.value) : sel.value;
        onFieldChange(Boolean(field.reRenderInspector));
      });
      wrap.appendChild(sel);
      body.appendChild(wrap);
    }

    // Quick Disconnect Incoming Wires button when node has incoming edges
    const hasIncoming = this.edges.some((e) => e[1] === node.id);
    if (hasIncoming) {
      const discBtn = document.createElement('button');
      discBtn.type = 'button';
      discBtn.className = 'btn btn-ghost btn-compact-sm';
      discBtn.textContent = 'Disconnect Incoming Wires';
      discBtn.addEventListener('click', () => {
        this.edges = this.edges.filter((e) => e[1] !== node.id);
        this._evaluate();
        this._renderStatusBar();
        this._renderCanvas();
        this._renderInspector();
        this._renderStreamTap();
      });
      body.appendChild(discBtn);
    }
  }

  _renderStreamTap() {
    const outBtn = document.getElementById('btnFlowTapOutput');
    const selBtn = document.getElementById('btnFlowTapSelected');
    const sumEl = document.getElementById('flowTapSummary');
    const listEl = document.getElementById('flowTapList');
    if (!listEl) return;

    outBtn?.classList.toggle('active', this.rightTapMode === 'output');
    selBtn?.classList.toggle('active', this.rightTapMode === 'selected');

    let tracks = [];
    if (this.rightTapMode === 'selected' && this.selectedNodeId) {
      tracks = this._lastEval?.nodeResults?.get(this.selectedNodeId) || [];
    } else {
      tracks = this._lastEval?.outputTracks || [];
    }

    const totalSec = tracks.reduce((acc, t) => acc + (Number(t.durationSec) || 180), 0);
    if (sumEl) {
      sumEl.textContent = `${tracks.length} track${tracks.length === 1 ? '' : 's'} · ${formatDurationClock(totalSec)}`;
    }

    listEl.replaceChildren();
    if (!tracks.length) {
      const empty = document.createElement('div');
      empty.className = 'flow-tap-empty';
      empty.textContent = this._lastEval?.hasCycle
        ? 'Cycle detected — fix wiring to preview stream.'
        : 'No tracks matched this stream.';
      listEl.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    tracks.slice(0, 120).forEach((t, idx) => {
      const row = document.createElement('div');
      row.className = 'flow-tap-row';

      const info = document.createElement('div');
      info.className = 'flow-tap-info';
      const title = document.createElement('div');
      title.className = 'flow-tap-title';
      title.textContent = `${idx + 1}. ${t.title || t.fileName || 'Untitled'}`;
      const sub = document.createElement('div');
      sub.className = 'flow-tap-sub';
      sub.textContent = `${t.artist || 'Unknown'} · ${t.ext || 'AUDIO'}`;
      info.append(title, sub);

      const pills = document.createElement('div');
      pills.className = 'flow-tap-pills';
      const bpmEl = document.createElement('span');
      bpmEl.className = 'flow-tap-pill';
      bpmEl.textContent = `${Math.round(Number(t.bpm) || 124)}`;

      const keyEl = document.createElement('span');
      keyEl.className = 'flow-tap-pill';
      const prev = idx > 0 ? tracks[idx - 1] : null;
      const harmonicOk = !prev || evaluateHarmonicCompatibility(prev.key || 'A min', t.key || 'A min').compatible;
      keyEl.classList.add(harmonicOk ? 'harmonic-ok' : 'harmonic-jump');
      keyEl.textContent = getCamelotCode(t.key);

      pills.append(bpmEl, keyEl);
      row.append(info, pills);
      frag.appendChild(row);
    });
    listEl.appendChild(frag);
  }

  _updateValidationAndCover() {
    const valEl = document.getElementById('flowValidationMsg');
    const saveBtn = document.getElementById('btnSaveFlowStudio');
    const coverHost = document.getElementById('flowCoverPreview');

    const outputTracks = this._lastEval?.outputTracks || [];
    if (coverHost && this.host.buildCoverElement) {
      coverHost.replaceChildren(
        this.host.buildCoverElement(
          { name: this.flowName || 'Flow', visual: this.draftVisual },
          outputTracks,
          'md'
        )
      );
    }

    let err = '';
    const nodeCount = Object.keys(this.nodes).length;
    if (this._lastEval?.hasCycle) {
      err = this._lastEval.error;
    } else if (this._lastEval?.validation && !this._lastEval.validation.valid) {
      err = this._lastEval.validation.errors[0];
    } else if (nodeCount === 0) {
      err = 'Add at least one node to build a Flow.';
    } else if (!this.flowName) {
      err = 'Enter a name for this Flow Playlist.';
    } else if (this.host.isDuplicateName?.(this.flowName, this.editingFlowId)) {
      err = `A playlist named "${this.flowName}" already exists. Choose a unique name.`;
    }

    if (valEl) {
      valEl.textContent = err;
      valEl.classList.toggle('hidden', !err);
    }
    if (saveBtn) {
      saveBtn.disabled = Boolean(err) || this.isSaving;
    }
  }

  /**
   * Adds a new node onto the canvas and connects it automatically if a single-output node is selected.
   * @param {string} typeKey - Key in `FLOW_NODE_REGISTRY`.
   */
  addNode(typeKey) {
    const def = FLOW_NODE_REGISTRY[typeKey];
    if (!def) return;
    const id = `n${this.nextSeq++}`;
    const prevNode = this.selectedNodeId ? this.nodes[this.selectedNodeId] : null;
    const prevDef = prevNode ? FLOW_NODE_REGISTRY[prevNode.type] : null;

    const count = Object.keys(this.nodes).length;
    let x = 24 + (count % 3) * 242;
    let y = 32 + Math.floor(count / 3) * 140;
    if (prevNode) {
      if (prevNode.x + 242 > 540) {
        x = 24;
        y = prevNode.y + 168;
      } else {
        x = prevNode.x + 242;
        y = prevNode.y;
      }
    }

    this.nodes[id] = {
      id,
      type: typeKey,
      x,
      y,
      params: { ...def.defaults }
    };

    // Convenience auto-wire when adding a filter/sorter/output right after a source/filter
    if (prevNode && prevDef?.outputs > 0 && def.inputs === 1) {
      this.edges.push([prevNode.id, id]);
    }

    this.selectedNodeId = id;
    this._evaluate();
    this._renderStatusBar();
    this._renderCanvas();
    this._renderInspector();
    this._renderStreamTap();
    this._updateValidationAndCover();
  }

  /**
   * Removes a node and its attached wires from the graph.
   * @param {string} nodeId - Target node ID.
   */
  deleteNode(nodeId) {
    if (!this.nodes[nodeId]) return;
    delete this.nodes[nodeId];
    this.edges = this.edges.filter((e) => e[0] !== nodeId && e[1] !== nodeId);
    if (this.selectedNodeId === nodeId) {
      this.selectedNodeId = Object.keys(this.nodes)[0] || null;
    }
    if (this.wiringFromId === nodeId) {
      this.wiringFromId = null;
      this._clearPreviewWire();
    }
    this._evaluate();
    this._renderStatusBar();
    this._renderCanvas();
    this._renderInspector();
    this._renderStreamTap();
    this._updateValidationAndCover();
  }

  /**
   * Connects an output port to an input slot (`0` or `1`) if acyclic.
   * @param {string} srcId - Source node ID.
   * @param {string} dstId - Destination node ID.
   * @param {number} [slot=0] - Target input port slot index.
   */
  connectNodes(srcId, dstId, slot = 0) {
    const dstDef = FLOW_NODE_REGISTRY[this.nodes[dstId]?.type];
    if (!dstDef || dstDef.inputs <= 0) return;

    const normalizedSlot = dstDef.inputs === 2 ? (slot === 1 ? 1 : 0) : 0;
    const filteredEdges = this.edges.filter((e) => {
      if (e[1] !== dstId) return true;
      const existingSlot = dstDef.inputs === 2 ? (e[2] === 1 ? 1 : 0) : 0;
      return existingSlot !== normalizedSlot;
    });

    const newEdge = dstDef.inputs === 2 ? [srcId, dstId, normalizedSlot] : [srcId, dstId];
    const candidateEdges = [...filteredEdges, newEdge];
    const schedCheck = buildFlowSchedule(this.nodes, candidateEdges);
    if (schedCheck.hasCycle) {
      this.wiringFromId = null;
      this._clearPreviewWire();
      this._renderStatusBar();
      this._renderCanvas();
      this.host.onToast?.('Blocked wire: connecting backwards creates a cycle in the DAG');
      return;
    }

    this.edges = candidateEdges;
    this.wiringFromId = null;
    this._clearPreviewWire();
    this._evaluate();
    this._renderStatusBar();
    this._renderCanvas();
    this._renderInspector();
    this._renderStreamTap();
    this._updateValidationAndCover();
  }

  /**
   * Organizes nodes cleanly into wrapped left-to-right topological rows fitted inside the viewport.
   */
  autoLayout() {
    const sched = buildFlowSchedule(this.nodes, this.edges);
    if (sched.hasCycle) {
      this.host.onToast?.('Fix cyclic wires before running Auto-Layout');
      return;
    }

    const viewport = document.getElementById('flowCanvasViewport');
    const viewW = viewport?.clientWidth || 780;
    const colsPerRow = Math.max(2, Math.min(4, Math.floor((viewW - 36) / 242)));
    const batches = sched.schedule;
    let bandStartY = 28;

    for (let startCol = 0; startCol < batches.length; startCol += colsPerRow) {
      const bandBatches = batches.slice(startCol, startCol + colsPerRow);
      let maxRowsInBand = 1;
      bandBatches.forEach((batch, colInBand) => {
        maxRowsInBand = Math.max(maxRowsInBand, batch.length);
        batch.forEach((nodeId, rowIdx) => {
          if (this.nodes[nodeId]) {
            this.nodes[nodeId].x = 24 + colInBand * 242;
            this.nodes[nodeId].y = bandStartY + rowIdx * 124;
          }
        });
      });
      bandStartY += maxRowsInBand * 124 + 66;
    }

    this._renderCanvas();
    this.fitToView({ maxZoom: 1 });
    this.host.onToast?.('Aligned flow nodes to fit workspace');
  }

  /**
   * Animates sequential topological batch execution across the live graph.
   */
  async simulateBatchRun() {
    if (this._lastEval?.hasCycle) {
      this.host.onToast?.('Fix DAG cycle before running batch simulation');
      return;
    }
    const btn = document.getElementById('btnFlowRunBatch');
    if (btn) btn.disabled = true;
    const schedule = this._lastEval?.schedule || [];
    try {
      for (let i = 0; i < schedule.length; i++) {
        this.runningBatchIdx = i;
        this._nodeDomById.forEach((el, id) => {
          el.classList.toggle('running', schedule[i].includes(id));
        });
        await new Promise((r) => setTimeout(r, 320));
      }
    } finally {
      this.runningBatchIdx = -1;
      this._nodeDomById.forEach((el) => el.classList.remove('running'));
      if (btn) btn.disabled = false;
    }
    this.host.onToast?.(`Executed ${schedule.length} topological batches (${this._lastEval?.outputTracks?.length || 0} output tracks)`);
  }

  /**
   * Validates and saves the Flow Playlist via host callback.
   */
  async save() {
    if (this.isSaving) return;
    this._evaluate();
    this._updateValidationAndCover();
    const saveBtn = document.getElementById('btnSaveFlowStudio');
    if (saveBtn?.disabled) return;

    this.isSaving = true;
    if (saveBtn) saveBtn.disabled = true;
    try {
      const flowObj = {
        id: this.editingFlowId || `sp-flow-${Date.now()}`,
        kind: 'flow',
        name: this.flowName,
        description: this.flowDescription,
        visual: { ...this.draftVisual },
        graph: {
          nodes: JSON.parse(JSON.stringify(this.nodes)),
          edges: JSON.parse(JSON.stringify(this.edges))
        }
      };
      const ok = await this.host.onSaveFlow?.(flowObj, Boolean(this.editingFlowId));
      if (ok) this.close();
    } finally {
      this.isSaving = false;
      this._updateValidationAndCover();
    }
  }
}
