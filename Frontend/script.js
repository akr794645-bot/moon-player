// Moon Web Player — script.js

let queue = [];
let currentIndex = 0;
// --- App Config for Deployment & LAN Testing ---
const isLocalHost = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
const isLocalFile = window.location.protocol === 'file:';
const BACKEND_URL = (isLocalFile || isLocalHost) ? 'http://localhost:3000' : window.location.origin;
const WS_URL = BACKEND_URL.replace(/^http/, 'ws');
// ---------------------------------

let ytPlayer;
let progressInterval = null;
let isShuffle = false;
let repeatMode = 0;
let isAutoplay = false;
let isFetchingRecommendations = false;

// Fallback audio element for restricted YouTube tracks
let fallbackAudio = new Audio();
let isUsingFallback = false;

let favorites = [];
let history = [];
try {
    favorites = JSON.parse(localStorage.getItem('moon_favorites')) || [];
    history = JSON.parse(localStorage.getItem('moon_history')) || [];
} catch (e) { }

function saveToStorage() {
    try {
        localStorage.setItem('moon_favorites', JSON.stringify(favorites));
        localStorage.setItem('moon_history', JSON.stringify(history));
    } catch (e) { }
    updateBadges();
}

function updateBadges() {
    const queueCountEl = document.getElementById('queueCount');
    if (queueCountEl) queueCountEl.textContent = queue.length;
    const btns = document.querySelectorAll('.action-btn');
    if (btns[0]) btns[0].innerHTML = `<i class="fas fa-list-ul"></i> Queue (${queue.length})`;
    if (btns[1]) btns[1].innerHTML = `<i class="far fa-heart"></i> Favorites (${favorites.length})`;
    if (btns[2]) btns[2].innerHTML = `<i class="fas fa-history"></i> History (${history.length})`;
}

function formatTime(ms) {
    if (!ms || isNaN(ms)) return '0:00';
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function getVideoId(track) {
    if (!track?.info) return '';
    let id = track.info.identifier;
    if (track.info.uri?.includes('youtu')) {
        try { id = new URL(track.info.uri).searchParams.get('v') || id; } catch (e) { }
    }
    return id;
}

// ─── YouTube Player ──────────────────────────────────────────────────────────

function onYouTubeIframeAPIReady() {
    ytPlayer = new YT.Player('ytplayer-container', {
        height: '1', width: '1', videoId: '',
        playerVars: { autoplay: 1, controls: 0, disablekb: 1, fs: 0, modestbranding: 1, rel: 0, playsinline: 1 },
        events: { onReady: onPlayerReady, onStateChange: onPlayerStateChange, onError: onPlayerError }
    });
}

function onPlayerReady(event) {
    event.target.setVolume(50);
    document.getElementById('volumeFill').style.width = '50%';
    if (window._pendingVideoId) { ytPlayer.loadVideoById(window._pendingVideoId); window._pendingVideoId = null; }
}

function onPlayerError(event) {
    console.warn('[YouTube API Error] Video failed to play. Switching to fallback audio stream...');
    isUsingFallback = true;

    // Attempt to get track metadata to search for an alternative stream
    const track = queue[currentIndex];
    if (track && track.info) {
        const query = `${track.info.title} ${track.info.author}`;
        fallbackAudio.src = `${BACKEND_URL}/api/stream/fallback?query=${encodeURIComponent(query)}`;

        fallbackAudio.play().then(() => {
            document.getElementById('playPauseBtn').innerHTML = '<i class="fas fa-pause"></i>';
            startProgressBar();
            // Start sync if in a room
            if (roomWs && roomWs.readyState === WebSocket.OPEN && roomIsHost) {
                roomSyncState();
            }
        }).catch(err => {
            console.error('[Fallback Stream Error]', err);
            // If fallback also fails, skip to next song
            if (queue.length > 0 && currentIndex < queue.length - 1) { currentIndex++; window.playCurrentSong(); }
            else resetPlayerUI();
        });
    } else {
        if (queue.length > 0 && currentIndex < queue.length - 1) { currentIndex++; window.playCurrentSong(); }
        else resetPlayerUI();
    }
}

function onPlayerStateChange(event) {
    if (event.data === YT.PlayerState.ENDED) {
        if (repeatMode === 1) { window.playCurrentSong(); }
        else if (isShuffle && queue.length > 1) { let n = currentIndex; while (n === currentIndex) n = Math.floor(Math.random() * queue.length); currentIndex = n; window.playCurrentSong(); }
        else if (currentIndex < queue.length - 1) { currentIndex++; window.playCurrentSong(); }
        else if (repeatMode === 2) { currentIndex = 0; window.playCurrentSong(); }
        else resetPlayerUI();
    } else if (event.data === YT.PlayerState.PLAYING) {
        document.getElementById('playPauseBtn').innerHTML = '<i class="fas fa-pause"></i>';
        startProgressBar();
    } else if (event.data === YT.PlayerState.PAUSED) {
        document.getElementById('playPauseBtn').innerHTML = '<i class="fas fa-play"></i>';
        stopProgressBar();
    } else if (event.data === YT.PlayerState.UNSTARTED || event.data === YT.PlayerState.CUED) {
        ytPlayer.playVideo();
    }
}

function resetPlayerUI() {
    document.getElementById('trackTitle').textContent = 'No Track Playing';
    document.getElementById('trackAuthor').textContent = 'Unknown Artist';
    document.getElementById('albumArt').style.display = 'none';
    document.getElementById('placeholderArt').style.display = 'flex';
    document.getElementById('currentTime').textContent = '0:00';
    document.getElementById('totalTime').textContent = '0:00';
    document.getElementById('progressBar').style.width = '0%';
    document.getElementById('playPauseBtn').innerHTML = '<i class="fas fa-play"></i>';
    stopProgressBar();
}

function startProgressBar() {
    if (progressInterval) clearInterval(progressInterval);
    progressInterval = setInterval(() => {
        if (isUsingFallback && fallbackAudio) {
            const cur = fallbackAudio.currentTime || 0;
            let tot = fallbackAudio.duration;
            if (!tot || !isFinite(tot)) {
                tot = (queue[currentIndex]?.info?.length / 1000) || 0;
            }
            document.getElementById('currentTime').textContent = formatTime(cur * 1000);
            if (tot > 0) document.getElementById('progressBar').style.width = `${(cur / tot) * 100}%`;
        } else if (ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
            const cur = ytPlayer.getCurrentTime();
            const tot = ytPlayer.getDuration() || (queue[currentIndex]?.info?.length / 1000 || 0);
            document.getElementById('currentTime').textContent = formatTime(cur * 1000);
            if (tot > 0) document.getElementById('progressBar').style.width = `${(cur / tot) * 100}%`;
        }
    }, 1000);
}

function stopProgressBar() { if (progressInterval) { clearInterval(progressInterval); progressInterval = null; } }

// Fallback audio events
fallbackAudio.addEventListener('ended', () => {
    if (repeatMode === 1) { fallbackAudio.currentTime = 0; fallbackAudio.play(); }
    else if (isShuffle && queue.length > 1) { let n = currentIndex; while (n === currentIndex) n = Math.floor(Math.random() * queue.length); currentIndex = n; window.playCurrentSong(); }
    else if (currentIndex < queue.length - 1) { currentIndex++; window.playCurrentSong(); }
    else if (repeatMode === 2) { currentIndex = 0; window.playCurrentSong(); }
    else resetPlayerUI();
});

fallbackAudio.addEventListener('play', () => { document.getElementById('playPauseBtn').innerHTML = '<i class="fas fa-pause"></i>'; startProgressBar(); });
fallbackAudio.addEventListener('pause', () => { document.getElementById('playPauseBtn').innerHTML = '<i class="fas fa-play"></i>'; stopProgressBar(); });

// ─── Play Current Song ────────────────────────────────────────────────────────

window.playCurrentSong = () => {
    if (!queue[currentIndex]) return;
    const track = queue[currentIndex];
    const videoId = getVideoId(track);
    if (!videoId) return;

    if (!history.length || history[0].info.identifier !== track.info.identifier) {
        history.unshift(track);
        if (history.length > 50) history.pop();
        saveToStorage();
    }

    document.getElementById('trackTitle').textContent = track.info.title;
    document.getElementById('trackAuthor').textContent = track.info.author;
    document.getElementById('totalTime').textContent = formatTime(track.info.length);
    document.getElementById('currentTime').textContent = '0:00';
    document.getElementById('progressBar').style.width = '0%';
    document.getElementById('playPauseBtn').innerHTML = '<i class="fas fa-pause"></i>';

    const albumArt = document.getElementById('albumArt');
    albumArt.src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    albumArt.style.display = 'block';

    // Stop any playing fallback audio when a new song is initiated
    isUsingFallback = false;
    fallbackAudio.pause();
    fallbackAudio.currentTime = 0;
    fallbackAudio.src = '';
    document.getElementById('placeholderArt').style.display = 'none';

    const favBtn = document.getElementById('favBtn');
    const icon = favBtn.querySelector('i');
    const isFav = favorites.find(t => t.info.identifier === track.info.identifier);
    icon.className = isFav ? 'fas fa-heart' : 'far fa-heart';
    favBtn.style.color = isFav ? 'var(--accent)' : 'var(--text-secondary)';

    if (ytPlayer && typeof ytPlayer.loadVideoById === 'function') ytPlayer.loadVideoById(videoId);
    else window._pendingVideoId = videoId;

    window.renderQueue();

    if (isAutoplay && currentIndex >= queue.length - 2) window.fetchRecommendations(track);

    // Sync room state if host
    roomSyncState();
};

window.fetchRecommendations = async (track) => {
    if (isFetchingRecommendations) return;
    isFetchingRecommendations = true;
    try {
        const res = await fetch(`${BACKEND_URL}/api/recommend`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentTrack: track, history: history.slice(0, 15) })
        });
        const data = await res.json();
        if (data.success && data.tracks?.length) {
            data.tracks.forEach(t => queue.push(t));
            updateBadges();
            const btns = document.querySelectorAll('.action-btn');
            if (btns[0].classList.contains('active')) window.renderQueue();
        }
    } catch (e) { console.error('Recommendations failed:', e); }
    finally { isFetchingRecommendations = false; }
};

