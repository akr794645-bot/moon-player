const express = require('express');
const cors = require('cors');
const axios = require('axios');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const play = require('play-dl');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Lavalink Config ──────────────────────────────────────────────────────────
const LAVALINK = {
    host: 'darli.hidencloud.com',
    port: 24670,
    password: 'zenkaiop',
    secure: false,
};

// ─── FIX 1: CORS updated + JSON parser multipart skip karo ───────────────────
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Range'],
    exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
}));

// express.json() ko multipart/form-data pe skip karo (multer handle karega)
app.use((req, res, next) => {
    const ct = req.headers['content-type'] || '';
    if (ct.includes('multipart/form-data')) return next();
    express.json({ limit: '50mb' })(req, res, next);
});

// ─── Stream Engine Integration ──────────────────────────────────────────────
const streamEngine = require('./streamEngine');
app.use('/api/stream', streamEngine.router);
app.use('/hls', express.static(streamEngine.HLS_DIR));

const getLavalinkUrl = (path) => {
    const protocol = LAVALINK.secure ? 'https' : 'http';
    return `${protocol}://${LAVALINK.host}:${LAVALINK.port}${path}`;
};

// ─── Sources ──────────────────────────────────────────────────────────────────
const SOURCES = {
    youtube: { prefix: 'ytsearch', label: 'YouTube' },
    youtubemusic: { prefix: 'ytmsearch', label: 'YouTube Music' },
    soundcloud: { prefix: 'scsearch', label: 'SoundCloud' },
    spotify: { prefix: 'spsearch', label: 'Spotify' },
    applemusic: { prefix: 'amsearch', label: 'Apple Music' },
    deezer: { prefix: 'dzsearch', label: 'Deezer' },
    yandex: { prefix: 'ymsearch', label: 'Yandex Music' },
    jiosaavn: { prefix: 'jssearch', label: 'JioSaavn' },
    tidal: { prefix: 'tdsearch', label: 'Tidal' },
    vkmusic: { prefix: 'vksearch', label: 'VK Music' },
};

const FALLBACK_ORDER = [
    'youtube', 'youtubemusic', 'soundcloud',
    'spotify', 'deezer', 'applemusic',
    'jiosaavn', 'yandex', 'tidal', 'vkmusic',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectUrlSource(url) {
    if (/spotify\.com/i.test(url)) return 'spotify';
    if (/music\.apple\.com/i.test(url)) return 'applemusic';
    if (/deezer\.com/i.test(url)) return 'deezer';
    if (/youtu\.?be/i.test(url)) return 'youtube';
    if (/soundcloud\.com/i.test(url)) return 'soundcloud';
    if (/tidal\.com/i.test(url)) return 'tidal';
    if (/music\.yandex/i.test(url)) return 'yandex';
    if (/vk\.com/i.test(url)) return 'vkmusic';
    if (/jiosaavn\.com/i.test(url)) return 'jiosaavn';
    return null;
}

async function loadTracks(identifier) {
    const response = await axios.get(getLavalinkUrl('/v4/loadtracks'), {
        params: { identifier },
        headers: { Authorization: LAVALINK.password },
        timeout: 8000,
    });
    return response.data;
}

function extractTracks(data) {
    if (!data) return [];
    if (data.loadType === 'track') return [data.data];
    if (data.loadType === 'search') return data.data || [];
    if (data.loadType === 'playlist') return data.data?.tracks || [];
    return [];
}

async function searchWithFallback(query, preferredSource) {
    const chain = [preferredSource, ...FALLBACK_ORDER.filter(s => s !== preferredSource)];
    const tried = [], skipped = [];

    for (const sourceKey of chain) {
        const source = SOURCES[sourceKey];
        if (!source) continue;
        tried.push(source.label);

        try {
            console.log(`[Search] Trying ${source.label}...`);
            const data = await loadTracks(`${source.prefix}:${query}`);
            const tracks = extractTracks(data);

            if (tracks.length > 0) {
                console.log(`[Search] SUCCESS on ${source.label} — ${tracks.length} tracks`);
                return {
                    success: true, tracks,
                    source: sourceKey, sourceLabel: source.label,
                    loadType: data.loadType,
                    playlistInfo: data.loadType === 'playlist' ? data.data?.info : null,
                    triedSources: tried, skippedSources: skipped,
                    fallback: sourceKey !== preferredSource,
                };
            }
            console.log(`[Search] No results on ${source.label}`);
            skipped.push(source.label);
        } catch (err) {
            let reason = err.message;
            if (err.response?.status === 400) reason = 'plugin not installed';
            else if (err.code === 'ECONNABORTED') reason = 'timeout';
            console.log(`[Search] SKIP ${source.label} — ${reason}`);
            skipped.push(`${source.label} (${reason})`);
        }
    }

    return { success: false, message: 'No tracks found on any available source', triedSources: tried, skippedSources: skipped };
}

// ─── Search Route ─────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q;
        const preferredSource = req.query.source || 'youtubemusic';
        if (!query) return res.status(400).json({ error: 'Search query is required' });

        if (query.startsWith('http://') || query.startsWith('https://')) {
            const detectedSource = detectUrlSource(query);
            try {
                const data = await loadTracks(query);
                const tracks = extractTracks(data);
                if (tracks.length > 0) {
                    return res.json({ success: true, tracks, source: detectedSource || 'direct', loadType: data.loadType, playlistInfo: data.loadType === 'playlist' ? data.data?.info : null });
                }
            } catch (err) { console.error('[Search] Direct URL failed:', err.message); }
            return res.json({ success: false, message: 'Could not load this URL.' });
        }

        return res.json(await searchWithFallback(query, preferredSource));
    } catch (error) {
        console.error('[Search API Error]', error.message);
        res.status(500).json({ success: false, error: 'Failed to search across platforms' });
    }
});

