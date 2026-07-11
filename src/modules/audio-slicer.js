/**
 * audio-slicer.js — Audio Slicer tool for splitting dialogue recordings.
 * Self-contained module: handles UI, waveform rendering, markers, playback, and export.
 */
import { encodeWAV } from './wav-encoder.js';
import { esc } from '../utils/helpers.js';

// ─── STATE ───────────────────────────────────────────
let audioBuffer = null;
let audioContext = null;
let sourceNode = null;
let isPlaying = false;
let playStartTime = 0;
let playStartOffset = 0;
let playSegmentEnd = null; // null = play until end
let animFrameId = null;

let markers = [];       // Array of time positions in seconds, always sorted
let playheadTime = 0;   // Playback start position (set by Shift+Click)
let zoom = 1;           // 1 = fit entire audio, higher = more zoomed in
let scrollX = 0;        // Horizontal scroll offset in pixels
let fileName = '';
let namePattern = '{file}_{num}'; // Naming pattern. Tokens: {file}, {num} (01), {num3} (001)
let customNames = [];   // Per-segment manual name overrides (index → string); survives re-renders

// Canvas refs
let waveCanvas = null;
let waveCtx = null;
let overlayCanvas = null;
let overlayCtx = null;

// Drag state
let draggingMarkerIdx = -1;
let isDraggingScroll = false;
let lastScrollMouseX = 0;

// ─── INIT ────────────────────────────────────────────
export function init() {
  const overlay = document.getElementById('audio-slicer-overlay');
  if (!overlay) return;

  // Close button
  const closeBtn = overlay.querySelector('.slicer-close');
  if (closeBtn) closeBtn.addEventListener('click', close);

  // Drop zone
  const dropZone = overlay.querySelector('.slicer-drop-zone');
  if (dropZone) {
    dropZone.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*';
      input.addEventListener('change', () => {
        if (input.files[0]) loadAudioFile(input.files[0]);
      });
      input.click();
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-active');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drag-active');
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-active');
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('audio/')) {
        loadAudioFile(file);
      }
    });
  }

  // Transport controls
  overlay.querySelector('#slicer-play')?.addEventListener('click', togglePlayPause);
  overlay.querySelector('#slicer-stop')?.addEventListener('click', stopPlayback);
  overlay.querySelector('#slicer-zoom-in')?.addEventListener('click', () => setZoom(zoom * 1.5));
  overlay.querySelector('#slicer-zoom-out')?.addEventListener('click', () => setZoom(zoom / 1.5));
  overlay.querySelector('#slicer-zoom-fit')?.addEventListener('click', () => setZoom(1));

  // Export buttons
  overlay.querySelector('#slicer-export-zip')?.addEventListener('click', exportZip);
  overlay.querySelector('#slicer-export-single')?.addEventListener('click', exportIndividual);

  // Clear button
  overlay.querySelector('#slicer-clear')?.addEventListener('click', clearAudio);

  // Naming pattern + batch rename tools
  const patternInput = overlay.querySelector('#slicer-name-pattern');
  if (patternInput) {
    patternInput.value = namePattern;
    patternInput.addEventListener('input', () => {
      namePattern = patternInput.value;
      renderSegmentList(); // live preview on all non-overridden names
    });
  }
  overlay.querySelector('#slicer-apply-pattern')?.addEventListener('click', () => {
    customNames = []; // drop manual overrides — every segment goes back to the pattern
    renderSegmentList();
  });
  overlay.querySelector('#slicer-rename-apply')?.addEventListener('click', () => {
    if (!audioBuffer) return;
    const find = overlay.querySelector('#slicer-rename-find')?.value ?? '';
    const replace = overlay.querySelector('#slicer-rename-replace')?.value ?? '';
    if (!find) return;
    const total = markers.length + 1;
    for (let i = 0; i < total; i++) {
      const current = effectiveName(i, total);
      if (current.includes(find)) customNames[i] = current.split(find).join(replace);
    }
    renderSegmentList();
  });

  // Canvas setup
  waveCanvas = overlay.querySelector('#slicer-waveform');
  overlayCanvas = overlay.querySelector('#slicer-overlay-canvas');
  if (waveCanvas) waveCtx = waveCanvas.getContext('2d');
  if (overlayCanvas) {
    overlayCtx = overlayCanvas.getContext('2d');
    setupCanvasInteraction(overlayCanvas);
  }

  // Keyboard shortcuts while overlay is visible
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if (e.key === ' ' && audioBuffer) { e.preventDefault(); togglePlayPause(); }
    if (e.key === 'Delete' && draggingMarkerIdx >= 0) {
      markers.splice(draggingMarkerIdx, 1);
      draggingMarkerIdx = -1;
      renderOverlay();
      renderSegmentList();
    }
  });
}