// ─── Room System ──────────────────────────────────────────────────────────────

let roomWs = null;
let roomCode = null;
let roomIsHost = false;
let roomUsername = '';
let roomMembers = [];
let roomConnected = false;
let myUserId = null;

// WebRTC State
let localStream = null;
let isMicOn = false;
let isCamOn = false;
const peers = {}; // userId -> RTCPeerConnection

const movieSideCard = document.getElementById('movieSideCard');
const sideCardRoomCode = document.getElementById('sideCardRoomCode');
const sideCardMemberCount = document.getElementById('sideCardMemberCount');
const sideCardMembersList = document.getElementById('sideCardMembersList');
const toggleSideMicBtn = document.getElementById('toggleSideMicBtn');
const toggleSideCamBtn = document.getElementById('toggleSideCamBtn');

// Floating Chat Elements
const toggleSideChatBtn = document.getElementById('toggleSideChatBtn');
const floatingChatContainer = document.getElementById('floatingChatContainer');
const floatingChatClose = document.getElementById('floatingChatClose');
const floatingChatMessages = document.getElementById('floatingChatMessages');
const floatingChatInput = document.getElementById('floatingChatInput');
const floatingChatSendBtn = document.getElementById('floatingChatSendBtn');
const floatingChatEmojiBtn = document.getElementById('floatingChatEmojiBtn');
const emojiPicker = document.getElementById('emojiPicker');

// ── Floating Chat Logic ──
if (toggleSideChatBtn) {
    toggleSideChatBtn.addEventListener('click', () => {
        floatingChatContainer.classList.add('open');
    });
}

if (floatingChatClose) {
    floatingChatClose.addEventListener('click', () => {
        floatingChatContainer.classList.remove('open');
        emojiPicker.classList.remove('show');
    });
}

if (floatingChatEmojiBtn) {
    floatingChatEmojiBtn.addEventListener('click', () => {
        emojiPicker.classList.toggle('show');
    });
}

if (emojiPicker) {
    emojiPicker.querySelectorAll('.emoji-item').forEach(item => {
        item.addEventListener('click', (e) => {
            floatingChatInput.value += e.target.textContent;
            emojiPicker.classList.remove('show');
            floatingChatInput.focus();
        });
    });
}

function sendFloatingChat() {
    if (!floatingChatInput) return;
    const msg = floatingChatInput.value.trim();
    if (!msg || !roomWs || roomWs.readyState !== WebSocket.OPEN || !roomCode) return;
    roomWs.send(JSON.stringify({ type: 'chat', message: msg }));
    floatingChatInput.value = '';
    emojiPicker.classList.remove('show');
}

if (floatingChatSendBtn) {
    floatingChatSendBtn.addEventListener('click', sendFloatingChat);
}

if (floatingChatInput) {
    floatingChatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendFloatingChat();
    });
}

// WebRTC Config
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
    ]
};

async function toggleLocalStream(type) {
    if (type === 'mic') {
        isMicOn = !isMicOn;
        if (toggleSideMicBtn) {
            toggleSideMicBtn.innerHTML = isMicOn ? '<i class="fas fa-microphone"></i>' : '<i class="fas fa-microphone-slash"></i>';
            toggleSideMicBtn.className = isMicOn ? 'sidebar-btn active' : 'sidebar-btn danger';
        }
    } else {
        isCamOn = !isCamOn;
        if (toggleSideCamBtn) {
            toggleSideCamBtn.innerHTML = isCamOn ? '<i class="fas fa-video"></i>' : '<i class="fas fa-video-slash"></i>';
            toggleSideCamBtn.className = isCamOn ? 'sidebar-btn active' : 'sidebar-btn danger';
        }
    }

    if (!isMicOn && !isCamOn && localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    } else if ((isMicOn || isCamOn) && !localStream) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
            localStream.getAudioTracks().forEach(t => t.enabled = isMicOn);
            localStream.getVideoTracks().forEach(t => t.enabled = isCamOn);

            const myVid = document.getElementById(`vid_${myUserId}`);
            if (myVid) {
                myVid.srcObject = localStream;
                myVid.style.display = isCamOn ? 'block' : 'none';
            }

            for (let uid in peers) {
                localStream.getTracks().forEach(track => {
                    const senders = peers[uid].getSenders();
                    if (!senders.find(s => s.track === track)) {
                        peers[uid].addTrack(track, localStream);
                    }
                });
                createAndSendOffer(uid);
            }
        } catch (e) {
            console.error('Media error', e);
            showRoomToast('Permissions for mic/camera denied.', 'error');
            if (type === 'mic') isMicOn = false;
            if (type === 'cam') isCamOn = false;
            if (toggleSideMicBtn) {
                toggleSideMicBtn.className = 'sidebar-btn';
                toggleSideMicBtn.innerHTML = '<i class="fas fa-microphone-slash"></i>';
            }
            if (toggleSideCamBtn) {
                toggleSideCamBtn.className = 'sidebar-btn';
                toggleSideCamBtn.innerHTML = '<i class="fas fa-video-slash"></i>';
            }
        }
    } else if (localStream) {
        localStream.getAudioTracks().forEach(t => t.enabled = isMicOn);
        localStream.getVideoTracks().forEach(t => t.enabled = isCamOn);

        const myVid = document.getElementById(`vid_${myUserId}`);
        if (myVid) myVid.style.display = isCamOn ? 'block' : 'none';
    }

    updateRoomUI();
}

if (toggleSideMicBtn) toggleSideMicBtn.addEventListener('click', () => toggleLocalStream('mic'));
if (toggleSideCamBtn) toggleSideCamBtn.addEventListener('click', () => toggleLocalStream('cam'));