// ─── Play-dl Audio Fallback API ───────────────────────────────────────────────
let soundCloudClientId = null;

app.get('/api/stream/fallback', async (req, res) => {
    try {
        const query = req.query.query;
        if (!query) return res.status(400).send('Missing query');

        console.log(`[Fallback API] Searching for alternative stream: ${query}`);

        if (!soundCloudClientId) {
            try {
                soundCloudClientId = await play.getFreeClientID();
                play.setToken({ soundcloud: { client_id: soundCloudClientId } });
            } catch (e) {
                console.warn('[Fallback API] Failed to fetch SoundCloud Client ID:', e.message);
            }
        }

        const searchResults = await play.search(query, {
            limit: 1,
            source: { soundcloud: "tracks" }
        });

        if (!searchResults || searchResults.length === 0) {
            return res.status(404).send('No alternative stream found');
        }

        const streamInfo = await play.stream(searchResults[0].url);

        res.set((streamInfo.type === 'opus' ? {
            'Content-Type': 'audio/ogg; codecs=opus',
            'Transfer-Encoding': 'chunked'
        } : {
            'Content-Type': 'audio/mpeg',
            'Transfer-Encoding': 'chunked'
        }));

        streamInfo.stream.pipe(res);

    } catch (error) {
        console.error('[Fallback API Error]', error.message);
        res.status(500).send('Error streaming fallback audio');
    }
});

app.get('/api/sources', (req, res) => {
    res.json({ success: true, sources: Object.entries(SOURCES).map(([key, val]) => ({ key, label: val.label, prefix: val.prefix })), fallbackOrder: FALLBACK_ORDER });
});

