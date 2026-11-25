'use strict';

const $ = (selector) => document.querySelector(selector);

const els = {
  form: $('#search-form'),
  input: $('#url'),
  pasteBtn: $('#paste-btn'),
  searchBtn: $('#search-btn'),
  errorBox: $('#error-box'),
  errorText: $('#error-text'),
  loading: $('#loading'),
  result: $('#result'),
  thumb: $('#thumb'),
  duration: $('#duration'),
  title: $('#title'),
  author: $('#author'),
  downloadBtn: $('#download-btn'),
  downloadIcon: $('#download-icon'),
  downloadLabel: $('#download-label')
};

const KEY_STORAGE = 'ondas-access-key';
const DOWNLOAD_ICON = els.downloadIcon.innerHTML;
let currentUrl = '';
let busy = false;

/* ------------------------- Clave de acceso opcional ------------------------- */
function getKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch (_) { return ''; }
}
function saveKey(key) {
  try { localStorage.setItem(KEY_STORAGE, key); } catch (_) { /* nada */ }
}

// fetch que agrega la clave y, si el servidor la pide, la solicita una vez y reintenta.
async function request(path, retry = true) {
  const key = getKey();
  const res = await fetch(path, { headers: key ? { 'x-access-key': key } : {} });

  if (res.status === 401 && retry) {
    const entered = window.prompt('Este servidor está protegido. Escribe tu clave de acceso:');
    if (entered) {
      saveKey(entered.trim());
      return request(path, false);
    }
  }
  return res;
}

async function readError(res) {
  try {
    const data = await res.json();
    return new Error(data.error || 'Ocurrió un error inesperado.');
  } catch (_) {
    return new Error('Ocurrió un error inesperado.');
  }
}

/* ------------------------------- Utilidades UI ------------------------------- */
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function showError(message) {
  els.errorText.textContent = message;
  show(els.errorBox);
}
function clearError() { hide(els.errorBox); }

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function formatMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function looksLikeYouTube(text) {
  return /(?:youtube\.com|youtu\.be)\//i.test(text);
}

function setSearchBusy(isBusy) {
  els.searchBtn.disabled = isBusy;
  els.pasteBtn.disabled = isBusy;
  els.input.disabled = isBusy;
  els.searchBtn.textContent = isBusy ? 'Buscando…' : 'Buscar';
}

/* -------------------------------- Buscar video -------------------------------- */
async function search(rawUrl) {
  const url = rawUrl.trim();
  clearError();
  hide(els.result);

  if (!url) {
    showError('Pega primero el enlace de un video de YouTube.');
    return;
  }
  if (!looksLikeYouTube(url)) {
    showError('Ese enlace no parece ser de YouTube. Revisa que sea youtube.com o youtu.be.');
    return;
  }

  setSearchBusy(true);
  show(els.loading);

  try {
    const res = await request(`/info?url=${encodeURIComponent(url)}`);
    if (!res.ok) throw await readError(res);
    const info = await res.json();

    currentUrl = url;
    renderResult(info);
  } catch (err) {
    showError(err.message || 'No se pudo conectar con el servidor.');
  } finally {
    hide(els.loading);
    setSearchBusy(false);
  }
}

function renderResult(info) {
  els.thumb.src = info.thumbnail;
  els.thumb.alt = `Miniatura de ${info.title}`;
  els.title.textContent = info.title;
  els.author.textContent = info.author;
  els.duration.textContent = formatDuration(info.durationSeconds);
  setDownloadState('idle');
  show(els.result);
  els.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* --------------------------------- Descarga --------------------------------- */
function setDownloadState(state, extra) {
  const btn = els.downloadBtn;
  btn.classList.remove('is-done');
  btn.disabled = state === 'preparing' || state === 'downloading';

  switch (state) {
    case 'preparing':
      els.downloadIcon.innerHTML = '<span class="spinner"></span>';
      els.downloadLabel.textContent = 'Preparando descarga…';
      break;
    case 'downloading':
      els.downloadIcon.innerHTML = '<span class="spinner"></span>';
      els.downloadLabel.textContent = `Descargando… ${formatMB(extra)} MB`;
      break;
    case 'done':
      btn.classList.add('is-done');
      els.downloadIcon.innerHTML = DOWNLOAD_ICON;
      els.downloadLabel.textContent = 'Listo, descargar otra vez';
      break;
    default:
      els.downloadIcon.innerHTML = DOWNLOAD_ICON;
      els.downloadLabel.textContent = 'Descargar MP3';
  }
}

function filenameFromHeader(header) {
  if (!header) return '';
  const utf8 = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) {
    try { return decodeURIComponent(utf8[1]); } catch (_) { /* sigue */ }
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : '';
}

async function download() {
  if (busy || !currentUrl) return;
  busy = true;
  clearError();
  setDownloadState('preparing');

  try {
    const res = await request(`/download?url=${encodeURIComponent(currentUrl)}`);
    if (!res.ok) throw await readError(res);

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      setDownloadState('downloading', received);
    }

    if (received === 0) throw new Error('El servidor no devolvió audio. Intenta de nuevo.');

    const blob = new Blob(chunks, { type: 'audio/mpeg' });
    const name = filenameFromHeader(res.headers.get('Content-Disposition')) || 'audio.mp3';
    const blobUrl = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);

    setDownloadState('done');
  } catch (err) {
    setDownloadState('idle');
    showError(err.message || 'La descarga falló. Intenta de nuevo.');
  } finally {
    busy = false;
  }
}

/* --------------------------------- Eventos --------------------------------- */
els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  search(els.input.value);
});

els.pasteBtn.addEventListener('click', async () => {
  clearError();
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) {
      showError('El portapapeles está vacío. Copia primero el enlace del video.');
      return;
    }
    els.input.value = text;
    if (looksLikeYouTube(text)) search(text);
    else showError('Lo que hay en el portapapeles no parece un enlace de YouTube.');
  } catch (_) {
    showError('No se pudo leer el portapapeles. Pega el enlace manualmente con Ctrl+V.');
    els.input.focus();
  }
});

els.downloadBtn.addEventListener('click', download);