// ─── OPEN / CLOSE ────────────────────────────────────
export function open() {
  const overlay = document.getElementById('audio-slicer-overlay');
  if (overlay) {
    overlay.classList.add('active');
    overlay.focus();
    if (audioBuffer) {
      resizeCanvases();
      renderWaveform();
      renderOverlay();
    }
  }
}

export function close() {
  stopPlayback();
  const overlay = document.getElementById('audio-slicer-overlay');
  if (overlay) overlay.classList.remove('active');
}

// ─── LOAD AUDIO ──────────────────────────────────────
async function loadAudioFile(file) {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  fileName = file.name.replace(/\.[^.]+$/, '');

  const overlay = document.getElementById('audio-slicer-overlay');
  const dropZone = overlay.querySelector('.slicer-drop-zone');
  const workspace = overlay.querySelector('.slicer-workspace');
  const fileInfo = overlay.querySelector('#slicer-file-info');

  // Show loading state
  if (dropZone) dropZone.innerHTML = '<div class="slicer-loading">⏳ Decodificando audio...</div>';

  try {
    const arrayBuffer = await file.arrayBuffer();
    audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    markers = [];
    zoom = 1;
    scrollX = 0;

    // New audio: drop manual name overrides; the pattern (with {file}) adapts alone.
    customNames = [];
    const patternInput = overlay.querySelector('#slicer-name-pattern');
    if (patternInput && !patternInput.value.trim()) {
      namePattern = '{file}_{num}';
      patternInput.value = namePattern;
    }

    // Update UI
    if (dropZone) dropZone.classList.add('hidden');
    if (workspace) workspace.classList.remove('hidden');
    if (fileInfo) {
      const duration = formatTime(audioBuffer.duration);
      const channels = audioBuffer.numberOfChannels === 1 ? 'Mono' : 'Stereo';
      fileInfo.textContent = `${file.name} — ${duration} — ${audioBuffer.sampleRate}Hz — ${channels}`;
    }

    resizeCanvases();
    renderWaveform();
    renderOverlay();
    renderSegmentList();
  } catch (err) {
    if (dropZone) {
      dropZone.innerHTML = `
        <div class="slicer-drop-content">
          <div class="slicer-drop-icon">🎵</div>
          <div class="slicer-drop-text">Arrastra un audio aquí o haz clic para subir</div>
          <div class="slicer-drop-hint">.wav, .mp3, .ogg</div>
        </div>
      `;
    }
    console.error('Error decoding audio:', err);
    alert('Error al decodificar el audio: ' + err.message);
  }
}

function clearAudio() {
  stopPlayback();
  audioBuffer = null;
  markers = [];
  zoom = 1;
  scrollX = 0;
  customNames = [];

  const overlay = document.getElementById('audio-slicer-overlay');
  const dropZone = overlay.querySelector('.slicer-drop-zone');
  const workspace = overlay.querySelector('.slicer-workspace');

  if (workspace) workspace.classList.add('hidden');
  if (dropZone) {
    dropZone.classList.remove('hidden');
    dropZone.innerHTML = `
      <div class="slicer-drop-content">
        <div class="slicer-drop-icon">🎵</div>
        <div class="slicer-drop-text">Arrastra un audio aquí o haz clic para subir</div>
        <div class="slicer-drop-hint">.wav, .mp3, .ogg</div>
      </div>
    `;
  }
}

// ─── CANVAS SETUP ────────────────────────────────────
function resizeCanvases() {
  if (!waveCanvas || !overlayCanvas) return;
  const container = waveCanvas.parentElement;
  const rect = container.getBoundingClientRect();
  const w = Math.floor(rect.width);
  const h = Math.floor(rect.height);
  const dpr = window.devicePixelRatio || 1;

  waveCanvas.width = w * dpr;
  waveCanvas.height = h * dpr;
  waveCanvas.style.width = w + 'px';
  waveCanvas.style.height = h + 'px';
  waveCtx.scale(dpr, dpr);

  overlayCanvas.width = w * dpr;
  overlayCanvas.height = h * dpr;
  overlayCanvas.style.width = w + 'px';
  overlayCanvas.style.height = h + 'px';
  overlayCtx.scale(dpr, dpr);
}