app.post('/api/recommend', async (req, res) => {
    try {
        const { currentTrack, history } = req.body;
        if (!currentTrack?.info) return res.status(400).json({ error: 'Valid currentTrack is required' });

        const info = currentTrack.info;
        let videoId = info.identifier;
        if (info.uri?.includes('youtu')) {
            try { videoId = new URL(info.uri).searchParams.get('v') || info.identifier; } catch (e) { }
        }

        const historyIds = new Set([videoId, info.identifier]);
        (history || []).forEach(t => {
            if (!t.info) return;
            historyIds.add(t.info.identifier);
            if (t.info.uri?.includes('youtu')) {
                try { const vid = new URL(t.info.uri).searchParams.get('v'); if (vid) historyIds.add(vid); } catch (e) { }
            }
        });

        const filterDups = (tracks) => tracks.filter(track => {
            let id = track.info.identifier;
            if (track.info.uri?.includes('youtu')) { try { id = new URL(track.info.uri).searchParams.get('v') || id; } catch (e) { } }
            return !historyIds.has(id);
        });

        const cleanAuthor = (info.author || '').replace(/ - Topic$/, '').trim();
        const title = info.title || '';
        let recommended = [];

        if (info.sourceName === 'youtube' || info.uri?.includes('youtu')) {
            try {
                const data = await loadTracks(`https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`);
                if (data.loadType === 'playlist') { const t = filterDups(data.data?.tracks || []); recommended = [...recommended, ...t]; }
            } catch (e) { }
        }
        for (const prefix of ['spsearch', 'dzsearch', 'scsearch']) {
            if (recommended.length >= 4) break;
            try { const t = filterDups(extractTracks(await loadTracks(`${prefix}:${cleanAuthor} ${title}`))); recommended = [...recommended, ...t]; } catch (e) { }
        }
        if (recommended.length < 3) {
            try { const t = filterDups(extractTracks(await loadTracks(`ytmsearch:${cleanAuthor} ${title} related songs`))); recommended = [...recommended, ...t]; } catch (e) { }
        }

        const seen = new Set();
        recommended = recommended.filter(t => { if (seen.has(t.info.identifier)) return false; seen.add(t.info.identifier); return true; }).slice(0, 8);

        if (recommended.length > 0) return res.json({ success: true, tracks: recommended });
        return res.json({ success: false, message: 'No related tracks found' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch recommendations.', detail: error.message });
    }
});

app.get('/api/info', async (req, res) => {
    try {
        const response = await axios.get(getLavalinkUrl('/v4/info'), { headers: { Authorization: LAVALINK.password }, timeout: 5000 });
        res.json({ success: true, info: response.data });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Room System (WebSocket) ──────────────────────────────────────────────────
const rooms = new Map();

function generateRoomCode() {
    let code;
    do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(code));
    return code;
}

function getRoomMembersInfo(room) {
    return Array.from(room.members).map(ws => ({
        id: ws._userId,
        name: room.memberNames.get(ws),
        isHost: room.host === ws
    }));
}

function broadcast(room, message, excludeWs = null) {
    const data = JSON.stringify(message);
    room.members.forEach(ws => {
        if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    });
}

function broadcastAll(room, message) {
    broadcast(room, message, null);
}

function removeFromRoom(ws) {
    const roomCode = ws._roomCode;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    const username = room.memberNames.get(ws) || 'Someone';
    room.members.delete(ws);
    room.memberNames.delete(ws);
    ws._roomCode = null;

    if (room.members.size === 0) {
        rooms.delete(roomCode);
        console.log(`[Room] ${roomCode} deleted (empty)`);
        return;
    }

    if (room.host === ws) {
        room.host = room.members.values().next().value;
        room.host._isHost = true;
        broadcastAll(room, { type: 'host_left', newHost: room.memberNames.get(room.host), members: getRoomMembersInfo(room) });
        if (room.host.readyState === WebSocket.OPEN) {
            room.host.send(JSON.stringify({ type: 'you_are_host' }));
        }
        console.log(`[Room] ${roomCode} — new host: ${room.memberNames.get(room.host)}`);
    } else {
        broadcastAll(room, { type: 'member_left', userId: ws._userId, username, members: getRoomMembersInfo(room) });
    }

    console.log(`[Room] ${roomCode} — ${username} left (${room.members.size} left)`);
}

// ─── Create HTTP server ───────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    ws._roomCode = null;
    ws._isHost = false;
    ws._userId = Math.random().toString(36).substring(2, 12);

    ws._pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 25000);

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {

            case 'create_room': {
                if (ws._roomCode) removeFromRoom(ws);

                const code = generateRoomCode();
                const username = (msg.username || 'Host').slice(0, 20);
                const roomType = msg.roomType || 'music'; // fallback to music
                const room = {
                    host: ws,
                    members: new Set([ws]),
                    memberNames: new Map([[ws, username]]),
                    roomType: roomType,
                    state: msg.state || { queue: [], currentIndex: 0, isPlaying: false, currentTime: 0 },
                };
                rooms.set(code, room);
                ws._roomCode = code;
                ws._isHost = true;

                ws.send(JSON.stringify({ type: 'room_created', code, myId: ws._userId, members: getRoomMembersInfo(room) }));
                console.log(`[Room] ${code} (${roomType}) created by ${username}`);
                break;
            }

            case 'join_room': {
                const code = String(msg.code).trim();
                const roomType = msg.roomType || 'music';
                const room = rooms.get(code);

                if (!room) {
                    ws.send(JSON.stringify({ type: 'room_error', message: 'Room not found. Check the code and try again.' }));
                    return;
                }
                if (room.roomType !== roomType) {
                    ws.send(JSON.stringify({ type: 'room_error', message: `This room code is for the ${room.roomType === 'movie' ? 'Movie Player' : 'Music Player'}.` }));
                    return;
                }
                if (room.members.size >= 10) {
                    ws.send(JSON.stringify({ type: 'room_error', message: 'Room is full (max 10 members).' }));
                    return;
                }

                if (ws._roomCode) removeFromRoom(ws);

                const username = (msg.username || 'Listener').slice(0, 20);
                room.members.add(ws);
                room.memberNames.set(ws, username);
                ws._roomCode = code;
                ws._isHost = false;

                ws.send(JSON.stringify({
                    type: 'room_joined',
                    code,
                    myId: ws._userId,
                    members: getRoomMembersInfo(room),
                    state: room.state,
                    hostName: room.memberNames.get(room.host),
                }));

                broadcast(room, { type: 'member_joined', user: { id: ws._userId, name: username, isHost: false }, members: getRoomMembersInfo(room) }, ws);
                console.log(`[Room] ${code} — ${username} joined (${room.members.size} members)`);
                break;
            }

            case 'leave_room': {
                removeFromRoom(ws);
                ws.send(JSON.stringify({ type: 'room_left' }));
                break;
            }

            case 'sync_state': {
                const room = rooms.get(ws._roomCode);
                if (!room || room.host !== ws) return;

                room.state = msg.state;
                broadcast(room, { type: 'state_update', state: msg.state }, ws);
                break;
            }

            case 'chat': {
                const room = rooms.get(ws._roomCode);
                if (!room) return;
                const username = room.memberNames.get(ws) || 'Unknown';
                const message = String(msg.message || '').slice(0, 200);
                if (!message.trim()) return;

                broadcastAll(room, {
                    type: 'chat',
                    username,
                    message,
                    isHost: room.host === ws,
                    timestamp: Date.now(),
                });
                break;
            }

            case 'webrtc_signal': {
                const room = rooms.get(ws._roomCode);
                if (!room) return;

                let targetWs = null;
                for (let memberWs of room.members) {
                    if (memberWs._userId === msg.to) {
                        targetWs = memberWs;
                        break;
                    }
                }
                if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                    targetWs.send(JSON.stringify({
                        type: 'webrtc_signal',
                        from: ws._userId,
                        signal: msg.signal
                    }));
                }
                break;
            }
        }
    });

    ws.on('close', () => {
        clearInterval(ws._pingInterval);
        removeFromRoom(ws);
    });

    ws.on('error', () => {
        clearInterval(ws._pingInterval);
        removeFromRoom(ws);
    });
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(process.env.PORT || 3000, '0.0.0.0', () => {
    console.log(`\n🌙 Moon Web Player API  →  http://localhost:${process.env.PORT || 3000} (or Render URL)`);
    console.log(`🔌 WebSocket Rooms       →  ws://localhost:${process.env.PORT || 3000}`);
    console.log(`📡 Lavalink              →  ${LAVALINK.host}:${LAVALINK.port}`);
    console.log(`📁 Local File Streaming  →  /api/stream/localfile`);
    console.log(`\n🔀 Auto-Fallback Chain (in order):`);
    FALLBACK_ORDER.forEach((key, i) => {
        const s = SOURCES[key];
        console.log(`   ${String(i + 1).padStart(2)}. ${s.label.padEnd(16)} [${s.prefix}:]`);
    });
    console.log(`\n💡 LavaSrc plugin needed for: Spotify, Apple Music, Deezer, Tidal, Yandex, JioSaavn, VK`);
    console.log(`💡 Visit /api/info to see which plugins your node has loaded\n`);
});

// ─── FIX 2: Disable timeout for large file uploads ────────────────────────────
server.timeout = 0;
server.keepAliveTimeout = 0;
server.headersTimeout = 0;
server.requestTimeout = 0;