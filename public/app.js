'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  appShell: $('appShell'), addressForm: $('addressForm'), addressInput: $('addressInput'), heroForm: $('heroForm'), heroInput: $('heroInput'),
  homePanel: $('homePanel'), remoteWrap: $('remoteWrap'), canvas: $('screenCanvas'), loadingOverlay: $('loadingOverlay'), loadingText: $('loadingText'),
  errorOverlay: $('errorOverlay'), errorTitle: $('errorTitle'), errorText: $('errorText'), proxyStatus: $('proxyStatus'), securityDot: $('securityDot'),
  backBtn: $('backBtn'), forwardBtn: $('forwardBtn'), reloadBtn: $('reloadBtn'), identityBtn: $('identityBtn'), keyboardBtn: $('keyboardBtn'), fullscreenBtn: $('fullscreenBtn'),
  retryBtn: $('retryBtn'), newIdentityErrorBtn: $('newIdentityErrorBtn'), homeBtn: $('homeBtn'), typingDock: $('typingDock'), typingInput: $('typingInput'),
  sendTextBtn: $('sendTextBtn'), backspaceBtn: $('backspaceBtn'), enterKeyBtn: $('enterKeyBtn'), closeTypingBtn: $('closeTypingBtn'), menuBtn: $('menuBtn'),
  menuPopover: $('menuPopover'), menuHome: $('menuHome'), menuEnd: $('menuEnd'), toast: $('toast'),
  fileDialog: $('fileDialog'), fileDialogText: $('fileDialogText'), chooseFileBtn: $('chooseFileBtn'), cancelFileBtn: $('cancelFileBtn'), localFileInput: $('localFileInput'),
  uploadProgressWrap: $('uploadProgressWrap'), uploadProgressBar: $('uploadProgressBar'), uploadStatus: $('uploadStatus'),
  downloadShelf: $('downloadShelf'), downloadName: $('downloadName'), downloadStatus: $('downloadStatus'), saveDownloadBtn: $('saveDownloadBtn'), closeDownloadBtn: $('closeDownloadBtn')
};

const ctx = els.canvas.getContext('2d', { alpha: false, desynchronized: true });
ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = 'high';
const state = {
  ws: null,
  ready: false,
  connecting: null,
  intentionalClose: false,
  lastUrl: '',
  resizingTimer: null,
  pointerDown: null,
  imageBitmap: null,
  remoteViewport: { width: 320, height: 360 },
  pendingFileRequest: null,
  uploadBusy: false,
  downloads: new Map(),
  currentDownloadId: null
};

function viewportSize() {
  const rect = els.remoteWrap.getBoundingClientRect();
  return {
    width: Math.max(320, Math.round(rect.width || innerWidth)),
    height: Math.max(360, Math.round(rect.height || (innerHeight - 64)))
  };
}

function show(el, yes = true) { el.classList.toggle('hidden', !yes); }
function showLoading(text) { els.loadingText.textContent = text; show(els.loadingOverlay, true); show(els.errorOverlay, false); }
function hideLoading() { show(els.loadingOverlay, false); }
function showError(message, code = '') {
  hideLoading();
  els.errorTitle.textContent = code === 'BLOCKED_ADDRESS' ? 'Address blocked' : code === 'SESSION_EXPIRED' ? 'Session expired' : code === 'CONNECTION_LOST' ? 'Session disconnected' : 'Could not open page';
  els.errorText.textContent = message || 'The website could not be opened.';
  show(els.errorOverlay, true);
}
function toast(text) {
  els.toast.textContent = text;
  show(els.toast, true);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => show(els.toast, false), 2200);
}
function setProxy(proxy) {
  els.proxyStatus.textContent = proxy?.label || 'Direct';
  els.proxyStatus.classList.toggle('connected', Boolean(proxy?.connected));
}