// ─── WAVEFORM RENDERING ─────────────────────────────
function renderWaveform() {
  if (!audioBuffer || !waveCtx) return;

  const dpr = window.devicePixelRatio || 1;
  const w = waveCanvas.width / dpr;
  const h = waveCanvas.height / dpr;

  waveCtx.clearRect(0, 0, w, h);

  const channelData = audioBuffer.getChannelData(0);
  const totalSamples = channelData.length;
  const totalWidth = w * zoom;
  const samplesPerPixel = totalSamples / totalWidth;

  // Background
  waveCtx.fillStyle = 'rgba(108, 92, 231, 0.03)';
  waveCtx.fillRect(0, 0, w, h);

  // Center line
  waveCtx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  waveCtx.lineWidth = 1;
  waveCtx.beginPath();
  waveCtx.moveTo(0, h / 2);
  waveCtx.lineTo(w, h / 2);
  waveCtx.stroke();

  // Draw waveform
  const midY = h / 2;
  const amplitude = (h / 2) * 0.85;

  waveCtx.fillStyle = 'rgba(108, 92, 231, 0.6)';

  for (let px = 0; px < w; px++) {
    const startSample = Math.floor((px + scrollX) * samplesPerPixel);
    const endSample = Math.floor((px + scrollX + 1) * samplesPerPixel);

    if (startSample >= totalSamples) break;

    let min = 1, max = -1;
    for (let s = startSample; s < endSample && s < totalSamples; s++) {
      const val = channelData[s];
      if (val < min) min = val;
      if (val > max) max = val;
    }

    const yMin = midY - max * amplitude;
    const yMax = midY - min * amplitude;
    const barH = Math.max(1, yMax - yMin);
    waveCtx.fillRect(px, yMin, 1, barH);
  }

  // Draw a brighter RMS overlay for better visual feedback
  waveCtx.fillStyle = 'rgba(108, 92, 231, 0.85)';
  const rmsBlockSize = Math.max(2, Math.floor(w / 400));

  for (let px = 0; px < w; px += rmsBlockSize) {
    const startSample = Math.floor((px + scrollX) * samplesPerPixel);
    const endSample = Math.floor((px + scrollX + rmsBlockSize) * samplesPerPixel);

    if (startSample >= totalSamples) break;

    let sumSq = 0;
    let count = 0;
    for (let s = startSample; s < endSample && s < totalSamples; s++) {
      sumSq += channelData[s] * channelData[s];
      count++;
    }
    const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;

    const barH = Math.max(1, rms * amplitude * 2);
    waveCtx.fillRect(px, midY - barH / 2, rmsBlockSize, barH);
  }
}