function createPeerConnection(userId) {
    if (peers[userId]) return peers[userId];

    const pc = new RTCPeerConnection(rtcConfig);
    peers[userId] = pc;

    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.onicecandidate = (event) => {
        if (event.candidate && roomWs && roomWs.readyState === WebSocket.OPEN) {
            roomWs.send(JSON.stringify({
                type: 'webrtc_signal',
                to: userId,
                signal: { type: 'candidate', candidate: event.candidate }
            }));
        }
    };

    pc.ontrack = (event) => {
        const vidElement = document.getElementById(`vid_${userId}`);
        if (vidElement) {
            vidElement.srcObject = event.streams[0];
            vidElement.style.display = 'block';
        }
    };

    return pc;
}

async function createAndSendOffer(userId) {
    const pc = createPeerConnection(userId);
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (roomWs && roomWs.readyState === WebSocket.OPEN) {
            roomWs.send(JSON.stringify({
                type: 'webrtc_signal',
                to: userId,
                signal: offer
            }));
        }
    } catch (e) {
        console.error('Error creating offer', e);
    }
}

async function handleWebRTCMessage(msg) {
    const userId = msg.from;
    const signal = msg.signal;

    const pc = createPeerConnection(userId);

    try {
        if (signal.type === 'offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            roomWs.send(JSON.stringify({
                type: 'webrtc_signal',
                to: userId,
                signal: answer
            }));
        } else if (signal.type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
        } else if (signal.type === 'candidate') {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
    } catch (e) {
        console.error('WebRTC handle error:', e);
    }
}

function clearAllPeers() {
    for (let uid in peers) {
        peers[uid].close();
        delete peers[uid];
    }
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    isMicOn = false; isCamOn = false;
    if (toggleSideMicBtn) {
        toggleSideMicBtn.className = 'sidebar-btn';
        toggleSideMicBtn.innerHTML = '<i class="fas fa-microphone-slash"></i>';
    }
    if (toggleSideCamBtn) {
        toggleSideCamBtn.className = 'sidebar-btn';
        toggleSideCamBtn.innerHTML = '<i class="fas fa-video-slash"></i>';
    }
}

function roomSyncState() {
    if (!roomWs || roomWs.readyState !== WebSocket.OPEN || !roomIsHost) return;

    let isPlaying = false;
    let currentTime = 0;

    if (isUsingFallback) {
        isPlaying = !fallbackAudio.paused;
        currentTime = fallbackAudio.currentTime;
    } else if (ytPlayer && typeof ytPlayer.getPlayerState === 'function') {
        isPlaying = ytPlayer.getPlayerState() === YT.PlayerState.PLAYING;
        currentTime = ytPlayer.getCurrentTime();
    }

    const state = { queue, currentIndex, isPlaying, currentTime };
    roomWs.send(JSON.stringify({ type: 'sync_state', state }));
}

function roomConnect(onOpen) {
    if (roomWs && roomWs.readyState === WebSocket.OPEN) { onOpen(); return; }
    roomWs = new WebSocket(WS_URL);
    roomWs.onopen = () => { roomConnected = true; onOpen(); };
    roomWs.onclose = () => {
        roomConnected = false;
        if (roomCode) { roomAddChat('🔌 Disconnected from room.', 'system'); updateRoomUI(); }
        roomCode = null; roomIsHost = false; roomMembers = []; myUserId = null;
        clearAllPeers();
        updateRoomUI();
    };
    roomWs.onerror = () => { roomConnected = false; };
    roomWs.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        handleRoomMessage(msg);
    };
}

function handleRoomMessage(msg) {
    switch (msg.type) {

        case 'room_created':
            roomCode = msg.code;
            roomIsHost = true;
            // Persist host room via localstorage
            localStorage.setItem('moon_room_code', roomCode);
            localStorage.setItem('moon_room_username', roomUsername);
            roomMembers = [{ id: myUserId, name: roomUsername, isHost: true }];
            updateRoomUI();
            roomAddChat('Welcome to the room! Share the code to invite others.', 'system');
            break;

        case 'room_joined':
            roomCode = msg.code;
            roomIsHost = false;
            roomMembers = msg.members;
            myUserId = msg.myId;
            updateRoomUI();
            roomAddChat(`✅ Joined room <b>${roomCode}</b> hosted by <b>${msg.hostName}</b>`, 'system');
            // Apply host's state
            if (msg.state) applyRoomState(msg.state);
            roomMembers.forEach(m => {
                if (m.id !== myUserId) createAndSendOffer(m.id);
            });
            break;

        case 'room_error':
            showRoomToast(msg.message, 'error');
            break;

        case 'room_left':
            roomCode = null; roomIsHost = false; roomMembers = []; myUserId = null;
            clearAllPeers();
            updateRoomUI();
            roomAddChat('👋 You left the room.', 'system');
            break;

        case 'you_are_host':
            roomIsHost = true;
            updateRoomUI();
            roomAddChat('👑 You are now the host.', 'system');
            break;

        case 'host_left':
            roomMembers = msg.members;
            updateRoomUI();
            roomAddChat(`👑 Host left. <b>${msg.newHost}</b> is now the host.`, 'system');
            break;

        case 'state_update':
            if (!roomIsHost) applyRoomState(msg.state);
            break;

        case 'member_joined':
            roomMembers = msg.members;
            updateRoomUI();
            roomAddChat(`👤 <b>${msg.user.name}</b> joined the room.`, 'system');
            break;

        case 'member_left':
            roomMembers = msg.members;
            updateRoomUI();
            roomAddChat(`👤 <b>${msg.username}</b> left the room.`, 'system');
            if (peers[msg.userId]) { peers[msg.userId].close(); delete peers[msg.userId]; }
            break;

        case 'chat':
            roomAddChat(`<b>${msg.username}${msg.isHost ? ' 👑' : ''}</b>: ${escapeHtml(msg.message)}`, 'user', msg.username === roomUsername);
            break;

        case 'webrtc_signal':
            handleWebRTCMessage(msg);
            break;

        case 'ping': break;
    }
}

function applyRoomState(state) {
    if (!state) return;
    if (state.queue && state.queue.length > 0) {
        queue = state.queue;
        currentIndex = state.currentIndex || 0;
        updateBadges();
        window.renderQueue && window.renderQueue();
        // Load the track
        const track = queue[currentIndex];
        if (track) {
            const videoId = getVideoId(track);
            document.getElementById('trackTitle').textContent = track.info.title;
            document.getElementById('trackAuthor').textContent = track.info.author;
            document.getElementById('totalTime').textContent = formatTime(track.info.length);
            const albumArt = document.getElementById('albumArt');
            albumArt.src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
            albumArt.style.display = 'block';
            document.getElementById('placeholderArt').style.display = 'none';

            if (isUsingFallback) {
                fallbackAudio.currentTime = state.currentTime || 0;
                if (!state.isPlaying) {
                    fallbackAudio.pause();
                } else {
                    fallbackAudio.play().catch(() => { });
                }
            } else if (ytPlayer && typeof ytPlayer.loadVideoById === 'function') {
                ytPlayer.loadVideoById({ videoId, startSeconds: state.currentTime || 0 });
                if (!state.isPlaying) setTimeout(() => ytPlayer.pauseVideo(), 1500);
            } else {
                window._pendingVideoId = videoId;
            }
        }
    }
}

