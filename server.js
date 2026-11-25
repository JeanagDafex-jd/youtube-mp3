'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

// ffmpeg viene incluido en el paquete "ffmpeg-static": no necesitas instalarlo aparte.
ffmpeg.setFfmpegPath(ffmpegPath);

/* ------------------------------------------------------------------ */
/* Configuración (todo opcional, se controla con variables de entorno) */
/* ------------------------------------------------------------------ */
const PORT = process.env.PORT || 3000;
// Si defines ACCESS_KEY, la app pedirá esa clave antes de buscar/descargar.
const ACCESS_KEY = process.env.ACCESS_KEY || '';
// Duración máxima permitida (minutos).
const MAX_DURATION_MIN = Number(process.env.MAX_DURATION_MIN) || 120;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
// Ruta del ejecutable de yt-dlp (por defecto se busca en el PATH).
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
// Cookies opcionales (ayudan con videos con restricción de edad o bloqueos).
let COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || '';
// En la nube es más fácil pegar el contenido del cookies.txt en una variable de entorno.
if (!COOKIES_FILE && process.env.YTDLP_COOKIES_CONTENT) {
  try {
    COOKIES_FILE = path.join(os.tmpdir(), 'yt-cookies.txt');
    fs.writeFileSync(COOKIES_FILE, process.env.YTDLP_COOKIES_CONTENT, { mode: 0o600 });
  } catch (err) {
    console.warn('No se pudo escribir el archivo de cookies:', err.message);
    COOKIES_FILE = '';
  }
}
const COOKIES_BROWSER = process.env.YTDLP_COOKIES_BROWSER || ''; // ej: chrome, firefox

/* ------------------------------------------------------------------ */
/* yt-dlp                                                              */
/* ------------------------------------------------------------------ */
function baseArgs() {
  const args = [
    '--no-playlist',
    '--no-warnings',
    // YouTube ahora exige un motor de JavaScript externo; usamos el mismo Node que corre este servidor.
    '--js-runtimes', `node:${process.execPath}`
  ];
  if (COOKIES_FILE) args.push('--cookies', COOKIES_FILE);
  else if (COOKIES_BROWSER) args.push('--cookies-from-browser', COOKIES_BROWSER);
  return args;
}

function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_PATH, [...baseArgs(), '--dump-single-json', '--skip-download', '--', url]);
    let out = '';
    let err = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('timeout'));
    }, 45000);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `yt-dlp terminó con código ${code}`));
      try {
        resolve(JSON.parse(out));
      } catch (_) {
        reject(new Error('Respuesta inválida de yt-dlp'));
      }
    });
  });
}

function checkYtDlp() {
  const child = spawn(YTDLP_PATH, ['--version']);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('error', () => {
    console.warn('\n⚠  No se encontró yt-dlp. Instálalo (ver instrucciones) o define YTDLP_PATH.\n');
  });
  child.on('close', (code) => {
    if (code === 0) console.log(`yt-dlp ${out.trim()} detectado.`);
  });
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
function isYouTubeUrl(raw) {
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return false;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'youtube-nocookie.com'].includes(host);
  } catch (_) {
    return false;
  }
}

function friendlyError(err) {
  const msg = String((err && err.message) || err || '');

  if (err && err.code === 'ENOENT') {
    return { status: 500, message: 'El servidor no tiene yt-dlp instalado. Revisa las instrucciones de instalación.' };
  }
  if (/private video|private/i.test(msg)) {
    return { status: 403, message: 'Este video es privado y no se puede descargar.' };
  }
  if (/confirm your age|age.restricted|inappropriate/i.test(msg)) {
    return { status: 403, message: 'Este video tiene restricción de edad y requiere cookies de una sesión iniciada.' };
  }
  if (/not a bot|confirm you.re not/i.test(msg)) {
    return { status: 429, message: 'YouTube pide verificar que no eres un bot. Prueba más tarde o configura cookies.' };
  }
  if (/video unavailable|not available|removed|does not exist|terminated|members-only|premiere/i.test(msg)) {
    return { status: 404, message: 'El video no está disponible (eliminado, bloqueado en tu región, de miembros o inexistente).' };
  }
  if (/429|too many requests/i.test(msg)) {
    return { status: 429, message: 'Demasiadas solicitudes a YouTube. Espera un momento e inténtalo otra vez.' };
  }
  if (/javascript runtime|requested format is not available|HTTP Error 403|unable to extract|nsig|signature/i.test(msg)) {
    return {
      status: 502,
      message: 'YouTube cambió algo. Actualiza yt-dlp con: yt-dlp -U (y revisa que Node sea versión 20 o mayor).'
    };
  }
  if (/timeout/i.test(msg)) {
    return { status: 504, message: 'YouTube tardó demasiado en responder. Intenta de nuevo.' };
  }
  return { status: 500, message: 'No se pudo procesar el video. Intenta con otro enlace.' };
}