// ─── OVERLAY (markers, cursor, segment colors) ──────
function renderOverlay() {
  if (!audioBuffer || !overlayCtx) return;

  const dpr = window.devicePixelRatio || 1;
  const w = overlayCanvas.width / dpr;
  const h = overlayCanvas.height / dpr;

  overlayCtx.clearRect(0, 0, w, h);

  // Draw segment backgrounds with alternating subtle colors
  const allTimes = [0, ...markers, audioBuffer.duration];
  const segmentColors = [
    'rgba(108, 92, 231, 0.06)',
    'rgba(0, 206, 201, 0.06)',
  ];

  for (let i = 0; i < allTimes.length - 1; i++) {
    const x1 = timeToPixel(allTimes[i], w);
    const x2 = timeToPixel(allTimes[i + 1], w);
    if (x2 > 0 && x1 < w) {
      overlayCtx.fillStyle = segmentColors[i % 2];
      overlayCtx.fillRect(Math.max(0, x1), 0, Math.min(w, x2) - Math.max(0, x1), h);
    }
  }

  // Draw markers
  markers.forEach((time, idx) => {
    const x = timeToPixel(time, w);
    if (x < 0 || x > w) return;

    // Marker line
    overlayCtx.strokeStyle = idx === draggingMarkerIdx ? '#ff6b6b' : '#e17055';
    overlayCtx.lineWidth = idx === draggingMarkerIdx ? 2.5 : 1.5;
    overlayCtx.setLineDash(idx === draggingMarkerIdx ? [] : [4, 3]);
    overlayCtx.beginPath();
    overlayCtx.moveTo(x, 0);
    overlayCtx.lineTo(x, h);
    overlayCtx.stroke();
    overlayCtx.setLineDash([]);

    // Marker handle (triangle at top)
    overlayCtx.fillStyle = idx === draggingMarkerIdx ? '#ff6b6b' : '#e17055';
    overlayCtx.beginPath();
    overlayCtx.moveTo(x - 6, 0);
    overlayCtx.lineTo(x + 6, 0);
    overlayCtx.lineTo(x, 10);
    overlayCtx.closePath();
    overlayCtx.fill();

    // Time label
    overlayCtx.fillStyle = '#fff';
    overlayCtx.font = '10px "JetBrains Mono", monospace';
    overlayCtx.textAlign = 'center';
    overlayCtx.fillText(formatTime(time), x, 22);
  });

  // Draw playback cursor
  if (isPlaying && audioContext) {
    const currentTime = audioContext.currentTime - playStartTime + playStartOffset;
    const x = timeToPixel(currentTime, w);
    if (x >= 0 && x <= w) {
      overlayCtx.strokeStyle = '#00cec9';
      overlayCtx.lineWidth = 2;
      overlayCtx.setLineDash([]);
      overlayCtx.beginPath();
      overlayCtx.moveTo(x, 0);
      overlayCtx.lineTo(x, h);
      overlayCtx.stroke();
    }
  }

  // Draw playhead (Shift+Click position) — cyan/teal dashed line
  if (!isPlaying && playheadTime > 0) {
    const phx = timeToPixel(playheadTime, w);
    if (phx >= 0 && phx <= w) {
      overlayCtx.strokeStyle = '#00cec9';
      overlayCtx.lineWidth = 1.5;
      overlayCtx.setLineDash([6, 4]);
      overlayCtx.beginPath();
      overlayCtx.moveTo(phx, 0);
      overlayCtx.lineTo(phx, h);
      overlayCtx.stroke();
      overlayCtx.setLineDash([]);

      // Playhead handle (triangle at bottom)
      overlayCtx.fillStyle = '#00cec9';
      overlayCtx.beginPath();
      overlayCtx.moveTo(phx - 6, h);
      overlayCtx.lineTo(phx + 6, h);
      overlayCtx.lineTo(phx, h - 10);
      overlayCtx.closePath();
      overlayCtx.fill();

      // Label
      overlayCtx.fillStyle = '#00cec9';
      overlayCtx.font = '10px "JetBrains Mono", monospace';
      overlayCtx.textAlign = 'center';
      overlayCtx.fillText('▶ ' + formatTime(playheadTime), phx, h - 14);
    }
  }

  // Time ruler at bottom
  drawTimeRuler(w, h);
}

function drawTimeRuler(w, h) {
  if (!audioBuffer) return;
  const totalWidth = w * zoom;
  const duration = audioBuffer.duration;

  // Determine step
  const pixelsPerSecond = totalWidth / duration;
  let step = 1;
  if (pixelsPerSecond < 10) step = 10;
  else if (pixelsPerSecond < 30) step = 5;
  else if (pixelsPerSecond < 60) step = 2;
  else if (pixelsPerSecond > 200) step = 0.5;
  else if (pixelsPerSecond > 500) step = 0.1;

  overlayCtx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  overlayCtx.font = '9px "JetBrains Mono", monospace';
  overlayCtx.textAlign = 'center';

  for (let t = 0; t <= duration; t += step) {
    const x = timeToPixel(t, w);
    if (x < 0 || x > w) continue;

    // Tick
    overlayCtx.fillRect(x, h - 12, 1, 6);

    // Label
    overlayCtx.fillText(formatTime(t), x, h - 2);
  }
}

// ─── COORDINATE HELPERS ─────────────────────────────
function timeToPixel(time, canvasWidth) {
  if (!audioBuffer) return 0;
  const totalWidth = canvasWidth * zoom;
  return (time / audioBuffer.duration) * totalWidth - scrollX;
}

function pixelToTime(px, canvasWidth) {
  if (!audioBuffer) return 0;
  const totalWidth = canvasWidth * zoom;
  return ((px + scrollX) / totalWidth) * audioBuffer.duration;
}