function updateRoomUI() {
    const badge = document.getElementById('roomBadge');
    const btn = document.getElementById('roomNavBtn');
    const memberCount = document.getElementById('roomMemberCount');
    const roomCodeDisplay = document.getElementById('roomCodeDisplay');
    const roomStatus = document.getElementById('roomStatus');
    const leaveBtn = document.getElementById('roomLeaveBtn');
    const hostControls = document.getElementById('roomHostControls');

    if (roomCode) {
        if (badge) { badge.style.display = 'flex'; badge.textContent = roomMembers.length; }
        if (btn) btn.style.color = 'var(--accent)';
        if (memberCount) memberCount.textContent = roomMembers.length;
        if (roomCodeDisplay) roomCodeDisplay.textContent = roomCode;
        if (roomStatus) roomStatus.textContent = roomIsHost ? '👑 You are the host' : '🎧 Listening with others';
        if (leaveBtn) leaveBtn.style.display = 'block';
        if (hostControls) hostControls.style.display = roomIsHost ? 'block' : 'none';

        if (movieSideCard) movieSideCard.style.display = 'flex';
        if (sideCardRoomCode) sideCardRoomCode.textContent = roomCode;
        if (sideCardMemberCount) sideCardMemberCount.textContent = roomMembers.length;

        // Update members list
        const membersList = document.getElementById('roomMembersList');
        const sideMembersListHTML = roomMembers.map((m, i) => {
            const name = m.name;
            const isMe = m.id === myUserId;
            const hasVidUrl = isMe ? (localStream && isCamOn) : (peers[m.id] && peers[m.id].getReceivers().some(r => r.track && r.track.kind === 'video'));

            return `
            <div class="sidebar-member-item">
                <div class="sidebar-member-header">
                    <div class="sidebar-member-dp">${name.charAt(0).toUpperCase()}</div>
                    <div class="sidebar-member-info">
                        <div class="sidebar-member-name">${escapeHtml(name)} ${isMe ? '(You)' : ''}</div>
                        <div class="sidebar-member-status">
                            <i class="fas fa-signal active"></i>
                            ${m.isHost ? '<span style="color:var(--accent);">Host</span>' : 'Member'}
                        </div>
                    </div>
                </div>
                <!-- Video element for peer/local -->
                <video id="vid_${m.id}" class="sidebar-member-video" autoplay playsinline ${isMe ? 'muted' : ''} style="display: ${hasVidUrl ? 'block' : 'none'}"></video>
            </div>`;
        }).join('');

        if (sideCardMembersList) sideCardMembersList.innerHTML = sideMembersListHTML;

        if (membersList) {
            membersList.innerHTML = roomMembers.map((m, i) =>
                `<div class="room-member-item">
                    <div class="room-member-avatar">${m.name.charAt(0).toUpperCase()}</div>
                    <span>${escapeHtml(m.name)}</span>
                    ${m.isHost ? '<span class="room-host-tag">Host</span>' : ''}
                </div>`
            ).join('');
        }

        // Reattach local stream to video tag if needed
        if (localStream && myUserId) {
            const myVid = document.getElementById(`vid_${myUserId}`);
            if (myVid && !myVid.srcObject) { myVid.srcObject = localStream; myVid.style.display = isCamOn ? 'block' : 'none'; }
        }

        // Reattach peer streams
        roomMembers.forEach(m => {
            if (m.id !== myUserId && peers[m.id]) {
                const pVid = document.getElementById(`vid_${m.id}`);
                const recv = peers[m.id].getReceivers().find(r => r.track && r.track.kind === 'video');
                if (pVid && recv && peers[m.id].getReceivers()[0].track) {
                    const stream = new MediaStream(peers[m.id].getReceivers().map(r => r.track));
                    pVid.srcObject = stream;
                    pVid.style.display = 'block';
                }
            }
        });

    } else {
        if (badge) badge.style.display = 'none';
        if (btn) btn.style.color = '';
        if (leaveBtn) leaveBtn.style.display = 'none';
        if (hostControls) hostControls.style.display = 'none';
        if (movieSideCard) movieSideCard.style.display = 'none';
    }
}

function roomAddChat(html, type = 'user', isSelf = false) {
    // Legacy chat log (in the modal)
    const log = document.getElementById('roomChatLog');
    if (log) {
        const div = document.createElement('div');
        div.className = `room-chat-msg ${type === 'system' ? 'system' : ''} ${isSelf ? 'self' : ''}`;
        div.innerHTML = html;
        log.appendChild(div);
        log.scrollTop = log.scrollHeight;
    }

    // New floating chat log
    const floatingLog = document.getElementById('floatingChatMessages');
    if (floatingLog) {
        const div = document.createElement('div');
        div.className = `room-chat-msg ${type === 'system' ? 'system' : ''} ${isSelf ? 'self' : ''}`;
        div.innerHTML = html;
        if (type === 'system') {
            div.style.backgroundColor = 'transparent';
            div.style.textAlign = 'center';
            div.style.marginBottom = '5px';
        } else if (isSelf) {
            div.style.backgroundColor = 'rgba(0,229,255,0.15)';
            div.style.border = '1px solid rgba(0,229,255,0.3)';
            div.style.marginLeft = 'auto'; // Right align own messages
            div.style.maxWidth = '85%';
            div.style.width = 'fit-content';
        } else {
            div.style.backgroundColor = 'rgba(255,255,255,0.05)';
            div.style.marginRight = 'auto'; // Left align other messages
            div.style.maxWidth = '85%';
            div.style.width = 'fit-content';
        }
        floatingLog.appendChild(div);
        floatingLog.scrollTop = floatingLog.scrollHeight;

        // Auto open floating chat on new user message if closed
        if (type === 'user' && !isSelf && floatingChatContainer && !floatingChatContainer.classList.contains('open')) {
            showRoomToast('New chat message!');
        }
    }
}