function socketUrl() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/api/browser`;
}

function resetSocketState() {
  state.ready = false;
  state.connecting = null;
  state.ws = null;
}

function ensureSession() {
  if (state.ready && state.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
  if (state.connecting) return state.connecting;

  showLoading('Opening secure browser session…');
  state.intentionalClose = false;

  state.connecting = new Promise((resolve, reject) => {
    const ws = new WebSocket(socketUrl());
    ws.binaryType = 'blob';
    state.ws = ws;

    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      resetSocketState();
      reject(new Error('The remote browser service did not respond in time.'));
    }, 15_000);

    ws.onopen = () => {
      const size = viewportSize();
      ws.send(JSON.stringify({ type: 'init', ...size, dpr: Math.min(2, Math.max(1, Number(window.devicePixelRatio) || 1)) }));
    };

    ws.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }

        if (message.type === 'ready') {
          clearTimeout(timeout);
          state.ready = true;
          state.connecting = null;
          setProxy(message.proxy);
          show(els.remoteWrap, true);
          show(els.homePanel, false);
          sendResize();
          resolve();
        }
        handleServerMessage(message);
        return;
      }

      try {
        const bitmap = await createImageBitmap(event.data);
        if (state.imageBitmap) state.imageBitmap.close?.();
        state.imageBitmap = bitmap;
        if (els.canvas.width !== bitmap.width || els.canvas.height !== bitmap.height) {
          els.canvas.width = bitmap.width;
          els.canvas.height = bitmap.height;
        }
        ctx.drawImage(bitmap, 0, 0, els.canvas.width, els.canvas.height);
        hideLoading();
      } catch {}
    };

    ws.onerror = () => {};
    ws.onclose = () => {
      clearTimeout(timeout);
      const wasReady = state.ready;
      resetSocketState();
      if (!state.intentionalClose) {
        const message = wasReady
          ? 'The temporary browser connection ended. Retry to create a fresh session.'
          : 'Could not connect to the remote browser service.';
        showError(message, wasReady ? 'CONNECTION_LOST' : 'WEBSITE_UNREACHABLE');
        reject(new Error(message));
      }
      state.intentionalClose = false;
    };
  });

  return state.connecting;
}

function handleServerMessage(message) {
  if (message.type === 'state') {
    if (message.url && message.url !== 'about:blank') {
      state.lastUrl = message.url;
      els.addressInput.value = message.url;
      els.securityDot.classList.add('live');
    }
    setProxy(message.proxy);
    if (message.viewport?.width && message.viewport?.height) state.remoteViewport = message.viewport;
  } else if (message.type === 'title' && message.title) {
    document.title = `${message.title} — Private Browser`;
  } else if (message.type === 'loading' || message.type === 'identity') {
    showLoading(message.message || 'Loading…');
  } else if (message.type === 'error') {
    const uploadCodes = new Set(['NO_FILE_CHOOSER', 'BAD_UPLOAD', 'BAD_UPLOAD_CHUNK', 'NO_UPLOAD', 'UPLOAD_TOO_LARGE', 'INCOMPLETE_UPLOAD']);
    if (uploadCodes.has(message.code)) {
      state.uploadBusy = false;
      els.chooseFileBtn.disabled = false;
      els.cancelFileBtn.disabled = false;
      els.uploadStatus.textContent = message.message || 'The file could not be attached.';
      show(els.fileDialog, true);
    } else {
      showError(message.message, message.code);
    }
  } else if (message.type === 'expired') {
    state.intentionalClose = true;
    resetSocketState();
    showError(message.message || 'The browser session expired.', 'SESSION_EXPIRED');
  } else if (message.type === 'fileChooser') {
    openFileDialog(message);
  } else if (message.type === 'uploadReady') {
    els.uploadStatus.textContent = 'Uploading securely to the remote website…';
  } else if (message.type === 'uploadComplete') {
    state.uploadBusy = false;
    show(els.fileDialog, false);
    resetUploadUi();
    toast(message.files === 1 ? 'File attached to website.' : `${message.files} files attached to website.`);
  } else if (message.type === 'uploadCancelled') {
    state.uploadBusy = false;
    show(els.fileDialog, false);
    resetUploadUi();
  } else if (message.type === 'downloadBegin') {
    beginDownload(message);
  } else if (message.type === 'downloadChunk') {
    appendDownloadChunk(message);
  } else if (message.type === 'downloadEnd') {
    finishDownload(message);
  } else if (message.type === 'downloadError') {
    failDownload(message);
  }
}

function send(payload) {
  if (state.ws?.readyState === WebSocket.OPEN && state.ready) {
    state.ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

async function navigate(raw) {
  const url = String(raw || '').trim();
  if (!url) return;
  state.lastUrl = url;
  show(els.remoteWrap, true);
  show(els.homePanel, false);
  showLoading('Connecting…');
  try {
    await ensureSession();
    showLoading('Loading website…');
    send({ type: 'navigate', url });
  } catch (error) {
    showError(error.message, 'CONNECTION_LOST');
  }
}

async function browserAction(action) {
  if (!state.ready) return;
  if (action === 'newIdentity') showLoading('Creating new private session…');
  send({ type: 'browser', action });
}

function canvasPoint(event) {
  const rect = els.canvas.getBoundingClientRect();
  const remoteWidth = state.remoteViewport?.width || rect.width;
  const remoteHeight = state.remoteViewport?.height || rect.height;
  const scaleX = remoteWidth / rect.width;
  const scaleY = remoteHeight / rect.height;
  return {
    x: Math.max(0, Math.min(remoteWidth, (event.clientX - rect.left) * scaleX)),
    y: Math.max(0, Math.min(remoteHeight, (event.clientY - rect.top) * scaleY))
  };
}

els.canvas.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  els.remoteWrap.focus({ preventScroll: true });
  els.canvas.setPointerCapture?.(event.pointerId);
  const p = canvasPoint(event);
  state.pointerDown = { ...p, clientX: event.clientX, clientY: event.clientY, time: performance.now() };
});

els.canvas.addEventListener('pointerup', (event) => {
  event.preventDefault();
  const p = canvasPoint(event);
  const down = state.pointerDown;
  state.pointerDown = null;
  if (!down) return;
  const moved = Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY);
  if (moved < 12 && performance.now() - down.time < 700) send({ type: 'input', action: 'click', x: p.x, y: p.y });
});

els.canvas.addEventListener('pointermove', (event) => {
  if (!state.pointerDown || event.pointerType === 'touch') return;
  const p = canvasPoint(event);
  send({ type: 'input', action: 'move', x: p.x, y: p.y });
});

let lastTouchY = null;
els.canvas.addEventListener('touchstart', (event) => { lastTouchY = event.touches[0]?.clientY ?? null; }, { passive: true });
els.canvas.addEventListener('touchmove', (event) => {
  const y = event.touches[0]?.clientY;
  if (lastTouchY != null && y != null) send({ type: 'input', action: 'wheel', deltaX: 0, deltaY: (lastTouchY - y) * 2.2 });
  lastTouchY = y;
}, { passive: true });
els.canvas.addEventListener('touchend', () => { lastTouchY = null; }, { passive: true });
els.canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  send({ type: 'input', action: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY });
}, { passive: false });

els.remoteWrap.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.length === 1) send({ type: 'input', action: 'text', text: event.key });
  else if (['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Delete'].includes(event.key)) {
    send({ type: 'input', action: 'key', key: event.key });
  }
  event.preventDefault();
});

function sendResize() {
  if (!state.ready) return;
  const size = viewportSize();
  send({ type: 'input', action: 'resize', ...size });
}

window.addEventListener('resize', () => {
  clearTimeout(state.resizingTimer);
  state.resizingTimer = setTimeout(sendResize, 180);
});

els.addressForm.addEventListener('submit', (event) => { event.preventDefault(); navigate(els.addressInput.value); });
els.heroForm.addEventListener('submit', (event) => { event.preventDefault(); els.addressInput.value = els.heroInput.value; navigate(els.heroInput.value); });
els.backBtn.addEventListener('click', () => browserAction('back'));
els.forwardBtn.addEventListener('click', () => browserAction('forward'));
els.reloadBtn.addEventListener('click', () => browserAction('reload'));
els.identityBtn.addEventListener('click', () => browserAction('newIdentity'));
els.newIdentityErrorBtn.addEventListener('click', async () => {
  if (state.ready) browserAction('newIdentity');
  else if (state.lastUrl) navigate(state.lastUrl);
});
els.retryBtn.addEventListener('click', () => navigate(state.lastUrl || els.addressInput.value));
els.homeBtn.addEventListener('click', () => goHome(false));
els.menuHome.addEventListener('click', () => goHome(false));
els.keyboardBtn.addEventListener('click', () => { show(els.typingDock, true); els.typingInput.focus(); });
els.closeTypingBtn.addEventListener('click', () => show(els.typingDock, false));
els.sendTextBtn.addEventListener('click', () => {
  if (els.typingInput.value) send({ type: 'input', action: 'text', text: els.typingInput.value });
  els.typingInput.value = '';
  els.typingInput.focus();
});
els.backspaceBtn.addEventListener('click', () => send({ type: 'input', action: 'key', key: 'Backspace' }));
els.enterKeyBtn.addEventListener('click', () => send({ type: 'input', action: 'key', key: 'Enter' }));
els.typingInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); els.sendTextBtn.click(); } });
els.fullscreenBtn.addEventListener('click', async () => {
  try {
    if (!document.fullscreenElement) await els.appShell.requestFullscreen();
    else await document.exitFullscreen();
  } catch { toast('Fullscreen is not available in this browser.'); }
});
els.menuBtn.addEventListener('click', () => show(els.menuPopover, els.menuPopover.classList.contains('hidden')));
els.menuEnd.addEventListener('click', () => endSession());

document.addEventListener('click', (event) => {
  if (!els.menuPopover.contains(event.target) && event.target !== els.menuBtn) show(els.menuPopover, false);
});

function endSession() {
  if (state.ws?.readyState === WebSocket.OPEN && state.ready) {
    try { state.ws.send(JSON.stringify({ type: 'end' })); } catch {}
  }
  state.intentionalClose = true;
  if (state.ws) try { state.ws.close(1000, 'user-ended'); } catch {}
  resetSocketState();
  state.lastUrl = '';
  goHome(true);
  toast('Temporary session cleared.');
}

function goHome(clearAddress) {
  show(els.menuPopover, false);
  show(els.remoteWrap, false);
  show(els.errorOverlay, false);
  show(els.loadingOverlay, false);
  show(els.homePanel, true);
  show(els.typingDock, false);
  if (clearAddress) {
    els.addressInput.value = '';
    els.heroInput.value = '';
    els.securityDot.classList.remove('live');
  }
  document.title = 'Private Browser';
}

window.addEventListener('pagehide', () => {
  state.intentionalClose = true;
  if (state.ws?.readyState === WebSocket.OPEN) {
    try { state.ws.send(JSON.stringify({ type: 'end' })); } catch {}
    try { state.ws.close(1000, 'page-hidden'); } catch {}
  }
});


function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function resetUploadUi() {
  state.pendingFileRequest = null;
  els.localFileInput.value = '';
  els.uploadProgressBar.style.width = '0%';
  els.uploadStatus.textContent = '';
  show(els.uploadProgressWrap, false);
  els.chooseFileBtn.disabled = false;
  els.cancelFileBtn.disabled = false;
}

function openFileDialog(message) {
  state.pendingFileRequest = message;
  state.uploadBusy = false;
  els.fileDialogText.textContent = message.multiple
    ? 'The remote website is asking you to select one or more files from this device.'
    : 'The remote website is asking you to select a file from this device.';
  els.localFileInput.accept = message.accept || '';
  els.localFileInput.multiple = Boolean(message.multiple);
  resetUploadUi();
  state.pendingFileRequest = message;
  show(els.fileDialog, true);
}

function blobChunkToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read the selected file.'));
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

async function waitForSocketCapacity() {
  const started = performance.now();
  while (state.ws?.readyState === WebSocket.OPEN && state.ws.bufferedAmount > 2_000_000) {
    if (performance.now() - started > 6000) throw new Error('The upload connection is too slow.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function uploadSelectedFiles(fileList) {
  if (state.uploadBusy) return;
  const files = [...fileList];
  if (!files.length) {
    send({ type: 'uploadCancel' });
    show(els.fileDialog, false);
    resetUploadUi();
    return;
  }

  const total = files.reduce((sum, file) => sum + file.size, 0);
  const maxBytes = 25 * 1024 * 1024;
  if (total > maxBytes) {
    els.uploadStatus.textContent = `Selected files are larger than the ${formatBytes(maxBytes)} transfer limit.`;
    return;
  }

  state.uploadBusy = true;
  els.chooseFileBtn.disabled = true;
  els.cancelFileBtn.disabled = true;
  show(els.uploadProgressWrap, true);
  els.uploadStatus.textContent = 'Preparing upload…';

  try {
    send({
      type: 'uploadStart',
      files: files.map((file) => ({ name: file.name, type: file.type || 'application/octet-stream', size: file.size }))
    });

    const chunkSize = 96 * 1024;
    let sentBytes = 0;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      for (let offset = 0; offset < file.size; offset += chunkSize) {
        const blob = file.slice(offset, Math.min(file.size, offset + chunkSize));
        const data = await blobChunkToBase64(blob);
        await waitForSocketCapacity();
        if (!send({ type: 'uploadChunk', index, data })) throw new Error('The browser session disconnected during upload.');
        sentBytes += blob.size;
        const percent = total ? Math.min(100, Math.round((sentBytes / total) * 100)) : 100;
        els.uploadProgressBar.style.width = `${percent}%`;
        els.uploadStatus.textContent = `Uploading ${percent}% • ${formatBytes(sentBytes)} of ${formatBytes(total)}`;
      }
    }
    send({ type: 'uploadEnd' });
    els.uploadStatus.textContent = 'Attaching file to the website…';
  } catch (error) {
    state.uploadBusy = false;
    els.chooseFileBtn.disabled = false;
    els.cancelFileBtn.disabled = false;
    els.uploadStatus.textContent = error.message || 'Upload failed.';
    send({ type: 'uploadCancel' });
  }
}

function decodeBase64Chunk(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function beginDownload(message) {
  const transfer = { id: message.id, filename: message.filename || 'download', chunks: [], bytes: 0, ready: false };
  state.downloads.set(message.id, transfer);
  state.currentDownloadId = message.id;
  els.downloadName.textContent = transfer.filename;
  els.downloadStatus.textContent = 'Receiving file from remote website…';
  els.saveDownloadBtn.disabled = true;
  show(els.downloadShelf, true);
}

function appendDownloadChunk(message) {
  const transfer = state.downloads.get(message.id);
  if (!transfer || typeof message.data !== 'string') return;
  try {
    const chunk = decodeBase64Chunk(message.data);
    transfer.chunks.push(chunk);
    transfer.bytes += chunk.byteLength;
    if (state.currentDownloadId === message.id) els.downloadStatus.textContent = `Receiving… ${formatBytes(transfer.bytes)}`;
  } catch {
    failDownload({ id: message.id, message: 'Could not decode the downloaded file.' });
  }
}

function finishDownload(message) {
  const transfer = state.downloads.get(message.id);
  if (!transfer) return;
  transfer.ready = true;
  transfer.filename = message.filename || transfer.filename;
  transfer.bytes = Number(message.bytes) || transfer.bytes;
  state.currentDownloadId = message.id;
  els.downloadName.textContent = transfer.filename;
  els.downloadStatus.textContent = `Ready to save • ${formatBytes(transfer.bytes)}`;
  els.saveDownloadBtn.disabled = false;
  show(els.downloadShelf, true);
}

function failDownload(message) {
  if (message.id) state.downloads.delete(message.id);
  els.downloadName.textContent = 'Download failed';
  els.downloadStatus.textContent = message.message || 'The file could not be downloaded.';
  els.saveDownloadBtn.disabled = true;
  show(els.downloadShelf, true);
}

els.chooseFileBtn.addEventListener('click', () => {
  els.localFileInput.value = '';
  els.localFileInput.click();
});
els.cancelFileBtn.addEventListener('click', () => {
  if (!state.uploadBusy) send({ type: 'uploadCancel' });
  show(els.fileDialog, false);
  resetUploadUi();
});
els.localFileInput.addEventListener('change', () => uploadSelectedFiles(els.localFileInput.files));
els.saveDownloadBtn.addEventListener('click', () => {
  const transfer = state.downloads.get(state.currentDownloadId);
  if (!transfer?.ready) return;
  const blob = new Blob(transfer.chunks, { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = transfer.filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  state.downloads.delete(transfer.id);
  state.currentDownloadId = null;
  show(els.downloadShelf, false);
  toast('Download sent to your device.');
});
els.closeDownloadBtn.addEventListener('click', () => {
  if (state.currentDownloadId) state.downloads.delete(state.currentDownloadId);
  state.currentDownloadId = null;
  show(els.downloadShelf, false);
});