// ─── CANVAS INTERACTION ─────────────────────────────
function setupCanvasInteraction(canvas) {
  let canvasWidth = () => canvas.width / (window.devicePixelRatio || 1);

  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const w = canvasWidth();

    // Check if clicking near a marker (within 8px)
    const hitIdx = findMarkerAt(x, w);

    if (e.button === 2) {
      // Right-click: delete marker
      e.preventDefault();
      if (hitIdx >= 0) {
        markers.splice(hitIdx, 1);
        renderOverlay();
        renderSegmentList();
      }
      return;
    }

    if (hitIdx >= 0) {
      // Start dragging existing marker
      draggingMarkerIdx = hitIdx;
      canvas.style.cursor = 'col-resize';
    } else if (e.button === 0 && e.shiftKey) {
      // Shift+Click: set playhead position
      const time = pixelToTime(x, w);
      playheadTime = Math.max(0, Math.min(audioBuffer.duration, time));
      renderOverlay();
    } else if (e.button === 0) {
      // Left click: add new marker
      const time = pixelToTime(x, w);
      if (time > 0 && time < audioBuffer.duration) {
        markers.push(time);
        markers.sort((a, b) => a - b);
        draggingMarkerIdx = markers.indexOf(time);
        renderOverlay();
        renderSegmentList();
        canvas.style.cursor = 'col-resize';
      }
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const w = canvasWidth();

    if (draggingMarkerIdx >= 0) {
      // Dragging a marker
      let newTime = pixelToTime(x, w);
      newTime = Math.max(0.01, Math.min(audioBuffer.duration - 0.01, newTime));

      // Snap to nearby markers (prevent overlapping)
      markers[draggingMarkerIdx] = newTime;
      markers.sort((a, b) => a - b);
      draggingMarkerIdx = markers.indexOf(newTime);

      renderOverlay();
      renderSegmentList();
    } else {
      // Hover cursor feedback
      const hitIdx = findMarkerAt(x, w);
      canvas.style.cursor = hitIdx >= 0 ? 'col-resize' : 'crosshair';
    }
  });

  canvas.addEventListener('mouseup', () => {
    draggingMarkerIdx = -1;
    canvas.style.cursor = 'crosshair';
  });

  canvas.addEventListener('mouseleave', () => {
    if (draggingMarkerIdx >= 0) {
      draggingMarkerIdx = -1;
      canvas.style.cursor = 'crosshair';
    }
  });

  // Prevent context menu on right-click
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Zoom with mouse wheel
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const w = canvasWidth();

    if (e.ctrlKey || e.metaKey) {
      // Ctrl+Wheel = zoom
      const oldZoom = zoom;
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      setZoom(zoom * factor);

      // Adjust scroll to keep mouse position stable
      const timeAtMouse = pixelToTime(mouseX, w);
      scrollX = (timeAtMouse / audioBuffer.duration) * (w * zoom) - mouseX;
      scrollX = Math.max(0, Math.min(scrollX, w * zoom - w));
      renderWaveform();
      renderOverlay();
    } else {
      // Regular wheel = scroll
      scrollX += e.deltaY * 2;
      scrollX = Math.max(0, Math.min(scrollX, w * zoom - w));
      renderWaveform();
      renderOverlay();
    }
  });
}

function findMarkerAt(px, canvasWidth) {
  const threshold = 8;
  for (let i = 0; i < markers.length; i++) {
    const markerPx = timeToPixel(markers[i], canvasWidth);
    if (Math.abs(px - markerPx) < threshold) return i;
  }
  return -1;
}

// ─── ZOOM ────────────────────────────────────────────
function setZoom(newZoom) {
  zoom = Math.max(1, Math.min(100, newZoom));
  if (waveCanvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = waveCanvas.width / dpr;
    scrollX = Math.max(0, Math.min(scrollX, w * zoom - w));
  }
  renderWaveform();
  renderOverlay();
}

// ─── PLAYBACK ────────────────────────────────────────
function togglePlayPause() {
  if (isPlaying) {
    stopPlayback();
  } else {
    playAll();
  }
}

function playAll() {
  if (!audioBuffer) return;
  playSegment(playheadTime, audioBuffer.duration);
}