function showRoomToast(msg, type = 'info') {
    const toast = document.getElementById('roomToast');
    if (!toast) return;
    toast.textContent = msg;
    toast.className = `room-toast show ${type}`;
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => toast.classList.remove('show'), 3500);
}

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── DOM Ready ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    updateBadges();

    // Rejoin room if previously joined
    try {
        const savedRoomCode = localStorage.getItem('moon_room_code');
        const savedRoomUsername = localStorage.getItem('moon_room_username');
        if (savedRoomCode && savedRoomUsername) {
            roomUsername = savedRoomUsername;
            roomConnect(() => {
                roomWs.send(JSON.stringify({ type: 'join_room', code: savedRoomCode, username: savedRoomUsername, roomType: 'music' }));
                switchRoomScreen('room');
            });
        }
    } catch (e) { }

    const actionBtns = document.querySelectorAll('.action-btn');
    const rightPanelTitle = document.querySelector('.panel-header h3');
    const queueList = document.getElementById('queueList');
    let currentTab = 'Queue';

    actionBtns.forEach((btn, i) => {
        btn.addEventListener('click', () => {
            actionBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (i === 0) { currentTab = 'Queue'; rightPanelTitle.innerHTML = `Queue <span class="badge" id="queueCount">${queue.length}</span>`; window.renderQueue(); }
            else if (i === 1) { currentTab = 'Favorites'; rightPanelTitle.innerHTML = `Favorites <span class="badge">${favorites.length}</span>`; window.renderFavorites(); }
            else if (i === 2) { currentTab = 'History'; rightPanelTitle.innerHTML = `History <span class="badge">${history.length}</span>`; window.renderHistory(); }
        });
    });

    const renderList = (listArr, type) => {
        if (!listArr.length) {
            queueList.innerHTML = `<div class="queue-empty-state"><i class="fas ${type === 'favorites' ? 'fa-heart' : 'fa-history'} empty-icon"></i><p>${type === 'favorites' ? 'No favorites yet' : 'No listening history'}</p></div>`;
            return;
        }
        queueList.innerHTML = listArr.map((track, index) => {
            const vid = getVideoId(track);
            return `<div class="queue-item" data-index="${index}" data-type="${type}">
                <div class="queue-item-index">${index + 1}</div>
                <img src="https://i.ytimg.com/vi/${vid}/hqdefault.jpg" class="queue-item-thumb">
                <div class="queue-item-info">
                    <div class="queue-item-title">${escapeHtml(track.info.title)}</div>
                    <div class="queue-item-author">${escapeHtml(track.info.author)}</div>
                </div>
                <div class="queue-item-duration">${formatTime(track.info.length)}</div>
                <div class="queue-item-actions">
                    <button class="play-list-btn" data-index="${index}" data-type="${type}"><i class="fas fa-play"></i></button>
                    ${type === 'favorites' ? `<button class="remove-fav-btn" data-index="${index}"><i class="fas fa-heart" style="color:var(--accent)"></i></button>` : ''}
                </div>
            </div>`;
        }).join('');

        queueList.querySelectorAll('.play-list-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.index), tpe = btn.dataset.type;
                queue.push(tpe === 'favorites' ? favorites[idx] : history[idx]);
                currentIndex = queue.length - 1;
                window.playCurrentSong();
            });
        });
        queueList.querySelectorAll('.remove-fav-btn').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); favorites.splice(parseInt(btn.dataset.index), 1); saveToStorage(); window.renderFavorites(); });
        });
    };

    window.renderFavorites = () => { if (currentTab !== 'Favorites') return; renderList(favorites, 'favorites'); };
    window.renderHistory = () => { if (currentTab !== 'History') return; renderList(history, 'history'); };

    window.renderQueue = () => {
        if (currentTab !== 'Queue') return;
        const el = document.getElementById('queueCount');
        if (el) el.textContent = queue.length;
        if (!queue.length) { queueList.innerHTML = `<div class="queue-empty-state"><i class="fas fa-music empty-icon"></i><p>Queue is empty</p></div>`; return; }
        queueList.innerHTML = queue.map((track, index) => {
            const vid = getVideoId(track);
            const isActive = index === currentIndex;
            const isFav = favorites.find(t => t.info.identifier === track.info.identifier);
            return `<div class="queue-item ${isActive ? 'active' : ''}" data-index="${index}">
                <div class="queue-item-index">${isActive ? '<i class="fas fa-volume-up"></i>' : index + 1}</div>
                <img src="https://i.ytimg.com/vi/${vid}/hqdefault.jpg" class="queue-item-thumb">
                <div class="queue-item-info">
                    <div class="queue-item-title">${escapeHtml(track.info.title)}</div>
                    <div class="queue-item-author">${escapeHtml(track.info.author)}</div>
                </div>
                <div class="queue-item-duration">${formatTime(track.info.length)}</div>
                <div class="queue-item-actions">
                    <button class="play-queue-btn" data-index="${index}"><i class="fas fa-play"></i></button>
                    <button class="fav-queue-btn" data-index="${index}"><i class="${isFav ? 'fas' : 'far'} fa-heart" ${isFav ? 'style="color:var(--accent)"' : ''}></i></button>
                    <button class="delete-btn" data-index="${index}"><i class="far fa-trash-alt"></i></button>
                </div>
            </div>`;
        }).join('');

        queueList.querySelectorAll('.play-queue-btn').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); currentIndex = parseInt(btn.dataset.index); window.playCurrentSong(); }));
        queueList.querySelectorAll('.fav-queue-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const track = queue[parseInt(btn.dataset.index)];
                const ei = favorites.findIndex(t => t.info.identifier === track.info.identifier);
                const icon = btn.querySelector('i');
                if (ei !== -1) { favorites.splice(ei, 1); icon.className = 'far fa-heart'; icon.style.color = ''; }
                else { favorites.unshift(track); icon.className = 'fas fa-heart'; icon.style.color = 'var(--accent)'; }
                saveToStorage();
            });
        });
        queueList.querySelectorAll('.queue-item').forEach(item => {
            item.addEventListener('dblclick', (e) => { if (e.target.closest('.queue-item-actions')) return; currentIndex = parseInt(item.dataset.index); window.playCurrentSong(); });
        });
        queueList.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.index);
                queue.splice(idx, 1);
                if (currentIndex === idx) { if (queue.length > 0) { currentIndex = Math.min(currentIndex, queue.length - 1); window.playCurrentSong(); } else { ytPlayer?.stopVideo?.(); resetPlayerUI(); } }
                else if (currentIndex > idx) currentIndex--;
                updateBadges(); window.renderQueue();
            });
        });
    };

    // ── Playback Controls ──
    document.getElementById('playPauseBtn').addEventListener('click', () => {
        if (isUsingFallback) {
            if (fallbackAudio.paused) { fallbackAudio.play(); roomSyncState(); }
            else { fallbackAudio.pause(); roomSyncState(); }
            return;
        }

        if (!ytPlayer || typeof ytPlayer.getPlayerState !== 'function') { if (queue.length > 0) window.playCurrentSong(); return; }
        const state = ytPlayer.getPlayerState();
        if (state === YT.PlayerState.PLAYING) { ytPlayer.pauseVideo(); roomSyncState(); }
        else if (state === YT.PlayerState.PAUSED || state === YT.PlayerState.CUED) { ytPlayer.playVideo(); roomSyncState(); }
        else if (queue[currentIndex]) window.playCurrentSong();
    });

    document.getElementById('prevBtn').addEventListener('click', () => {
        if (!queue.length) return;
        if (ytPlayer && typeof ytPlayer.getCurrentTime === 'function' && ytPlayer.getCurrentTime() > 3) ytPlayer.seekTo(0, true);
        else if (currentIndex > 0) { currentIndex--; window.playCurrentSong(); }
    });

    document.getElementById('nextBtn').addEventListener('click', () => {
        if (!queue.length) return;
        if (isShuffle && queue.length > 1) { let n = currentIndex; while (n === currentIndex) n = Math.floor(Math.random() * queue.length); currentIndex = n; }
        else if (currentIndex < queue.length - 1) currentIndex++;
        else if (repeatMode === 2) currentIndex = 0;
        else return;
        window.playCurrentSong();
    });

    document.getElementById('shuffleBtn').addEventListener('click', () => { isShuffle = !isShuffle; document.getElementById('shuffleBtn').style.color = isShuffle ? 'var(--accent)' : 'var(--text-secondary)'; });

    document.getElementById('autoplayBtn').addEventListener('click', () => {
        isAutoplay = !isAutoplay;
        document.getElementById('autoplayBtn').style.color = isAutoplay ? 'var(--accent)' : 'var(--text-secondary)';
        if (isAutoplay && queue.length > 0 && currentIndex >= queue.length - 2) window.fetchRecommendations(queue[currentIndex]);
    });

    document.getElementById('repeatBtn').addEventListener('click', () => {
        repeatMode = (repeatMode + 1) % 3;
        const btn = document.getElementById('repeatBtn');
        if (repeatMode === 0) { btn.innerHTML = '<i class="fas fa-redo"></i>'; btn.style.color = 'var(--text-secondary)'; }
        else if (repeatMode === 1) { btn.innerHTML = '<i class="fas fa-redo"></i><span style="font-size:0.5rem;position:absolute;top:-4px;right:-4px;font-weight:bold;">1</span>'; btn.style.color = 'var(--accent)'; btn.style.position = 'relative'; }
        else { btn.innerHTML = '<i class="fas fa-redo"></i>'; btn.style.color = 'var(--accent)'; }
    });

    const volumeControl = document.getElementById('volumeControl');
    volumeControl.addEventListener('click', (e) => {
        const p = Math.max(0, Math.min(1, (e.clientX - volumeControl.getBoundingClientRect().left) / volumeControl.offsetWidth));
        document.getElementById('volumeFill').style.width = `${p * 100}%`;

        fallbackAudio.volume = p;
        if (ytPlayer && typeof ytPlayer.setVolume === 'function') {
            ytPlayer.setVolume(p * 100);
        }
    });

    document.getElementById('favBtn').addEventListener('click', () => {
        if (!queue[currentIndex]) return;
        const track = queue[currentIndex];
        const favBtn = document.getElementById('favBtn');
        const icon = favBtn.querySelector('i');
        const ei = favorites.findIndex(t => t.info.identifier === track.info.identifier);
        if (ei !== -1) { favorites.splice(ei, 1); icon.className = 'far fa-heart'; favBtn.style.color = 'var(--text-secondary)'; }
        else { favorites.unshift(track); icon.className = 'fas fa-heart'; favBtn.style.color = 'var(--accent)'; }
        saveToStorage();
        if (actionBtns[1].classList.contains('active')) window.renderFavorites();
    });

    document.getElementById('progressBg').addEventListener('click', (e) => {
        if (!queue.length) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

        if (isUsingFallback) {
            fallbackAudio.currentTime = p * (fallbackAudio.duration || (queue[currentIndex]?.info?.length || 0) / 1000);
        } else if (ytPlayer && typeof ytPlayer.seekTo === 'function') {
            ytPlayer.seekTo(p * (queue[currentIndex]?.info?.length || 0) / 1000, true);
        }

        document.getElementById('progressBar').style.width = `${p * 100}%`;
        roomSyncState();
    });

    // Panel buttons
    const panelBtns = document.querySelectorAll('.panel-actions .icon-btn');
    if (panelBtns[0]) {
        panelBtns[0].addEventListener('click', () => {
            if (queue.length < 2) return;
            const cur = queue.splice(currentIndex, 1)[0];
            for (let i = queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[queue[i], queue[j]] = [queue[j], queue[i]]; }
            queue.unshift(cur); currentIndex = 0; window.renderQueue();
        });
    }

    // Clear Queue Modal
    const clearModal = document.createElement('div');
    clearModal.id = 'clearQueueModal';
    clearModal.innerHTML = `<div class="cq-backdrop"></div><div class="cq-card"><div class="cq-icon"><i class="far fa-trash-alt"></i></div><h3 class="cq-title">Clear Queue?</h3><p class="cq-desc">This will remove all <span id="cqCount">0</span> songs and stop playback.</p><div class="cq-actions"><button class="cq-btn cq-cancel">Cancel</button><button class="cq-btn cq-confirm">Clear All</button></div></div>`;
    document.body.appendChild(clearModal);
    const modalStyle = document.createElement('style');
    modalStyle.textContent = `#clearQueueModal{display:none;position:fixed;inset:0;z-index:9999;align-items:center;justify-content:center}#clearQueueModal.show{display:flex}.cq-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(6px);animation:cqFadeIn .2s ease}.cq-card{position:relative;z-index:1;background:linear-gradient(135deg,rgba(255,255,255,.06),rgba(255,255,255,.02));border:1px solid rgba(255,255,255,.12);border-radius:20px;padding:36px 32px 28px;min-width:320px;max-width:380px;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,.5);animation:cqSlideUp .25s cubic-bezier(.34,1.56,.64,1)}.cq-icon{width:56px;height:56px;border-radius:50%;background:rgba(255,75,75,.15);border:1px solid rgba(255,75,75,.3);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:1.4rem;color:#ff6b6b}.cq-title{font-size:1.3rem;font-weight:600;color:#fff;margin:0 0 10px}.cq-desc{font-size:.88rem;color:rgba(255,255,255,.5);margin:0 0 28px;line-height:1.6}.cq-desc span{color:rgba(255,255,255,.8);font-weight:600}.cq-actions{display:flex;gap:12px}.cq-btn{flex:1;padding:12px 0;border-radius:12px;border:none;font-size:.9rem;font-weight:600;cursor:pointer;transition:all .2s;font-family:inherit}.cq-cancel{background:rgba(255,255,255,.08);color:rgba(255,255,255,.75);border:1px solid rgba(255,255,255,.1)}.cq-cancel:hover{background:rgba(255,255,255,.14);color:#fff}.cq-confirm{background:linear-gradient(135deg,#ff4b4b,#e03030);color:#fff;box-shadow:0 4px 16px rgba(255,75,75,.3)}.cq-confirm:hover{transform:translateY(-1px)}.cq-confirm:active{transform:translateY(0)}@keyframes cqFadeIn{from{opacity:0}to{opacity:1}}@keyframes cqSlideUp{from{opacity:0;transform:translateY(24px) scale(.95)}to{opacity:1;transform:translateY(0) scale(1)}}`;
    document.head.appendChild(modalStyle);
    const showClearModal = () => { document.getElementById('cqCount').textContent = queue.length; clearModal.classList.add('show'); };
    const hideClearModal = () => clearModal.classList.remove('show');
    clearModal.querySelector('.cq-cancel').addEventListener('click', hideClearModal);
    clearModal.querySelector('.cq-backdrop').addEventListener('click', hideClearModal);
    clearModal.querySelector('.cq-confirm').addEventListener('click', () => { queue = []; currentIndex = 0; ytPlayer?.stopVideo?.(); resetPlayerUI(); updateBadges(); window.renderQueue(); hideClearModal(); });
    if (panelBtns[1]) panelBtns[1].addEventListener('click', showClearModal);

    // ── Search ──
    const searchBtn = document.querySelector('.search-btn');
    const searchInput = document.getElementById('searchInput');
    const handleSearch = async () => {
        const query = searchInput.value.trim();
        if (!query) return;
        searchBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Searching...';
        searchBtn.disabled = true;
        try {
            // Defaulting to ytsearch: if no specific provider is set by user
            const searchQuery = query.includes(':') ? query : `ytsearch:${query}`;
            const res = await fetch(`${BACKEND_URL}/api/search?q=${encodeURIComponent(searchQuery)}`);
            const data = await res.json();
            if (data.success && data.tracks?.length) {
                const wasEmpty = !queue.length;
                data.tracks.slice(0, 1).forEach(t => queue.push(t));
                updateBadges();
                if (wasEmpty) { currentIndex = 0; window.playCurrentSong(); } else window.renderQueue();
                searchInput.value = '';
            } else { alert('No tracks found. Try a different search.'); }
        } catch (e) { alert(`Cannot connect to backend server at ${BACKEND_URL}. Make sure it's running!`); }
        finally { searchBtn.innerHTML = '<i class="fas fa-search"></i> Search'; searchBtn.disabled = false; }
    };
    searchBtn.addEventListener('click', handleSearch);
    searchInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleSearch(); });

    // ── Room Modal Setup ──
    buildRoomModal();
});