function sendError(res, err) {
  const { status, message } = friendlyError(err);
  console.error(`[error ${status}]`, String((err && err.message) || err).split('\n').slice(-3).join(' | '));
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.removeHeader('Content-Disposition');
  res.status(status).json({ error: message });
}

function sanitizeFilename(name) {
  const clean = String(name || 'audio')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return clean || 'audio';
}

function contentDisposition(title) {
  const base = sanitizeFilename(title);
  const ascii = base.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  const utf8 = encodeURIComponent(base).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}.mp3"; filename*=UTF-8''${utf8}.mp3`;
}

function pickThumbnail(info) {
  if (info.thumbnail) return info.thumbnail;
  const list = Array.isArray(info.thumbnails) ? info.thumbnails : [];
  const withSize = list.filter((t) => t.url && t.width && t.height);
  if (withSize.length) {
    return withSize.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b)).url;
  }
  return info.id ? `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg` : '';
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */
const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: CORS_ORIGIN, exposedHeaders: ['Content-Disposition'] }));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  if (!ACCESS_KEY) return next();
  const key = req.get('x-access-key') || req.query.key;
  if (key === ACCESS_KEY) return next();
  res.status(401).json({ error: 'Falta la clave de acceso o es incorrecta.', code: 'AUTH' });
}

app.get('/health', (_req, res) => res.json({ ok: true }));

/* ---------------------------- GET /info ---------------------------- */
app.get('/info', auth, async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!isYouTubeUrl(url)) {
    return res.status(400).json({ error: 'El enlace no es un enlace válido de YouTube.' });
  }

  try {
    const info = await getVideoInfo(url);
    res.json({
      id: info.id,
      title: info.title,
      author: info.channel || info.uploader || 'Desconocido',
      thumbnail: pickThumbnail(info),
      durationSeconds: Number(info.duration) || 0,
      isLive: Boolean(info.is_live)
    });
  } catch (err) {
    sendError(res, err);
  }
});

/* -------------------------- GET /download -------------------------- */
app.get('/download', auth, async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!isYouTubeUrl(url)) {
    return res.status(400).json({ error: 'El enlace no es un enlace válido de YouTube.' });
  }

  let info;
  try {
    info = await getVideoInfo(url);
  } catch (err) {
    return sendError(res, err);
  }

  const seconds = Number(info.duration) || 0;
  if (info.is_live || seconds === 0) {
    return res.status(400).json({ error: 'No se pueden descargar transmisiones en vivo.' });
  }
  if (seconds > MAX_DURATION_MIN * 60) {
    return res.status(413).json({ error: `El video supera el máximo permitido (${MAX_DURATION_MIN} minutos).` });
  }

  let finished = false;
  let ytdlp;
  let command;
  let ytErr = '';

  const cleanup = () => {
    finished = true;
    try { if (ytdlp) ytdlp.kill('SIGKILL'); } catch (_) { /* nada */ }
    try { if (command) command.kill('SIGKILL'); } catch (_) { /* nada */ }
  };

  const fail = (err) => {
    if (finished) return;
    cleanup();
    sendError(res, err);
  };

  try {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', contentDisposition(info.title));
    res.setHeader('Cache-Control', 'no-store');

    // yt-dlp baja el mejor audio y lo manda por stdout; ffmpeg lo convierte a MP3 al vuelo.
    ytdlp = spawn(YTDLP_PATH, [
      ...baseArgs(),
      '-f', 'bestaudio[ext=webm]/bestaudio/best',
      '-o', '-',
      '--quiet',
      '--no-progress',
      '--',
      url
    ]);

    ytdlp.stderr.on('data', (d) => { ytErr += d; });
    ytdlp.stdout.on('error', () => { /* se cerró el pipe: ya lo manejamos */ });
    ytdlp.on('error', fail);
    ytdlp.on('close', (code) => {
      if (!finished && code !== 0 && code !== null) {
        fail(new Error(ytErr.trim() || `yt-dlp terminó con código ${code}`));
      }
    });

    command = ffmpeg(ytdlp.stdout)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate(192)
      .format('mp3')
      .outputOptions([
        '-id3v2_version', '3',
        '-metadata', `title=${info.title || ''}`,
        '-metadata', `artist=${info.channel || info.uploader || ''}`
      ])
      .on('error', (err) => fail(new Error(ytErr.trim() || err.message)))
      .on('end', () => { finished = true; });

    // Si el usuario cierra la pestaña o cancela, detenemos todo.
    res.on('close', () => { if (!finished) cleanup(); });

    command.pipe(res, { end: true });
  } catch (err) {
    fail(err);
  }
});

/* ---------------------- Errores y rutas no encontradas ---------------------- */
app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => sendError(res, err));

process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

app.listen(PORT, () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
  if (ACCESS_KEY) console.log('Protegido con ACCESS_KEY.');
  checkYtDlp();
});