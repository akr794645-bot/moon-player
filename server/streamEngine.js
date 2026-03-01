const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const ffmpegStatic = require('ffmpeg-static');
const multer = require('multer');

let client;
(async () => {
    const { default: WebTorrent } = await import('webtorrent');
    client = new WebTorrent();
})();

// ─── HLS temp directory (Moved to OS Temp to prevent Nodemon restarts) ───
const HLS_DIR = path.join(os.tmpdir(), 'moon_web_player', 'hls_temp');
if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });

// ─── Local File Session Store ─────────────────────────────────────────────────
// sessionId → { filePath, fileName, fileSize, mimeType, createdAt }
const localFileSessions = new Map();

// Cleanup old sessions every 2 hours (files older than 4 hours)
setInterval(() => {
    const now = Date.now();
    for (const [id, session] of localFileSessions.entries()) {
        if (now - session.createdAt > 4 * 60 * 60 * 1000) {
            try { fs.unlinkSync(session.filePath); } catch (e) { }
            localFileSessions.delete(id);
            console.log(`[LocalStream] Session ${id} expired and cleaned up`);
        }
    }
}, 2 * 60 * 60 * 1000);

// ─── Multer: save uploaded video to OS temp dir ───────────────────────────────
const UPLOAD_DIR = path.join(os.tmpdir(), 'moon_web_player', 'local_uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const sessionId = uuidv4();
        req._sessionId = sessionId;
        // Keep original extension
        const ext = path.extname(file.originalname) || '.mp4';
        cb(null, `${sessionId}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10GB max
    fileFilter: (req, file, cb) => {
        const allowed = /\.(mp4|webm|mkv|avi|mov|ts|m4v|flv|wmv)$/i;
        if (allowed.test(path.extname(file.originalname))) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only video files are allowed.'));
        }
    }
});

// ─── Helper: Get MIME type ────────────────────────────────────────────────────
function getMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const mimes = {
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mkv': 'video/x-matroska',
        '.avi': 'video/x-msvideo',
        '.mov': 'video/quicktime',
        '.ts': 'video/mp2t',
        '.m4v': 'video/mp4',
        '.flv': 'video/x-flv',
        '.wmv': 'video/x-ms-wmv',
    };
    return mimes[ext] || 'video/mp4';
}

// ─── Helper: Google Drive ─────────────────────────────────────────────────────
function getDriveDirectLink(url) {
    const match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
    if (match && match[1]) return `https://drive.google.com/uc?export=download&id=${match[1]}`;
    return url;
}

// ─── FFmpeg Transcoder Queue System ───────────────────────────────────────────
const MAX_CONCURRENT_JOBS = 2;
const JOB_QUEUE = [];
const activeTranscodes = new Map(); // sessionId -> FFmpeg ChildProcess
const transcodeStates = new Map(); // sessionId -> { status, url, error }

function processQueue() {
    if (activeTranscodes.size >= MAX_CONCURRENT_JOBS || JOB_QUEUE.length === 0) return;

    const job = JOB_QUEUE.shift();
    const { sessionId, link, m3u8Path, hlsUrl, sessionDir } = job;

    console.log(`[FFmpeg-Queue] Starting job ${sessionId}. Active: ${activeTranscodes.size + 1}/${MAX_CONCURRENT_JOBS}`);
    transcodeStates.set(sessionId, { status: 'processing', url: null });

    const ffmpegPath = ffmpegStatic || 'ffmpeg';
    const ffmpeg = spawn(ffmpegPath, [
        '-i', link,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
        '-c:a', 'aac', '-b:a', '128k',
        '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0',
        '-hls_segment_filename', path.join(sessionDir, 'segment_%03d.ts'),
        m3u8Path
    ]);

    ffmpeg.stderr.on('data', (data) => {
        // FFmpeg writes its progress and errors to stderr naturally
        // We'll log it if it looks like a severe error to keep consoles clean
        const output = data.toString();
        if (output.toLowerCase().includes('error')) {
            console.error(`[FFmpeg-${sessionId}] ${output.trim()}`);
        }
    });

    activeTranscodes.set(sessionId, ffmpeg);

    // simple readiness check
    let ready = false;
    const checkReady = setInterval(() => {
        if (!ready && fs.existsSync(m3u8Path)) {
            ready = true;
            clearInterval(checkReady);
            const state = transcodeStates.get(sessionId);
            if (state && state.status !== 'error') {
                state.status = 'ready';
                state.url = hlsUrl;
            }
        }
    }, 500);

    ffmpeg.on('close', (code) => {
        clearInterval(checkReady);
        activeTranscodes.delete(sessionId);
        console.log(`[FFmpeg-Queue] Job ${sessionId} closed with code ${code}`);

        const state = transcodeStates.get(sessionId);
        if (state && (!ready || code !== 0)) {
            // Only set error if it wasn't already successfully playing, or if it hard failed
            if (code !== 0 && code !== 255) { // 255 is normal sigkill
                state.status = 'error';
                state.error = `Transcode failed with code ${code}`;
            }
        }
        processQueue(); // trigger next
    });

    ffmpeg.on('error', (err) => {
        clearInterval(checkReady);
        activeTranscodes.delete(sessionId);
        console.error(`[FFmpeg-Queue] Error on ${sessionId}:`, err);

        const state = transcodeStates.get(sessionId);
        if (state) {
            state.status = 'error';
            state.error = err.message;
        }
        processQueue(); // trigger next
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/stream/status/:sessionId — Poll job progress
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const state = transcodeStates.get(sessionId);
    if (!state) return res.status(404).json({ error: 'Session not found' });
    res.json(state);
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/stream — Universal stream engine
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
    try {
        let { link } = req.body;
        if (!link) return res.status(400).json({ error: 'Video link is required' });
        link = link.trim();

        // 1. WebTorrent
        if (link.startsWith('magnet:') || link.endsWith('.torrent')) {
            client.add(link, (torrent) => {
                const file = torrent.files.reduce((a, b) => a.length > b.length ? a : b);
                const streamUrl = `/api/stream/torrent/${torrent.infoHash}/${encodeURIComponent(file.name)}`;
                return res.json({ type: 'torrent', url: streamUrl, message: `Streaming from torrent: ${file.name}` });
            });
            return;
        }

        // 2. Google Drive
        if (link.includes('drive.google.com')) {
            return res.json({ type: 'drive', url: getDriveDirectLink(link) });
        }

        // 3. Native formats
        if (link.includes('.mp4') || link.includes('.webm') || link.includes('.m3u8')) {
            return res.json({ type: 'direct', url: link });
        }

        // 4. Queued FFmpeg Transcode
        const sessionId = uuidv4();
        const sessionDir = path.join(HLS_DIR, sessionId);
        fs.mkdirSync(sessionDir, { recursive: true });

        const m3u8Path = path.join(sessionDir, 'stream.m3u8');
        const hlsUrl = `/hls/${sessionId}/stream.m3u8`;

        // Register job
        transcodeStates.set(sessionId, { status: 'queued', url: null });
        JOB_QUEUE.push({ sessionId, link, m3u8Path, hlsUrl, sessionDir });

        console.log(`[FFmpeg-Queue] Queued ${sessionId} (Queue size: ${JOB_QUEUE.length})`);
        processQueue(); // start processing if slots available

        return res.json({ type: 'queued', sessionId, message: 'Added to processing queue' });

    } catch (err) {
        console.error('Stream Engine Error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/stream/localfile — Host uploads local file to backend
//  Returns sessionId + streamUrl for members to use
// ─────────────────────────────────────────────────────────────────────────────
router.post('/localfile', (req, res) => {
    upload.single('video')(req, res, (err) => {
        if (err) {
            console.error('[LocalStream] Upload error:', err.message);
            return res.status(400).json({ error: err.message });
        }
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const sessionId = path.basename(req.file.filename, path.extname(req.file.filename));
        const session = {
            filePath: req.file.path,
            fileName: req.file.originalname,
            fileSize: req.file.size,
            mimeType: getMimeType(req.file.originalname),
            createdAt: Date.now(),
        };
        localFileSessions.set(sessionId, session);

        console.log(`[LocalStream] Registered session ${sessionId} → ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);

        res.json({
            success: true,
            sessionId,
            streamUrl: `/api/stream/localfile/${sessionId}`,
            fileName: req.file.originalname,
            fileSize: req.file.size,
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/stream/localfile/:sessionId — Stream the local file with range support
// ─────────────────────────────────────────────────────────────────────────────
router.get('/localfile/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = localFileSessions.get(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Stream session not found or expired' });
    }

    if (!fs.existsSync(session.filePath)) {
        localFileSessions.delete(sessionId);
        return res.status(404).json({ error: 'File no longer available' });
    }

    const fileSize = session.fileSize;
    const mimeType = session.mimeType;
    const range = req.headers.range;

    // Fast-verify for frontend test fetch
    if (req.method === 'HEAD') {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': mimeType,
            'Accept-Ranges': 'bytes'
        });
        return res.end();
    }

    if (range) {
        // Partial content (Range request) — needed for video seeking
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': mimeType,
            'Access-Control-Allow-Origin': '*',
        });

        fs.createReadStream(session.filePath, { start, end }).pipe(res);
    } else {
        // Full file
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': mimeType,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
        });
        fs.createReadStream(session.filePath).pipe(res);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE /api/stream/localfile/:sessionId — Host cleanup when done
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/localfile/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = localFileSessions.get(sessionId);

    if (session) {
        try { fs.unlinkSync(session.filePath); } catch (e) { }
        localFileSessions.delete(sessionId);
        console.log(`[LocalStream] Session ${sessionId} manually deleted`);
    }

    res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/stream/torrent/:infoHash/:filename — Stream WebTorrent files
// ─────────────────────────────────────────────────────────────────────────────
router.get('/torrent/:infoHash/:filename', (req, res) => {
    const { infoHash, filename } = req.params;
    const torrent = client.get(infoHash);

    if (!torrent) return res.status(404).send('Torrent not found');

    const file = torrent.files.find(f => f.name === decodeURIComponent(filename));
    if (!file) return res.status(404).send('File not found in torrent');

    const range = req.headers.range;
    if (!range) {
        res.writeHead(200, { 'Content-Length': file.length, 'Content-Type': 'video/mp4' });
        file.createReadStream().pipe(res);
        return;
    }

    const positions = range.replace(/bytes=/, '').split('-');
    const start = parseInt(positions[0], 10);
    const end = positions[1] ? parseInt(positions[1], 10) : file.length - 1;
    const chunksize = end - start + 1;

    res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${file.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
    });

    file.createReadStream({ start, end }).pipe(res);
});

module.exports = { router, HLS_DIR };