// ─── Room Modal Builder ───────────────────────────────────────────────────────

function buildRoomModal() {
    // ── Hamburger menu logic ──
    const hamburger = document.getElementById('hamburgerBtn');
    const mobileDrawer = document.getElementById('mobileDrawer');
    const drawerBackdrop = document.getElementById('drawerBackdrop');
    const drawerClose = document.getElementById('drawerClose');

    function openDrawer() {
        mobileDrawer.classList.add('open');
        hamburger.classList.add('open');
        document.body.style.overflow = 'hidden';
    }
    function closeDrawer() {
        mobileDrawer.classList.remove('open');
        hamburger.classList.remove('open');
        document.body.style.overflow = '';
    }
    if (hamburger) hamburger.addEventListener('click', openDrawer);
    if (drawerClose) drawerClose.addEventListener('click', closeDrawer);
    if (drawerBackdrop) drawerBackdrop.addEventListener('click', closeDrawer);

    // Close drawer on any link inside it
    document.querySelectorAll('[data-close]').forEach(el => {
        el.addEventListener('click', closeDrawer);
    });

    // Inject room button in desktop navbar
    const navLinks = document.querySelector('.nav-links');
    if (navLinks) {
        const roomBtn = document.createElement('button');
        roomBtn.id = 'roomNavBtn';
        roomBtn.title = 'Listen Together';
        roomBtn.innerHTML = `<i class="fas fa-users"></i><span id="roomBadge" class="room-nav-badge" style="display:none">0</span>`;
        navLinks.appendChild(roomBtn);
        roomBtn.addEventListener('click', () => openRoomModal());
    }

    // Inject room button in mobile drawer
    const drawerSlot = document.getElementById('drawerRoomSlot');
    if (drawerSlot) {
        const drawerRoomBtn = document.createElement('button');
        drawerRoomBtn.className = 'drawer-room-btn';
        drawerRoomBtn.innerHTML = `<i class="fas fa-users"></i> Listen Together`;
        drawerSlot.appendChild(drawerRoomBtn);
        drawerRoomBtn.addEventListener('click', () => { closeDrawer(); openRoomModal(); });
    }

    // Toast
    const toast = document.createElement('div');
    toast.id = 'roomToast';
    toast.className = 'room-toast';
    document.body.appendChild(toast);

    // Modal HTML
    const modal = document.createElement('div');
    modal.id = 'roomModal';
    modal.innerHTML = `
    <div class="rm-backdrop"></div>
    <div class="rm-panel">
        <button class="rm-close" id="rmClose"><i class="fas fa-times"></i></button>

        <!-- Screen: Entry (create or join) -->
        <div class="rm-screen" id="rmScreenEntry">
            <div class="rm-logo"><i class="fas fa-users"></i></div>
            <h2 class="rm-title">Listen Together</h2>
            <p class="rm-sub">Create a room or join a friend's room to listen in sync.</p>
            <div class="rm-name-wrap">
                <input id="rmUsername" class="rm-input" placeholder="Your name" maxlength="20" />
            </div>
            <div class="rm-entry-btns">
                <button class="rm-btn rm-btn-primary" id="rmCreateBtn"><i class="fas fa-plus"></i> Create Room</button>
                <div class="rm-divider">or</div>
                <div class="rm-join-row">
                    <input id="rmJoinCode" class="rm-input rm-code-input" placeholder="Enter 4-digit code" maxlength="4" />
                    <button class="rm-btn rm-btn-ghost" id="rmJoinBtn"><i class="fas fa-sign-in-alt"></i> Join</button>
                </div>
            </div>
        </div>

        <!-- Screen: Room (active) -->
        <div class="rm-screen" id="rmScreenRoom" style="display:none">
            <div class="rm-room-header">
                <div class="rm-room-code-wrap">
                    <span class="rm-room-label">Room Code</span>
                    <div class="rm-room-code-row">
                        <span class="rm-room-code" id="roomCodeDisplay">----</span>
                        <button class="rm-copy-btn" id="rmCopyCode" title="Copy code"><i class="fas fa-copy"></i></button>
                    </div>
                </div>
                <div class="rm-room-info">
                    <span id="roomStatus">Connecting...</span>
                    <span class="rm-dot">•</span>
                    <span><i class="fas fa-users"></i> <span id="roomMemberCount">1</span></span>
                </div>
            </div>

            <div class="rm-members-section">
                <div class="rm-section-title">Members</div>
                <div id="roomMembersList" class="rm-members-list"></div>
            </div>

            <div class="rm-chat-section">
                <div class="rm-section-title">Chat</div>
                <div id="roomChatLog" class="rm-chat-log"></div>
                <div class="rm-chat-input-row">
                    <input id="rmChatInput" class="rm-input" placeholder="Say something..." maxlength="200" />
                    <button class="rm-btn rm-btn-primary rm-send-btn" id="rmSendChat"><i class="fas fa-paper-plane"></i></button>
                </div>
            </div>

            <div id="roomHostControls" style="display:none">
                <div class="rm-section-title">Host Controls</div>
                <button class="rm-btn rm-btn-ghost rm-full-btn" id="rmSyncNow"><i class="fas fa-sync"></i> Sync my playback to everyone</button>
            </div>

            <button class="rm-btn rm-btn-danger rm-full-btn" id="roomLeaveBtn" style="display:none;margin-top:12px"><i class="fas fa-door-open"></i> Leave Room</button>
        </div>
    </div>`;
    document.body.appendChild(modal);

    // Styles
    const s = document.createElement('style');
    s.textContent = `
    #roomNavBtn{background:transparent;border:none;color:var(--text-secondary);font-size:1.1rem;cursor:pointer;position:relative;padding:4px 8px;transition:color .2s;display:flex;align-items:center}
    #roomNavBtn:hover{color:#fff}
    .room-nav-badge{position:absolute;top:-4px;right:-2px;background:var(--accent);color:#000;font-size:.6rem;font-weight:700;width:16px;height:16px;border-radius:50%;display:flex;align-items:center;justify-content:center}
    .room-toast{position:fixed;bottom:2rem;left:50%;transform:translateX(-50%) translateY(20px);background:rgba(30,30,36,.95);border:1px solid rgba(255,255,255,.12);color:#fff;padding:.7rem 1.4rem;border-radius:12px;font-size:.88rem;opacity:0;pointer-events:none;transition:all .3s;z-index:99999;backdrop-filter:blur(12px)}
    .room-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
    .room-toast.error{border-color:rgba(255,75,75,.4);color:#ff8888}
    #roomModal{display:none;position:fixed;inset:0;z-index:9998;align-items:flex-end;justify-content:center}
    #roomModal.show{display:flex}
    .rm-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(8px);animation:cqFadeIn .2s ease}
    .rm-panel{position:relative;z-index:1;background:linear-gradient(160deg,rgba(18,18,24,.98) 0%,rgba(12,12,18,.98) 100%);border:1px solid rgba(255,255,255,.1);border-radius:24px 24px 0 0;width:100%;max-width:460px;padding:2rem;max-height:90vh;overflow-y:auto;animation:rmSlideUp .3s cubic-bezier(.34,1.2,.64,1)}
    @keyframes rmSlideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
    .rm-close{position:absolute;top:1.2rem;right:1.2rem;background:rgba(255,255,255,.07);border:none;color:rgba(255,255,255,.6);width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:.9rem;display:flex;align-items:center;justify-content:center;transition:all .2s}
    .rm-close:hover{background:rgba(255,255,255,.14);color:#fff}
    .rm-logo{width:60px;height:60px;border-radius:50%;background:rgba(0,229,255,.1);border:1px solid rgba(0,229,255,.25);display:flex;align-items:center;justify-content:center;font-size:1.6rem;color:var(--accent);margin:0 auto 1rem}
    .rm-title{text-align:center;font-size:1.4rem;font-weight:700;margin-bottom:.4rem}
    .rm-sub{text-align:center;color:var(--text-secondary);font-size:.88rem;margin-bottom:1.5rem}
    .rm-name-wrap{margin-bottom:1.2rem}
    .rm-input{width:100%;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:#fff;padding:.7rem 1rem;border-radius:10px;font-size:.95rem;outline:none;font-family:inherit;transition:border-color .2s}
    .rm-input:focus{border-color:rgba(0,229,255,.5)}
    .rm-input::placeholder{color:var(--text-secondary)}
    .rm-entry-btns{display:flex;flex-direction:column;gap:.8rem}
    .rm-btn{padding:.75rem 1.2rem;border-radius:10px;border:none;font-size:.9rem;font-weight:600;cursor:pointer;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:.5rem;font-family:inherit}
    .rm-btn-primary{background:var(--accent);color:#111}
    .rm-btn-primary:hover{background:var(--accent-hover);transform:translateY(-1px)}
    .rm-btn-ghost{background:rgba(255,255,255,.07);color:#fff;border:1px solid rgba(255,255,255,.12)}
    .rm-btn-ghost:hover{background:rgba(255,255,255,.12)}
    .rm-btn-danger{background:rgba(255,75,75,.15);color:#ff8888;border:1px solid rgba(255,75,75,.3)}
    .rm-btn-danger:hover{background:rgba(255,75,75,.25)}
    .rm-full-btn{width:100%}
    .rm-divider{text-align:center;color:var(--text-secondary);font-size:.8rem;position:relative}
    .rm-divider::before,.rm-divider::after{content:'';position:absolute;top:50%;width:42%;height:1px;background:rgba(255,255,255,.08)}
    .rm-divider::before{left:0}.rm-divider::after{right:0}
    .rm-join-row{display:flex;gap:.6rem}
    .rm-code-input{letter-spacing:.2em;font-size:1.1rem;font-weight:600;text-align:center}
    .rm-room-header{background:rgba(0,229,255,.05);border:1px solid rgba(0,229,255,.12);border-radius:14px;padding:1rem 1.2rem;margin-bottom:1.2rem}
    .rm-room-label{font-size:.7rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.1em}
    .rm-room-code-row{display:flex;align-items:center;gap:.7rem;margin-top:.2rem}
    .rm-room-code{font-size:2.2rem;font-weight:700;color:var(--accent);letter-spacing:.3em}
    .rm-copy-btn{background:rgba(0,229,255,.1);border:1px solid rgba(0,229,255,.2);color:var(--accent);width:30px;height:30px;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:.8rem;transition:all .2s}
    .rm-copy-btn:hover{background:rgba(0,229,255,.2)}
    .rm-room-info{display:flex;align-items:center;gap:.5rem;color:var(--text-secondary);font-size:.82rem;margin-top:.5rem}
    .rm-dot{opacity:.4}
    .rm-section-title{font-size:.7rem;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.1em;margin:.8rem 0 .5rem}
    .rm-members-list{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:.5rem}
    .room-member-item{display:flex;align-items:center;gap:.4rem;background:rgba(255,255,255,.05);border-radius:20px;padding:.3rem .7rem .3rem .4rem;font-size:.82rem}
    .room-member-avatar{width:22px;height:22px;border-radius:50%;background:var(--accent);color:#111;font-size:.65rem;font-weight:700;display:flex;align-items:center;justify-content:center}
    .room-host-tag{font-size:.65rem;color:var(--accent);background:rgba(0,229,255,.1);border-radius:4px;padding:.1rem .4rem}
    .rm-chat-log{height:160px;overflow-y:auto;background:rgba(0,0,0,.2);border-radius:10px;padding:.7rem;margin-bottom:.5rem;display:flex;flex-direction:column;gap:.4rem;scrollbar-width:thin}
    .rm-chat-log::-webkit-scrollbar{width:3px}
    .rm-chat-log::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:3px}
    .room-chat-msg{font-size:.82rem;color:rgba(255,255,255,.75);line-height:1.4;padding:.3rem .5rem;border-radius:8px}
    .room-chat-msg.system{color:rgba(0,229,255,.6);font-style:italic;font-size:.78rem}
    .room-chat-msg.self{background:rgba(0,229,255,.07);color:#fff}
    .rm-chat-input-row{display:flex;gap:.5rem}
    .rm-send-btn{width:42px;height:42px;padding:0;flex-shrink:0;border-radius:10px}
    `;
    document.head.appendChild(s);

    // Event wiring
    document.getElementById('rmClose').addEventListener('click', closeRoomModal);
    document.querySelector('.rm-backdrop').addEventListener('click', closeRoomModal);

    document.getElementById('rmCreateBtn').addEventListener('click', () => {
        const username = document.getElementById('rmUsername').value.trim() || 'Host';
        roomUsername = username;
        roomConnect(() => {
            roomWs.send(JSON.stringify({ type: 'create_room', username, state: { queue, currentIndex, isPlaying: false, currentTime: 0 }, roomType: 'music' }));
            // Start waiting to acquire the code naturally from websocket response to save to localStorage
            switchRoomScreen('room');
        });
    });

    document.getElementById('rmJoinBtn').addEventListener('click', () => {
        const code = document.getElementById('rmJoinCode').value.trim();
        const username = document.getElementById('rmUsername').value.trim() || 'Listener';
        if (!code || code.length !== 4) { showRoomToast('Enter a valid 4-digit room code', 'error'); return; }
        roomUsername = username;
        roomConnect(() => {
            roomWs.send(JSON.stringify({ type: 'join_room', code, username, roomType: 'music' }));
            localStorage.setItem('moon_room_code', code);
            localStorage.setItem('moon_room_username', username);
            switchRoomScreen('room');
        });
    });

    document.getElementById('rmJoinCode').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') document.getElementById('rmJoinBtn').click();
    });

    document.getElementById('rmCopyCode').addEventListener('click', () => {
        if (!roomCode) return;
        navigator.clipboard.writeText(roomCode).then(() => showRoomToast('Room code copied!')).catch(() => showRoomToast('Copy failed', 'error'));
    });

    document.getElementById('rmSendChat').addEventListener('click', sendRoomChat);
    document.getElementById('rmChatInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') sendRoomChat(); });

    document.getElementById('rmSyncNow').addEventListener('click', () => {
        roomSyncState();
        showRoomToast('Synced playback to all members!');
    });

    document.getElementById('roomLeaveBtn').addEventListener('click', () => {
        if (roomWs && roomWs.readyState === WebSocket.OPEN) {
            roomWs.send(JSON.stringify({ type: 'leave_room' }));
        }
        roomCode = null; roomIsHost = false; roomMembers = [];
        localStorage.removeItem('moon_room_code');
        localStorage.removeItem('moon_room_username');
        updateRoomUI();
        switchRoomScreen('entry');
        showRoomToast('Left the room.');
    });
}