export function playSegment(startTime, endTime) {
  if (!audioBuffer) return;
  stopPlayback();

  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  sourceNode = audioContext.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(audioContext.destination);

  playStartTime = audioContext.currentTime;
  playStartOffset = startTime;
  playSegmentEnd = endTime;

  sourceNode.start(0, startTime, endTime - startTime);
  sourceNode.onended = () => {
    isPlaying = false;
    updatePlayButton();
    cancelAnimationFrame(animFrameId);
    renderOverlay();
  };

  isPlaying = true;
  updatePlayButton();
  animateCursor();
}

function stopPlayback() {
  if (sourceNode) {
    try { sourceNode.stop(); } catch { /* ignore */ }
    sourceNode = null;
  }
  isPlaying = false;
  updatePlayButton();
  cancelAnimationFrame(animFrameId);
  renderOverlay();
}

function animateCursor() {
  renderOverlay();
  updateTimeDisplay();
  if (isPlaying) {
    animFrameId = requestAnimationFrame(animateCursor);
  }
}

function updatePlayButton() {
  const btn = document.querySelector('#slicer-play');
  if (btn) {
    btn.innerHTML = isPlaying
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
  }
}

function updateTimeDisplay() {
  const display = document.querySelector('#slicer-time-display');
  if (!display || !audioBuffer) return;
  if (isPlaying && audioContext) {
    const current = audioContext.currentTime - playStartTime + playStartOffset;
    display.textContent = `${formatTime(current)} / ${formatTime(audioBuffer.duration)}`;
  } else {
    display.textContent = `00:00 / ${formatTime(audioBuffer.duration)}`;
  }
}

// ─── SEGMENT NAMING ──────────────────────────────────
/**
 * Expands the naming pattern for one segment.
 * Tokens: {file} = audio file name, {num} = 01, {num3} = 001.
 * If the pattern has no numbering token and there are multiple segments,
 * a number is appended automatically to avoid collisions.
 */
function patternName(index, total) {
  const raw = (namePattern || '').trim() || '{file}_{num}';
  const pad2 = String(index + 1).padStart(2, '0');
  const pad3 = String(index + 1).padStart(3, '0');
  let name = raw
    .split('{file}').join(fileName || 'audio')
    .split('{num3}').join(pad3)
    .split('{num}').join(pad2);
  if (total > 1 && !raw.includes('{num')) name += `_${pad2}`;
  return name;
}

/** Manual override if the user typed one; otherwise the pattern-generated name. */
function effectiveName(index, total) {
  const custom = customNames[index];
  return (custom != null && custom.trim() !== '') ? custom.trim() : patternName(index, total);
}

// ─── SEGMENT LIST ────────────────────────────────────
function renderSegmentList() {
  const list = document.querySelector('#slicer-segment-list');
  if (!list || !audioBuffer) return;

  const allTimes = [0, ...markers, audioBuffer.duration];
  const total = allTimes.length - 1;
  const segments = [];

  for (let i = 0; i < total; i++) {
    segments.push({
      index: i,
      start: allTimes[i],
      end: allTimes[i + 1],
      name: effectiveName(i, total),
      isCustom: customNames[i] != null && customNames[i].trim() !== '',
    });
  }

  if (segments.length <= 1 && markers.length === 0) {
    list.innerHTML = '<div class="slicer-empty-segments">Haz clic en la forma de onda para agregar cortes</div>';
    return;
  }

  list.innerHTML = segments.map((seg) => `
    <div class="slicer-segment" data-index="${seg.index}">
      <span class="slicer-seg-num">${seg.index + 1}</span>
      <input class="slicer-seg-name ${seg.isCustom ? 'slicer-seg-custom' : ''}" type="text" value="${esc(seg.name)}" data-index="${seg.index}" spellcheck="false" placeholder="${esc(patternName(seg.index, total))}" title="Nombre del archivo (.wav). Vacío = usa el patrón.">
      <button class="slicer-seg-play" data-start="${seg.start}" data-end="${seg.end}" title="Reproducir segmento">
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      </button>
      <span class="slicer-seg-time">${formatTime(seg.start)} — ${formatTime(seg.end)}</span>
      <span class="slicer-seg-duration">${(seg.end - seg.start).toFixed(1)}s</span>
    </div>
  `).join('');

  // Persist manual edits immediately so re-renders (marker add/move) never lose them
  list.querySelectorAll('.slicer-seg-name').forEach((input) => {
    input.addEventListener('input', () => {
      const idx = parseInt(input.dataset.index);
      const val = input.value;
      // Typing exactly the pattern name (or clearing) removes the override
      customNames[idx] = (val.trim() === '' || val === patternName(idx, total)) ? null : val;
      input.classList.toggle('slicer-seg-custom', customNames[idx] != null);
    });
  });

  // Attach play handlers
  list.querySelectorAll('.slicer-seg-play').forEach((btn) => {
    btn.addEventListener('click', () => {
      const start = parseFloat(btn.dataset.start);
      const end = parseFloat(btn.dataset.end);
      playSegment(start, end);
    });
  });
}