function sendRoomChat() {
    const input = document.getElementById('rmChatInput');
    if (!input) return;
    const msg = input.value.trim();
    if (!msg || !roomWs || roomWs.readyState !== WebSocket.OPEN || !roomCode) return;
    roomWs.send(JSON.stringify({ type: 'chat', message: msg }));
    input.value = '';
}

function openRoomModal() {
    const modal = document.getElementById('roomModal');
    if (modal) modal.classList.add('show');
    if (roomCode) switchRoomScreen('room');
    else switchRoomScreen('entry');
}

function closeRoomModal() {
    const modal = document.getElementById('roomModal');
    if (modal) modal.classList.remove('show');
}

function switchRoomScreen(screen) {
    document.getElementById('rmScreenEntry').style.display = screen === 'entry' ? 'block' : 'none';
    document.getElementById('rmScreenRoom').style.display = screen === 'room' ? 'block' : 'none';
}

// ─── Movie Player Modal Logic ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const movieModal = document.getElementById('movieModal');
    const movieClose = document.getElementById('movieClose');
    const movieBackdrop = document.getElementById('movieBackdrop');
    const movieNavBtn = document.getElementById('movieNavBtn');
    const drawerMovieBtn = document.getElementById('drawerMovieBtn');
    const playMovieBtn = document.getElementById('playMovieBtn');
    const movieLinkInput = document.getElementById('movieLinkInput');
    const movieIframe = document.getElementById('movieIframe');
    const moviePlaceholder = document.getElementById('moviePlaceholder');

    const openMovieModal = (e) => {
        if (e) e.preventDefault();
        if (movieModal) movieModal.classList.add('show');
        document.body.style.overflow = 'hidden';
        if (window.ytPlayer && typeof window.ytPlayer.pauseVideo === 'function') {
            window.ytPlayer.pauseVideo();
        }
    };

    const closeMovieModal = () => {
        if (movieModal) movieModal.classList.remove('show');
        document.body.style.overflow = '';
        if (movieIframe) {
            movieIframe.src = '';
            movieIframe.style.display = 'none';
        }
        if (moviePlaceholder) moviePlaceholder.style.display = 'flex';
        if (movieLinkInput) movieLinkInput.value = '';
    };

    const playMovie = () => {
        if (!movieLinkInput) return;
        const url = movieLinkInput.value.trim();
        if (!url) return;

        if (moviePlaceholder) moviePlaceholder.style.display = 'none';
        if (movieIframe) {
            movieIframe.style.display = 'block';
            movieIframe.src = url;
        }
    };

    if (movieNavBtn) movieNavBtn.addEventListener('click', openMovieModal);
    if (drawerMovieBtn) drawerMovieBtn.addEventListener('click', (e) => {
        const mobileDrawer = document.getElementById('mobileDrawer');
        const hamburger = document.getElementById('hamburgerBtn');
        if (mobileDrawer) mobileDrawer.classList.remove('open');
        if (hamburger) hamburger.classList.remove('open');
        openMovieModal(e);
    });

    if (movieClose) movieClose.addEventListener('click', closeMovieModal);
    if (movieBackdrop) movieBackdrop.addEventListener('click', closeMovieModal);
    if (playMovieBtn) playMovieBtn.addEventListener('click', playMovie);

    if (movieLinkInput) {
        movieLinkInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') playMovie();
        });
    }
});