function getSegments() {
  if (!audioBuffer) return [];
  const allTimes = [0, ...markers, audioBuffer.duration];
  const total = allTimes.length - 1;
  const segments = [];
  const used = new Set();

  for (let i = 0; i < total; i++) {
    let name = sanitizeFileName(effectiveName(i, total)) || String(i + 1).padStart(2, '0');
    // Duplicate names would silently overwrite each other in the folder/zip
    while (used.has(name)) name = `${name}_${i + 1}`;
    used.add(name);
    segments.push({ index: i, start: allTimes[i], end: allTimes[i + 1], name });
  }
  return segments;
}

/** Strips characters that are invalid in file names across OSes. */
function sanitizeFileName(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, '_') // illegal on Windows
    .replace(/\s+/g, '_')          // collapse whitespace
    .replace(/_+/g, '_')           // collapse repeated underscores
    .replace(/^[_.]+|[_.]+$/g, ''); // trim leading/trailing _ or .
}

// ─── EXPORT ──────────────────────────────────────────
async function exportZip() {
  if (!audioBuffer || markers.length === 0) {
    alert('Agrega al menos un marcador de corte antes de exportar.');
    return;
  }

  const segments = getSegments();
  const btn = document.querySelector('#slicer-export-zip');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generando...'; }

  try {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();

    for (const seg of segments) {
      const startSample = Math.floor(seg.start * audioBuffer.sampleRate);
      const endSample = Math.floor(seg.end * audioBuffer.sampleRate);
      const wavData = encodeWAV(audioBuffer, startSample, endSample);
      zip.file(`${seg.name}.wav`, wavData);
    }

    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, `${fileName}_segments.zip`);
  } catch (err) {
    console.error('Export error:', err);
    alert('Error al exportar: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📦 Exportar todo (.zip)'; }
  }
}

async function exportIndividual() {
  if (!audioBuffer || markers.length === 0) {
    alert('Agrega al menos un marcador de corte antes de exportar.');
    return;
  }

  const segments = getSegments();
  const btn = document.querySelector('#slicer-export-single');

  // ── Electron path: one folder dialog, write all files directly ──
  if (window.electronAPI?.pickAudioFolder) {
    const folderPath = await window.electronAPI.pickAudioFolder();
    if (!folderPath) return; // user cancelled

    if (btn) { btn.disabled = true; btn.textContent = 'Exportando...'; }
    try {
      const files = [];
      for (const seg of segments) {
        const startSample = Math.floor(seg.start * audioBuffer.sampleRate);
        const endSample = Math.floor(seg.end * audioBuffer.sampleRate);
        const wavData = encodeWAV(audioBuffer, startSample, endSample);
        // Transfer as plain array so it survives IPC serialization
        files.push({ name: `${seg.name}.wav`, data: Array.from(new Uint8Array(wavData)) });
      }
      const written = await window.electronAPI.writeAudioFiles(folderPath, files);
      alert(`${written.length} archivos exportados en:\n${folderPath}`);
    } catch (err) {
      console.error('Export error:', err);
      alert('Error al exportar: ' + err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Exportar individuales'; }
    }
    return;
  }

  // ── Fallback (browser): download one by one ──
  for (const seg of segments) {
    const startSample = Math.floor(seg.start * audioBuffer.sampleRate);
    const endSample = Math.floor(seg.end * audioBuffer.sampleRate);
    const wavData = encodeWAV(audioBuffer, startSample, endSample);
    const blob = new Blob([wavData], { type: 'audio/wav' });
    downloadBlob(blob, `${seg.name}.wav`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ─── UTILITIES ───────────────────────────────────────
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${ms}`;
}
