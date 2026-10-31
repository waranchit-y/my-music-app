// ========================================================
// YT-MUSIC VAULT - CLIENT APP LOGIC
// ========================================================

const state = {
  currentTrack: null,
  queue: [],
  queueIndex: -1,
  isPlaying: false,
  isShuffle: false,
  repeatMode: 'off', // 'off' | 'all' | 'one'
  library: [],
  playlists: [],
  activePlaylist: null,
  recent: [],
  activeTheme: 'red',
  activePage: 'home',
  searchTimeout: null,
  syncedLyrics: [],
  currentLyricIndex: -1,
};

// YouTube Iframe & Dual Engine Playback State
let ytPlayer = null;
let isYtReady = false;
let playbackSource = 'yt'; // 'yt' | 'audio'
let ytProgressInterval = null;
let isVideoMode = false;
let pendingTrackId = null;

// Web Audio API & Visualizer & Karaoke
let audioCtx = null;
let analyserNode = null;
let sourceNode = null;
let vocalFilter1 = null;
let vocalFilter2 = null;
let vocalFilter3 = null;
let isKaraokeEnabled = false;
let visualizerAnimFrame = null;

// DOM Elements
const audio = document.getElementById('audio-engine');
const bgAnchor = document.getElementById('bg-audio-anchor');

// Silent Audio Anchor to maintain mobile background audio session & lock screen controls
function startBgAnchor() {
  if (bgAnchor) {
    bgAnchor.play().catch(() => {});
  }
}

function stopBgAnchor() {
  if (bgAnchor) {
    try { bgAnchor.pause(); } catch(e) {}
  }
}
const playPauseBtn = document.getElementById('btn-play-pause');
const iconPlayPause = document.getElementById('icon-play-pause');
const scrubber = document.getElementById('player-scrubber');
const timeCurrent = document.getElementById('time-current');
const timeTotal = document.getElementById('time-total');
const volumeSlider = document.getElementById('volume-slider');
const btnMute = document.getElementById('btn-mute');
const iconVolume = document.getElementById('icon-volume');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const btnShuffle = document.getElementById('btn-shuffle');
const btnRepeat = document.getElementById('btn-repeat');

// Mobile mini controls
const miniBtnPlayPause = document.getElementById('mini-btn-play-pause');
const miniIconPlayPause = document.getElementById('mini-icon-play-pause');
const miniBtnNext = document.getElementById('mini-btn-next');
const miniProgressLine = document.getElementById('mini-progress-line');

// Fullscreen Sheet Controls
const sheetScrubber = document.getElementById('sheet-player-scrubber');
const sheetTimeCurrent = document.getElementById('sheet-time-current');
const sheetTimeTotal = document.getElementById('sheet-time-total');
const sheetBtnPlayPause = document.getElementById('sheet-btn-play-pause');
const sheetIconPlayPause = document.getElementById('sheet-icon-play-pause');
const sheetBtnPrev = document.getElementById('sheet-btn-prev');
const sheetBtnNext = document.getElementById('sheet-btn-next');
const sheetBtnShuffle = document.getElementById('sheet-btn-shuffle');
const sheetBtnRepeat = document.getElementById('sheet-btn-repeat');
const sheetLikeBtn = document.getElementById('sheet-like-btn');

// Player Left
const pThumb = document.getElementById('p-thumb');
const pTitle = document.getElementById('p-title');
const pArtist = document.getElementById('p-artist');
const pLikeBtn = document.getElementById('p-like-btn');
const playerLeftPanel = document.getElementById('player-left-panel');

// Fullscreen Sheet
const fullscreenSheet = document.getElementById('fullscreen-sheet');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnCloseSheet = document.getElementById('btn-close-sheet');
const sheetArt = document.getElementById('sheet-art');
const sheetTitle = document.getElementById('sheet-title');
const sheetArtist = document.getElementById('sheet-artist');
const lyricsContainer = document.getElementById('lyrics-container');
const queueListTable = document.getElementById('queue-list-table');
const btnSheetDownload = document.getElementById('btn-sheet-download');

// Search & Pages
const searchInput = document.getElementById('main-search-input');
const clearSearchBtn = document.getElementById('clear-search-btn');
const trendingGrid = document.getElementById('trending-grid');
const searchResultsTable = document.getElementById('search-results-table');
const libraryTable = document.getElementById('library-table');
const recentList = document.getElementById('recent-list');
const sidebarSongCount = document.getElementById('sidebar-song-count');

// --------------------------------------------------------
// 1. INITIALIZATION & PWA & YOUTUBE API
// --------------------------------------------------------
function initYouTubeEngine() {
  if (ytPlayer) return;
  if (!window.YT || !window.YT.Player) {
    setTimeout(initYouTubeEngine, 100);
    return;
  }
  try {
    ytPlayer = new YT.Player('yt-player-embed', {
      height: '100%',
      width: '100%',
      playerVars: {
        autoplay: 1,
        controls: 0,
        playsinline: 1,
        rel: 0,
        modestbranding: 1,
        iv_load_policy: 3
      },
      events: {
        onReady: () => {
          isYtReady = true;
          console.log('✅ YouTube Player Engine initialized successfully!');
          if (pendingTrackId) {
            const tid = pendingTrackId;
            pendingTrackId = null;
            ytPlayer.loadVideoById(tid);
            if (ytPlayer.playVideo) ytPlayer.playVideo();
          }
        },
        onStateChange: handleYtStateChange,
        onError: (e) => {
          console.warn('YouTube Player Event:', e.data);
        }
      }
    });
  } catch(e) {
    console.error('initYouTubeEngine error:', e);
  }
}

// Handle both preloaded YT object and onYouTubeIframeAPIReady callback
if (window.YT && window.YT.Player) {
  initYouTubeEngine();
} else {
  const prevReady = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = function() {
    if (prevReady) prevReady();
    initYouTubeEngine();
  };
}

function handleYtStateChange(event) {
  // 1: PLAYING, 2: PAUSED, 0: ENDED, 3: BUFFERING
  if (event.data === 1) { // Playing
    state.isPlaying = true;
    startBgAnchor();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }
    updatePlayPauseIcon();
    startXProgressPoll();
  } else if (event.data === 2) { // Paused
    state.isPlaying = false;
    updatePlayPauseIcon();
    stopXProgressPoll();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
  } else if (event.data === 0) { // Ended
    stopXProgressPoll();
    stopBgAnchor();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none';
    }
    if (state.repeatMode === 'one') {
      ytPlayer.seekTo(0);
      ytPlayer.playVideo();
    } else {
      playNext();
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initServiceWorker();
  loadSettings();
  loadPlaylists();
  loadLibrary();
  loadTrending('thai');
  initEventListeners();
  initMediaSession();

  // Load Lucide Icons
  if (window.lucide) {
    lucide.createIcons();
  }
});

function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.log('SW registration note:', err);
    });
  }
}

// --------------------------------------------------------
// 2. THEMES & SETTINGS
// --------------------------------------------------------
function setTheme(theme) {
  state.activeTheme = theme;
  document.body.setAttribute('data-theme', theme);
  const themeLabel = document.getElementById('theme-label');
  const labels = {
    red: 'YT Red',
    cyan: 'Cyan',
    emerald: 'Emerald',
    purple: 'Violet',
    oled: 'OLED'
  };
  if (themeLabel) themeLabel.textContent = labels[theme] || 'Theme';
  localStorage.setItem('yt_theme', theme);
}

function loadSettings() {
  const savedTheme = localStorage.getItem('yt_theme') || 'red';
  setTheme(savedTheme);

  fetch('/api/settings')
    .then(r => r.json())
    .then(data => {
      if (data.theme && !localStorage.getItem('yt_theme')) {
        setTheme(data.theme);
      }
    })
    .catch(() => {});

  updateStorageInfo();
}

function updateStorageInfo() {
  fetch('/api/storage/info')
    .then(r => r.json())
    .then(info => {
      const storageUsedEl = document.getElementById('storage-total-used');
      const songCountEl = document.getElementById('storage-song-count');
      if (storageUsedEl) storageUsedEl.textContent = info.totalStorageUsed || '0 MB';
      if (songCountEl) songCountEl.textContent = info.totalSongs || '0';
    })
    .catch(() => {});
}

// --------------------------------------------------------
// 3. MEDIA SESSION API (Mobile Background & Lock Screen)
// --------------------------------------------------------
function initMediaSession() {
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => {
      startBgAnchor();
      if (playbackSource === 'yt') {
        if (ytPlayer && isYtReady && ytPlayer.playVideo) {
          try { ytPlayer.playVideo(); } catch(e) {}
        }
      } else {
        if (audio) {
          audio.play().catch(() => {});
        }
      }
      state.isPlaying = true;
      updatePlayPauseIcon();
      navigator.mediaSession.playbackState = 'playing';
    });

    navigator.mediaSession.setActionHandler('pause', () => {
      if (playbackSource === 'yt') {
        if (ytPlayer && isYtReady && ytPlayer.pauseVideo) {
          try { ytPlayer.pauseVideo(); } catch(e) {}
        }
      } else {
        if (audio) {
          audio.pause();
        }
      }
      stopBgAnchor();
      state.isPlaying = false;
      updatePlayPauseIcon();
      navigator.mediaSession.playbackState = 'paused';
    });

    navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
    navigator.mediaSession.setActionHandler('nexttrack', () => playNext());

    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime !== undefined) {
        if (playbackSource === 'yt' && ytPlayer && isYtReady && ytPlayer.seekTo) {
          try { ytPlayer.seekTo(details.seekTime, true); } catch(e) {}
        } else if (audio && audio.duration) {
          audio.currentTime = details.seekTime;
        }
      }
    });

    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
      const skipTime = details.seekOffset || 10;
      if (playbackSource === 'yt' && ytPlayer && isYtReady && ytPlayer.getCurrentTime) {
        try { ytPlayer.seekTo(Math.max(0, ytPlayer.getCurrentTime() - skipTime), true); } catch(e) {}
      } else if (audio) {
        audio.currentTime = Math.max(0, audio.currentTime - skipTime);
      }
    });

    navigator.mediaSession.setActionHandler('seekforward', (details) => {
      const skipTime = details.seekOffset || 10;
      if (playbackSource === 'yt' && ytPlayer && isYtReady && ytPlayer.getCurrentTime) {
        try { ytPlayer.seekTo(ytPlayer.getCurrentTime() + skipTime, true); } catch(e) {}
      } else if (audio) {
        audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + skipTime);
      }
    });

    navigator.mediaSession.setActionHandler('stop', () => {
      if (playbackSource === 'yt') {
        if (ytPlayer && ytPlayer.stopVideo) {
          try { ytPlayer.stopVideo(); } catch(e) {}
        }
      } else {
        if (audio) {
          audio.pause();
          audio.currentTime = 0;
        }
      }
      stopBgAnchor();
      state.isPlaying = false;
      updatePlayPauseIcon();
      navigator.mediaSession.playbackState = 'none';
    });
  }
}

function updateMediaSession(track) {
  if ('mediaSession' in navigator && track) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.channel,
      album: 'YouTube Music Vault',
      artwork: [
        { src: track.thumbnail, sizes: '96x96', type: 'image/jpeg' },
        { src: track.thumbnail, sizes: '128x128', type: 'image/jpeg' },
        { src: track.thumbnail, sizes: '256x256', type: 'image/jpeg' },
        { src: track.thumbnail, sizes: '512x512', type: 'image/jpeg' },
      ]
    });
    navigator.mediaSession.playbackState = 'playing';
  }
}

// --------------------------------------------------------
// 4. DUAL AUDIO ENGINE (YouTube Streaming + Vault Offline)
// --------------------------------------------------------

const SVG_PLAY_NORMAL = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>`;
const SVG_PAUSE_NORMAL = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;

const SVG_PLAY_BIG = `<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>`;
const SVG_PAUSE_BIG = `<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;

function updatePlayPauseIcon() {
  const isPlaying = state.isPlaying;

  const b1 = document.getElementById('btn-play-pause');
  const b2 = document.getElementById('mini-btn-play-pause');
  const b3 = document.getElementById('sheet-btn-play-pause');

  if (b1) {
    b1.innerHTML = isPlaying ? SVG_PAUSE_NORMAL : SVG_PLAY_NORMAL;
    b1.title = isPlaying ? 'หยุดเล่นชั่วคราว (Pause)' : 'เล่น (Play)';
  }
  if (b2) {
    b2.innerHTML = isPlaying ? SVG_PAUSE_NORMAL : SVG_PLAY_NORMAL;
    b2.title = isPlaying ? 'หยุดเล่นชั่วคราว (Pause)' : 'เล่น (Play)';
  }
  if (b3) {
    b3.innerHTML = isPlaying ? SVG_PAUSE_BIG : SVG_PLAY_BIG;
    b3.title = isPlaying ? 'หยุดเล่นชั่วคราว (Pause)' : 'เล่น (Play)';
  }
}

function playTrack(track, addToQueue = true) {
  if (!track || !track.id) return;

  state.currentTrack = track;

  if (addToQueue) {
    const existingIdx = state.queue.findIndex(t => t.id === track.id);
    if (existingIdx >= 0) {
      state.queueIndex = existingIdx;
    } else {
      state.queue.push(track);
      state.queueIndex = state.queue.length - 1;
    }
  }

  // Update UI Elements
  pThumb.src = track.thumbnail;
  pTitle.textContent = track.title;
  pArtist.textContent = track.channel;
  sheetArt.src = track.thumbnail;
  sheetTitle.textContent = track.title;
  sheetArtist.textContent = track.channel;

  // Dynamic Ambient Glow
  updateAmbientGlow(track.thumbnail);

  // Add to Recent List
  if (!state.recent.some(r => r.id === track.id)) {
    state.recent.unshift(track);
    if (state.recent.length > 8) state.recent.pop();
    renderRecent();
  }

  updateMediaSession(track);
  fetchLyrics(track.title, track.channel, track.id);
  fetchAiStory(track.title, track.channel);
  renderQueue();

  // Check if song is already saved in local Offline Vault
  const isDownloaded = state.library.some(lib => lib.id === track.id);

  if (isDownloaded) {
    playbackSource = 'audio';
    stopXProgressPoll();
    if (ytPlayer && isYtReady && ytPlayer.pauseVideo) {
      try { ytPlayer.pauseVideo(); } catch (e) {}
    }

    audio.src = `/api/download/file/${track.id}`;
    audio.load();

    // Try resuming Web Audio Context on play
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }

    audio.play()
      .then(() => {
        state.isPlaying = true;
        startBgAnchor();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        updatePlayPauseIcon();
        initWebAudio();
      })
      .catch(err => {
        console.warn('Audio play error:', err);
        state.isPlaying = false;
        stopBgAnchor();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
        updatePlayPauseIcon();
      });
  } else {
    // Stream directly via YouTube Player API (100% immune to bot protection / server transcoding limits)
    playbackSource = 'yt';
    try { audio.pause(); } catch(e) {}

    if (ytPlayer && isYtReady && ytPlayer.loadVideoById) {
      try {
        ytPlayer.loadVideoById(track.id);
        if (ytPlayer.playVideo) ytPlayer.playVideo();
        state.isPlaying = true;
        startBgAnchor();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        updatePlayPauseIcon();
        startXProgressPoll();
      } catch (e) {
        console.warn('ytPlayer error:', e);
      }
    } else {
      pendingTrackId = track.id;
      state.isPlaying = true;
      startBgAnchor();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      updatePlayPauseIcon();
      initYouTubeEngine();
    }
  }
}

function togglePlay() {
  if (!state.currentTrack) {
    if (state.queue.length > 0) {
      playTrack(state.queue[0]);
    }
    return;
  }

  if (playbackSource === 'yt') {
    if (ytPlayer && isYtReady) {
      if (state.isPlaying) {
        try { ytPlayer.pauseVideo(); } catch(e) {}
        state.isPlaying = false;
        stopBgAnchor();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      } else {
        try { ytPlayer.playVideo(); } catch(e) {}
        state.isPlaying = true;
        startBgAnchor();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      }
    } else {
      state.isPlaying = !state.isPlaying;
      if (state.isPlaying) {
        startBgAnchor();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      } else {
        stopBgAnchor();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      }
      initYouTubeEngine();
    }
  } else {
    if (audio.paused) {
      audio.play().catch(() => {});
      state.isPlaying = true;
      startBgAnchor();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    } else {
      audio.pause();
      state.isPlaying = false;
      stopBgAnchor();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    }
  }
  updatePlayPauseIcon();
}

function playNext() {
  if (state.queue.length === 0) return;

  if (state.isShuffle) {
    state.queueIndex = Math.floor(Math.random() * state.queue.length);
  } else {
    state.queueIndex++;
    if (state.queueIndex >= state.queue.length) {
      if (state.repeatMode === 'all') {
        state.queueIndex = 0;
      } else {
        state.queueIndex = state.queue.length - 1;
        return;
      }
    }
  }
  playTrack(state.queue[state.queueIndex], false);
}

function playPrev() {
  const cur = getCurrentPlaybackTime();
  if (cur > 4) {
    seekPlaybackTo(0);
    return;
  }
  if (state.queueIndex > 0) {
    state.queueIndex--;
    playTrack(state.queue[state.queueIndex], false);
  }
}

function getCurrentPlaybackTime() {
  if (playbackSource === 'yt' && ytPlayer && isYtReady && ytPlayer.getCurrentTime) {
    try { return ytPlayer.getCurrentTime() || 0; } catch(e) { return 0; }
  }
  return audio.currentTime || 0;
}

function seekPlaybackTo(seconds) {
  if (playbackSource === 'yt' && ytPlayer && isYtReady && ytPlayer.seekTo) {
    try { ytPlayer.seekTo(seconds, true); } catch(e) {}
  } else {
    audio.currentTime = seconds;
  }
}

// Progress Polling for YouTube Engine
function startXProgressPoll() {
  stopXProgressPoll();
  ytProgressInterval = setInterval(() => {
    if (playbackSource === 'yt' && ytPlayer && isYtReady && ytPlayer.getCurrentTime) {
      try {
        const cur = ytPlayer.getCurrentTime() || 0;
        const dur = ytPlayer.getDuration() || 0;
        updateProgressUI(cur, dur);
      } catch (e) {}
    }
  }, 200);
}

function stopXProgressPoll() {
  if (ytProgressInterval) {
    clearInterval(ytProgressInterval);
    ytProgressInterval = null;
  }
}

function updateProgressUI(currentTime, duration) {
  if (!duration || duration <= 0) return;
  const progress = (currentTime / duration) * 100;
  const formattedCur = formatDuration(currentTime);
  const formattedDur = formatDuration(duration);

  // Desktop bar
  if (scrubber) scrubber.value = progress;
  if (timeCurrent) timeCurrent.textContent = formattedCur;
  if (timeTotal) timeTotal.textContent = formattedDur;

  // Mobile / Fullscreen sheet scrubber
  if (sheetScrubber) sheetScrubber.value = progress;
  if (sheetTimeCurrent) sheetTimeCurrent.textContent = formattedCur;
  if (sheetTimeTotal) sheetTimeTotal.textContent = formattedDur;

  // Mobile mini player progress line & scrubber
  if (miniProgressLine) miniProgressLine.style.width = `${progress}%`;
  const miniScrubberRange = document.getElementById('mini-scrubber-range');
  const miniScrubberFill = document.getElementById('mini-scrubber-fill');
  if (miniScrubberRange) miniScrubberRange.value = progress;
  if (miniScrubberFill) miniScrubberFill.style.width = `${progress}%`;

  // Real-time Synced Lyrics update
  syncLyricsToTime(currentTime);

  // Sync Mobile Lock Screen Scrubber (Throttled to once every second)
  if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession && duration > 0) {
    const now = Date.now();
    if (!window._lastMediaSessionUpdate || now - window._lastMediaSessionUpdate > 1000) {
      window._lastMediaSessionUpdate = now;
      try {
        navigator.mediaSession.setPositionState({
          duration: Math.max(0, duration),
          playbackRate: 1,
          position: Math.min(Math.max(0, currentTime), duration)
        });
      } catch (e) {}
    }
  }
}

function syncLyricsToTime(curTime) {
  if (state.syncedLyrics && state.syncedLyrics.length > 0) {
    let activeIdx = -1;
    for (let i = 0; i < state.syncedLyrics.length; i++) {
      if (state.syncedLyrics[i].time <= curTime + 0.25) {
        activeIdx = i;
      } else {
        break;
      }
    }

    if (activeIdx !== state.currentLyricIndex) {
      state.currentLyricIndex = activeIdx;
      const container = document.getElementById('synced-lyrics-container');
      if (container) {
        const lines = container.querySelectorAll('.synced-lyric-line');
        lines.forEach((lineEl, idx) => {
          if (idx === activeIdx) {
            lineEl.classList.add('active');
            lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          } else {
            lineEl.classList.remove('active');
          }
        });
      }
    }
  }
}

// Scrubber Input (Seek / กอเพลง)
function handleScrub(val) {
  const pct = Math.max(0, Math.min(100, parseFloat(val))) / 100;
  if (playbackSource === 'yt' && ytPlayer && isYtReady && ytPlayer.getDuration) {
    try {
      const dur = ytPlayer.getDuration() || 0;
      if (dur > 0) ytPlayer.seekTo(pct * dur, true);
    } catch(e) {}
  } else if (playbackSource === 'audio' && audio.duration) {
    audio.currentTime = pct * audio.duration;
  }
}

if (scrubber) {
  scrubber.addEventListener('input', () => handleScrub(scrubber.value));
}
if (sheetScrubber) {
  sheetScrubber.addEventListener('input', () => handleScrub(sheetScrubber.value));
}
const miniRange = document.getElementById('mini-scrubber-range');
if (miniRange) {
  miniRange.addEventListener('input', () => {
    handleScrub(miniRange.value);
    const fill = document.getElementById('mini-scrubber-fill');
    if (fill) fill.style.width = `${miniRange.value}%`;
  });
}

// Audio Element events (for Offline / Vault tracks)
audio.addEventListener('timeupdate', () => {
  if (playbackSource === 'audio' && audio.duration) {
    updateProgressUI(audio.currentTime, audio.duration);
  }
});

audio.addEventListener('ended', () => {
  if (playbackSource === 'audio') {
    if (state.repeatMode === 'one') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } else {
      playNext();
    }
  }
});

audio.addEventListener('play', () => {
  state.isPlaying = true;
  startBgAnchor();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'playing';
  }
  updatePlayPauseIcon();
});

audio.addEventListener('pause', () => {
  if (playbackSource === 'audio') {
    state.isPlaying = false;
    stopBgAnchor();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
    updatePlayPauseIcon();
  }
});

// Mobile Visibility & Background Playback Handler
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Device screen locked or app switched to background
    if (state.isPlaying) {
      startBgAnchor();
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing';
      }
    }
  } else {
    // Device unlocked or app returned to foreground
    if (state.isPlaying) {
      if (playbackSource === 'yt' && ytPlayer && isYtReady && ytPlayer.getPlayerState) {
        try {
          const ytState = ytPlayer.getPlayerState();
          // If mobile OS paused YouTube iframe while in background, auto-resume
          if (ytState === 2 || ytState === -1) {
            ytPlayer.playVideo();
          }
        } catch (e) {}
      } else if (playbackSource === 'audio' && audio && audio.paused) {
        audio.play().catch(() => {});
      }
      startBgAnchor();
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing';
      }
    }
  }
});

// Volume
volumeSlider.addEventListener('input', () => {
  audio.volume = volumeSlider.value;
  if (audio.volume === 0) {
    iconVolume.setAttribute('data-lucide', 'volume-x');
  } else {
    iconVolume.setAttribute('data-lucide', 'volume-2');
  }
  if (window.lucide) lucide.createIcons();
});

btnMute.addEventListener('click', () => {
  audio.muted = !audio.muted;
  if (audio.muted) {
    iconVolume.setAttribute('data-lucide', 'volume-x');
  } else {
    iconVolume.setAttribute('data-lucide', 'volume-2');
  }
  if (window.lucide) lucide.createIcons();
});

// Shuffle & Repeat
btnShuffle.addEventListener('click', () => {
  state.isShuffle = !state.isShuffle;
  btnShuffle.classList.toggle('active', state.isShuffle);
});

btnRepeat.addEventListener('click', () => {
  if (state.repeatMode === 'off') {
    state.repeatMode = 'all';
    btnRepeat.classList.add('active');
    btnRepeat.title = 'เล่นซ้ำทั้งหมด';
  } else if (state.repeatMode === 'all') {
    state.repeatMode = 'one';
    btnRepeat.title = 'เล่นซ้ำเพลงเดียว';
  } else {
    state.repeatMode = 'off';
    btnRepeat.classList.remove('active');
    btnRepeat.title = 'ไม่เล่นซ้ำ';
  }
});

// --------------------------------------------------------
// 5. SEARCH & TRENDING
// --------------------------------------------------------
function searchYouTube(query) {
  if (!query) return;

  searchResultsTable.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--text-dim);">
    กำลังค้นหา "${escapeHtml(query)}" จาก YouTube...
  </div>`;
  switchPage('search');
  document.getElementById('search-title-label').textContent = `ผลการค้นหา: "${query}"`;

  fetch(`/api/search?q=${encodeURIComponent(query)}`)
    .then(r => r.json())
    .then(results => {
      renderSongList(results, searchResultsTable);
    })
    .catch(err => {
      searchResultsTable.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--accent);">
        เกิดข้อผิดพลาดในการค้นหา กรุณาลองใหม่อีกครั้ง
      </div>`;
    });
}

function loadTrending(category) {
  trendingGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-dim); padding: 40px;">กำลังโหลดเพลงแนะนำ...</div>`;

  fetch(`/api/trending?category=${category}`)
    .then(r => r.json())
    .then(items => {
      trendingGrid.innerHTML = '';
      items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'music-card';
        card.innerHTML = `
          <div class="card-thumb-wrapper">
            <img src="${item.thumbnail}" class="card-thumb" alt="cover" loading="lazy">
            <div class="card-play-overlay">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            </div>
          </div>
          <div class="card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
          <div class="card-artist">${escapeHtml(item.channel)}</div>
        `;
        card.addEventListener('click', () => {
          playTrack(item);
        });
        trendingGrid.appendChild(card);
      });
    })
    .catch(() => {
      trendingGrid.innerHTML = '<div style="color: var(--text-dim);">ไม่สามารถโหลดเพลงแนะนำได้</div>';
    });
}

// --------------------------------------------------------
// 6. DOWNLOAD & VAULT (LOCAL / CLOUD STORAGE)
// --------------------------------------------------------
function downloadSong(track, btnElement) {
  if (btnElement) {
    btnElement.classList.add('downloading');
    btnElement.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
  }

  fetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(track)
  })
    .then(r => r.json())
    .then(data => {
      pollDownloadStatus(track.id, btnElement);
    })
    .catch(() => {
      if (btnElement) {
        btnElement.classList.remove('downloading');
        btnElement.innerHTML = `<i data-lucide="download"></i>`;
        if (window.lucide) lucide.createIcons();
      }
    });
}

function pollDownloadStatus(id, btnElement) {
  const interval = setInterval(() => {
    fetch(`/api/download/status/${id}`)
      .then(r => r.json())
      .then(status => {
        if (status.status === 'done') {
          clearInterval(interval);
          if (btnElement) {
            btnElement.classList.remove('downloading');
            btnElement.classList.add('downloaded');
            btnElement.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" stroke="#10b981" stroke-width="2" fill="none"><polyline points="20 6 9 17 4 12"/></svg>`;
            btnElement.title = 'ดาวน์โหลดแล้ว (บันทึกในเครื่อง)';
          }
          loadLibrary();
        } else if (status.status === 'error') {
          clearInterval(interval);
          if (btnElement) {
            btnElement.classList.remove('downloading');
            btnElement.innerHTML = `<i data-lucide="alert-circle"></i>`;
            if (window.lucide) lucide.createIcons();
          }
        }
      })
      .catch(() => clearInterval(interval));
  }, 2000);
}

function loadLibrary() {
  fetch('/api/library')
    .then(r => r.json())
    .then(library => {
      state.library = library;
      sidebarSongCount.textContent = `${library.length} เพลงในคลัง`;
      renderLibrary();
    });
  loadPlaylists();
}

function loadPlaylists() {
  fetch('/api/playlists')
    .then(r => r.json())
    .then(playlists => {
      state.playlists = playlists;
      renderPlaylists();
    });
}

function renderPlaylists() {
  const libContainer = document.getElementById('playlists-grid');
  const homeContainer = document.getElementById('home-playlists-grid');
  const sidebarContainer = document.getElementById('sidebar-playlists-list');

  if (libContainer) libContainer.innerHTML = '';
  if (homeContainer) homeContainer.innerHTML = '';
  if (sidebarContainer) sidebarContainer.innerHTML = '';

  if (state.playlists.length === 0) {
    if (libContainer) libContainer.innerHTML = '<div style="color: var(--text-dim); padding: 24px;">ยังไม่มีเพลย์ลิสต์</div>';
    if (homeContainer) homeContainer.innerHTML = '<div style="color: var(--text-dim); padding: 12px;">ยังไม่มีเพลย์ลิสต์</div>';
    return;
  }

  state.playlists.forEach(pl => {
    // 1. Library Card
    if (libContainer) {
      const card = createPlaylistCard(pl);
      libContainer.appendChild(card);
    }

    // 2. Home Page Card
    if (homeContainer) {
      const homeCard = createPlaylistCard(pl);
      homeContainer.appendChild(homeCard);
    }

    // 3. Sidebar Link (PC)
    if (sidebarContainer) {
      const link = document.createElement('div');
      link.className = 'nav-item';
      link.style.padding = '8px 14px';
      link.style.fontSize = '0.85rem';
      link.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(pl.name)} (${pl.songs?.length || 0})</span>
      `;
      link.addEventListener('click', () => {
        openPlaylistDetail(pl);
      });
      sidebarContainer.appendChild(link);
    }
  });

  // Populate Home page showcase with songs from the main playlist
  const homeSongsList = document.getElementById('home-songs-list');
  if (homeSongsList && state.playlists[0]?.songs) {
    renderSongList(state.playlists[0].songs.slice(0, 30), homeSongsList);
  }
  const btnHomeViewAll = document.getElementById('btn-home-view-all');
  if (btnHomeViewAll && state.playlists[0]) {
    btnHomeViewAll.onclick = () => openPlaylistDetail(state.playlists[0]);
  }
}

function createPlaylistCard(pl) {
  const card = document.createElement('div');
  card.className = 'music-card';
  card.innerHTML = `
    <div class="card-thumb-wrapper">
      <img src="${pl.thumbnail || pl.songs?.[0]?.thumbnail || 'https://i.ytimg.com/vi/mw3kSNIxjqo/hqdefault.jpg'}" class="card-thumb" alt="cover" loading="lazy">
      <div class="card-play-overlay">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      </div>
    </div>
    <div class="card-title" title="${escapeHtml(pl.name)}">${escapeHtml(pl.name)}</div>
    <div class="card-artist">${pl.songs?.length || 0} เพลง • เพลย์ลิสต์</div>
  `;
  card.addEventListener('click', () => {
    openPlaylistDetail(pl);
  });
  return card;
}

function openPlaylistDetail(pl) {
  state.activePlaylist = pl;

  // Make sure we switch to library page and show detail pane
  switchPage('library');
  document.getElementById('lib-pane-playlists').style.display = 'none';
  document.getElementById('lib-pane-downloads').style.display = 'none';
  document.getElementById('lib-pane-playlist-detail').style.display = 'block';

  document.getElementById('pl-detail-name').textContent = pl.name;
  document.getElementById('pl-detail-desc').textContent = `${pl.description || ''} • รวม ${pl.songs?.length || 0} เพลง`;
  document.getElementById('pl-detail-thumb').src = pl.thumbnail || pl.songs?.[0]?.thumbnail || '';

  const table = document.getElementById('playlist-songs-table');
  renderSongList(pl.songs, table);
}

function deleteSongFromLibrary(id) {
  if (confirm('คุณต้องการลบเพลงนี้ออกจากคลังใช่หรือไม่?')) {
    fetch(`/api/library/${id}`, { method: 'DELETE' })
      .then(r => r.json())
      .then(() => {
        loadLibrary();
      });
  }
}

// --------------------------------------------------------
// 7. ADVANCED AI & AUDIO ENGINES
// --------------------------------------------------------

// A. TIME-SYNCED LYRICS PARSER & ENGINE
function parseLRC(lrcText) {
  if (!lrcText) return [];
  const lines = lrcText.split('\n');
  const result = [];
  const timeRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{2,3}))?\]/g;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let match;
    const times = [];
    timeRegex.lastIndex = 0;
    while ((match = timeRegex.exec(trimmed)) !== null) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = match[3] ? parseFloat('0.' + match[3]) : 0;
      times.push(min * 60 + sec + ms);
    }
    const cleanText = trimmed.replace(timeRegex, '').trim();
    if (times.length > 0 && cleanText) {
      times.forEach(t => {
        result.push({ time: t, text: cleanText });
      });
    }
  }

  result.sort((a, b) => a.time - b.time);
  return result;
}

function fetchLyrics(title, artist, id) {
  const syncedContainer = document.getElementById('synced-lyrics-container');
  const lyricsBadge = document.getElementById('lyrics-status-badge');
  const lyricsBadgeText = document.getElementById('lyrics-status-text');

  state.syncedLyrics = [];
  state.currentLyricIndex = -1;

  if (syncedContainer) {
    syncedContainer.innerHTML = '<div style="color: var(--text-dim); text-align: center; padding: 40px;">กำลังค้นหาและซิงก์เนื้อเพลงตรงจังหวะ...</div>';
  }

  fetch(`/api/lyrics?title=${encodeURIComponent(title || '')}&artist=${encodeURIComponent(artist || '')}&id=${encodeURIComponent(id || '')}`)
    .then(r => r.json())
    .then(data => {
      if (data.synced) {
        state.syncedLyrics = parseLRC(data.synced);
        if (lyricsBadgeText) lyricsBadgeText.textContent = 'เนื้อเพลงตรงจังหวะ (Synced Karaoke)';
        if (lyricsBadge) lyricsBadge.style.display = 'flex';

        if (syncedContainer) {
          syncedContainer.innerHTML = '';
          state.syncedLyrics.forEach((item, idx) => {
            const lineEl = document.createElement('div');
            lineEl.className = 'synced-lyric-line';
            lineEl.textContent = item.text;
            lineEl.setAttribute('data-time', item.time);
            lineEl.addEventListener('click', () => {
              audio.currentTime = item.time;
              if (audio.paused) audio.play();
            });
            syncedContainer.appendChild(lineEl);
          });
        }
      } else if (data.plain) {
        state.syncedLyrics = [];
        if (lyricsBadgeText) lyricsBadgeText.textContent = `เนื้อเพลง (${data.source || 'Standard'})`;
        if (lyricsBadge) lyricsBadge.style.display = 'flex';

        if (syncedContainer) {
          syncedContainer.innerHTML = '';
          const p = document.createElement('div');
          p.style.whiteSpace = 'pre-wrap';
          p.style.lineHeight = '2';
          p.style.fontSize = '1.05rem';
          p.style.color = 'var(--text-muted)';
          p.style.padding = '10px 16px';
          p.textContent = data.plain;
          syncedContainer.appendChild(p);
        }
      } else {
        if (lyricsBadge) lyricsBadge.style.display = 'none';
        if (syncedContainer) {
          syncedContainer.innerHTML = '<div style="color: var(--text-dim); text-align: center; padding: 40px;">ยังไม่มีเนื้อเพลงสำหรับเพลงนี้</div>';
        }
      }
    })
    .catch(() => {
      if (syncedContainer) {
        syncedContainer.innerHTML = '<div style="color: var(--text-dim); text-align: center; padding: 40px;">ไม่สามารถโหลดเนื้อเพลงได้ในขณะนี้</div>';
      }
    });
}

// B. DYNAMIC AMBIENT GLOW (COLOR EXTRACTION)
function updateAmbientGlow(thumbnailUrl) {
  const backdrop = document.getElementById('ambient-glow-backdrop');
  if (!backdrop) return;
  if (!thumbnailUrl) {
    backdrop.style.background = `radial-gradient(circle at 40% 30%, var(--accent-glow) 0%, transparent 70%)`;
    return;
  }

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = thumbnailUrl;
  img.onload = () => {
    try {
      const cvs = document.createElement('canvas');
      cvs.width = 16;
      cvs.height = 16;
      const ctx = cvs.getContext('2d');
      ctx.drawImage(img, 0, 0, 16, 16);
      const data = ctx.getImageData(8, 8, 1, 1).data;
      const rgb = `${data[0]}, ${data[1]}, ${data[2]}`;
      backdrop.style.background = `radial-gradient(circle at 40% 30%, rgba(${rgb}, 0.55) 0%, rgba(${rgb}, 0.15) 50%, transparent 75%)`;
      document.documentElement.style.setProperty('--accent-glow', `rgba(${rgb}, 0.45)`);
    } catch (e) {
      backdrop.style.background = `radial-gradient(circle at 40% 30%, var(--accent-glow) 0%, transparent 70%)`;
    }
  };
  img.onerror = () => {
    backdrop.style.background = `radial-gradient(circle at 40% 30%, var(--accent-glow) 0%, transparent 70%)`;
  };
}

// C. WEB AUDIO API VISUALIZER & KARAOKE MODE
function initWebAudio() {
  if (audioCtx) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    audioCtx = new AudioCtx();
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 64;
    analyserNode.smoothingTimeConstant = 0.8;

    sourceNode = audioCtx.createMediaElementSource(audio);
    sourceNode.connect(analyserNode);
    analyserNode.connect(audioCtx.destination);

    startVisualizerLoop();
  } catch (e) {
    console.warn('Web Audio initialization note:', e);
  }
}

function startVisualizerLoop() {
  const canvas = document.getElementById('audio-visualizer');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const bufferLength = analyserNode ? analyserNode.frequencyBinCount : 32;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    visualizerAnimFrame = requestAnimationFrame(draw);
    if (!analyserNode || !state.isPlaying) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    analyserNode.getByteFrequencyData(dataArray);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const barCount = 26;
    const barWidth = Math.floor(canvas.width / barCount) - 3;
    let x = 4;

    for (let i = 0; i < barCount; i++) {
      const val = dataArray[i] || 0;
      const barHeight = Math.max(3, (val / 255) * canvas.height * 0.95);

      const grad = ctx.createLinearGradient(0, canvas.height, 0, 0);
      grad.addColorStop(0, 'rgba(255, 255, 255, 0.2)');
      grad.addColorStop(1, 'rgba(255, 255, 255, 0.9)');

      ctx.fillStyle = grad;
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(x, canvas.height - barHeight, barWidth, barHeight, [2, 2, 0, 0]);
      } else {
        ctx.rect(x, canvas.height - barHeight, barWidth, barHeight);
      }
      ctx.fill();

      x += barWidth + 3;
    }
  }

  draw();
}

function applyWebAudioKaraoke(enable) {
  initWebAudio();
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

  if (enable) {
    if (!vocalFilter1) {
      // Stage 1: Fundamental vocal core (1000 Hz)
      vocalFilter1 = audioCtx.createBiquadFilter();
      vocalFilter1.type = 'peaking';
      vocalFilter1.frequency.value = 1000;
      vocalFilter1.Q.value = 1.8;
      vocalFilter1.gain.value = -28;

      // Stage 2: Main human voice formant (2200 Hz)
      vocalFilter2 = audioCtx.createBiquadFilter();
      vocalFilter2.type = 'peaking';
      vocalFilter2.frequency.value = 2200;
      vocalFilter2.Q.value = 2.0;
      vocalFilter2.gain.value = -32;

      // Stage 3: Consonant frequencies (3400 Hz)
      vocalFilter3 = audioCtx.createBiquadFilter();
      vocalFilter3.type = 'peaking';
      vocalFilter3.frequency.value = 3400;
      vocalFilter3.Q.value = 1.8;
      vocalFilter3.gain.value = -24;
    }
    try {
      sourceNode.disconnect();
      sourceNode.connect(vocalFilter1);
      vocalFilter1.connect(vocalFilter2);
      vocalFilter2.connect(vocalFilter3);
      vocalFilter3.connect(analyserNode);
    } catch (e) {}
  } else {
    try {
      sourceNode.disconnect();
      if (vocalFilter1) vocalFilter1.disconnect();
      if (vocalFilter2) vocalFilter2.disconnect();
      if (vocalFilter3) vocalFilter3.disconnect();
      sourceNode.connect(analyserNode);
    } catch (e) {}
  }
}

function toggleKaraoke() {
  isKaraokeEnabled = !isKaraokeEnabled;
  const btnKaraoke = document.getElementById('btn-karaoke-mode');
  if (btnKaraoke) btnKaraoke.classList.toggle('active', isKaraokeEnabled);

  if (isKaraokeEnabled) {
    // If track is in local library and currently playing via YT, seamlessly switch to high-fidelity local engine
    const isDownloaded = state.currentTrack && state.library.some(lib => lib.id === state.currentTrack.id);
    if (isDownloaded && playbackSource === 'yt') {
      const curTime = (ytPlayer && ytPlayer.getCurrentTime) ? ytPlayer.getCurrentTime() : 0;
      try { ytPlayer.pauseVideo(); } catch(e) {}
      playbackSource = 'audio';
      audio.src = `/api/download/file/${state.currentTrack.id}`;
      audio.currentTime = curTime;
      audio.play().then(() => {
        applyWebAudioKaraoke(true);
        updatePlayPauseIcon();
      }).catch(() => {});
      showToast('🎤 เปิดโหมดคาราโอเกะ: กำลังตัดเสียงร้องแบบเรียลไทม์');
    } else {
      applyWebAudioKaraoke(true);
      showToast('🎤 เปิดโหมดคาราโอเกะ: กำลังตัดเสียงร้องเรียลไทม์');
    }
  } else {
    showToast('🎵 ปิดโหมดคาราโอเกะ: เสียงต้นฉบับ');
    applyWebAudioKaraoke(false);
  }
}

function playKaraokeVersion() {
  if (!state.currentTrack) return;
  const rawTitle = state.currentTrack.title.replace(/\([^)]*\)|\[[^\]]*\]/g, '').trim();
  const searchQ = `${rawTitle} คาราโอเกะ ดนตรีเปล่า`;
  showToast('🔍 กำลังค้นหาเวอร์ชันดนตรีเปล่า...');

  fetch(`/api/search?q=${encodeURIComponent(searchQ)}`)
    .then(r => r.json())
    .then(results => {
      if (results && results.length > 0) {
        showToast('🎤 เล่นเวอร์ชันดนตรีเปล่าคาราโอเกะแล้ว!');
        playTrack(results[0], false);
      } else {
        showToast('ไม่พบเวอร์ชันดนตรีเปล่าบน YouTube');
      }
    })
    .catch(() => {
      showToast('เกิดข้อผิดพลาดในการค้นหาดนตรีเปล่า');
    });
}

function showToast(msg) {
  const toast = document.getElementById('toast-notification');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2600);
}

// D. AI STORY BEHIND THE SONG
function fetchAiStory(title, artist) {
  const storyContainer = document.getElementById('ai-story-content');
  if (!storyContainer) return;

  storyContainer.innerHTML = '<div style="color: var(--text-dim); text-align: center; padding: 40px;">กำลังวิเคราะห์เรื่องราวของเพลงด้วย AI...</div>';

  fetch(`/api/ai/story?title=${encodeURIComponent(title || '')}&artist=${encodeURIComponent(artist || '')}`)
    .then(r => r.json())
    .then(storyData => {
      storyContainer.innerHTML = `
        <div class="ai-story-card">
          <div class="ai-story-mood-pill">✨ ${escapeHtml(storyData.mood)}</div>
          <h3 style="font-size: 1.15rem; font-weight: 700; margin-bottom: 8px;">${escapeHtml(storyData.title)} - ${escapeHtml(storyData.artist)}</h3>
          <p style="font-size: 0.95rem; line-height: 1.7; color: var(--text-muted); margin-bottom: 16px;">
            ${escapeHtml(storyData.story)}
          </p>
          <div style="font-size: 0.85rem; font-weight: 600; color: var(--accent); margin-bottom: 8px;">
            💡 ไฮไลท์ทางดนตรี & ความหมาย:
          </div>
          <ul style="padding-left: 20px; font-size: 0.85rem; color: var(--text-muted); line-height: 1.7;">
            ${(storyData.highlights || []).map(h => `<li>${escapeHtml(h)}</li>`).join('')}
          </ul>
        </div>
      `;
    })
    .catch(() => {
      storyContainer.innerHTML = '<div style="color: var(--text-dim); text-align: center; padding: 40px;">ไม่สามารถวิเคราะห์เรื่องราวได้ในขณะนี้</div>';
    });
}

// E. AI DJ (SMART MOOD QUEUE)
function runAiDj(prompt) {
  if (!prompt) return;
  closeAiDjModal();

  searchResultsTable.innerHTML = `
    <div style="text-align: center; padding: 50px; color: var(--text-dim);">
      <div style="font-size: 1.1rem; color: #c084fc; font-weight: 600; margin-bottom: 8px;">✨ AI DJ กำลังจัดเพลย์ลิสต์ตามอารมณ์ให้คุณ...</div>
      <div>"${escapeHtml(prompt)}"</div>
    </div>
  `;
  switchPage('search');
  document.getElementById('search-title-label').textContent = `AI DJ: "${prompt}"`;

  fetch(`/api/ai/search?prompt=${encodeURIComponent(prompt)}`)
    .then(r => r.json())
    .then(data => {
      if (data.results && data.results.length > 0) {
        searchResultsTable.innerHTML = '';

        // Add AI Banner at top of search results
        const aiBanner = document.createElement('div');
        aiBanner.className = 'ai-story-card';
        aiBanner.style.marginBottom = '20px';
        aiBanner.innerHTML = `
          <div class="ai-story-mood-pill">✨ AI DJ MOOD MIX</div>
          <div style="font-size: 1rem; font-weight: 600; margin-bottom: 12px; color: var(--text-main);">
            ${escapeHtml(data.aiInterpretation)}
          </div>
          <button id="btn-ai-play-all" class="chip" style="background: var(--text-main); color: var(--bg-base); font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <span>เล่นเพลย์ลิสต์นี้ทันที (${data.results.length} เพลง)</span>
          </button>
        `;
        searchResultsTable.appendChild(aiBanner);

        const listContainer = document.createElement('div');
        searchResultsTable.appendChild(listContainer);
        renderSongList(data.results, listContainer);

        // Wire Play All
        const playAllBtn = document.getElementById('btn-ai-play-all');
        if (playAllBtn) {
          playAllBtn.addEventListener('click', () => {
            state.queue = [...data.results];
            state.queueIndex = 0;
            playTrack(state.queue[0], false);
          });
        }
      } else {
        searchResultsTable.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--text-dim);">ไม่พบเพลงที่ตรงกับอารมณ์นี้</div>`;
      }
    })
    .catch(() => {
      searchResultsTable.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--accent);">เกิดข้อผิดพลาดในการขอเพลงด้วย AI DJ</div>`;
    });
}

function openAiDjModal() {
  const modal = document.getElementById('modal-ai-dj');
  if (modal) modal.classList.add('active');
  const input = document.getElementById('ai-dj-prompt-input');
  if (input) setTimeout(() => input.focus(), 150);
}

function closeAiDjModal() {
  const modal = document.getElementById('modal-ai-dj');
  if (modal) modal.classList.remove('active');
}

// --------------------------------------------------------
// 8. RENDER HELPERS
// --------------------------------------------------------
function renderSongList(songs, container) {
  container.innerHTML = '';
  if (!songs || songs.length === 0) {
    container.innerHTML = '<div style="color: var(--text-dim); padding: 24px;">ไม่พบรายการเพลง</div>';
    return;
  }

  songs.forEach((song, idx) => {
    const isDownloaded = state.library.some(lib => lib.id === song.id);
    const row = document.createElement('div');
    row.className = `song-row ${state.currentTrack?.id === song.id ? 'playing' : ''}`;
    row.innerHTML = `
      <div class="col-idx">${idx + 1}</div>
      <div class="col-thumb">
        <img src="${song.thumbnail}" alt="thumb" loading="lazy">
      </div>
      <div class="col-title-artist">
        <div class="col-title">${escapeHtml(song.title)}</div>
        <div class="col-artist">${escapeHtml(song.channel)}</div>
      </div>
      <div class="col-views">${formatViews(song.views)}</div>
      <div class="col-duration">${song.durationFormatted || '3:30'}</div>
      <div class="col-actions">
        <button class="action-btn download-btn ${isDownloaded ? 'downloaded' : ''}" title="${isDownloaded ? 'อยู่ในคลังแล้ว' : 'ดาวน์โหลดเก็บไว้'}">
          ${isDownloaded ? 
            `<svg width="18" height="18" viewBox="0 0 24 24" stroke="#10b981" stroke-width="2" fill="none"><polyline points="20 6 9 17 4 12"/></svg>` : 
            `<i data-lucide="download"></i>`}
        </button>
      </div>
    `;

    // Row click -> Play
    row.addEventListener('click', (e) => {
      if (e.target.closest('.col-actions')) return;
      playTrack(song);
    });

    // Download click
    const dlBtn = row.querySelector('.download-btn');
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!isDownloaded) {
        downloadSong(song, dlBtn);
      }
    });

    container.appendChild(row);
  });

  if (window.lucide) lucide.createIcons();
}

function renderLibrary() {
  libraryTable.innerHTML = '';
  if (state.library.length === 0) {
    libraryTable.innerHTML = `<div style="text-align: center; color: var(--text-dim); padding: 48px;">
      ยังไม่มีเพลงในคลังออฟไลน์<br>
      ค้นหาเพลงและกดปุ่มดาวน์โหลดเพื่อเก็บไว้ฟังแบบไม่อั้นได้เลย!
    </div>`;
    return;
  }

  state.library.forEach((song, idx) => {
    const row = document.createElement('div');
    row.className = `song-row ${state.currentTrack?.id === song.id ? 'playing' : ''}`;
    row.innerHTML = `
      <div class="col-idx">${idx + 1}</div>
      <div class="col-thumb">
        <img src="${song.thumbnail}" alt="thumb">
      </div>
      <div class="col-title-artist">
        <div class="col-title">${escapeHtml(song.title)}</div>
        <div class="col-artist">${escapeHtml(song.channel)} • ${formatFileSize(song.fileSize)}</div>
      </div>
      <div class="col-views"><span style="color: #10b981; font-size: 0.75rem;">● ในคลัง</span></div>
      <div class="col-duration">${song.durationFormatted || '0:00'}</div>
      <div class="col-actions">
        <a href="/api/download/file/${song.id}" class="action-btn" title="บันทึกไฟล์ลงมือถือ/คอม" download>
          <i data-lucide="save"></i>
        </a>
        <button class="action-btn btn-delete-song" title="ลบออกจากคลัง">
          <i data-lucide="trash-2"></i>
        </button>
      </div>
    `;

    row.addEventListener('click', (e) => {
      if (e.target.closest('.col-actions')) return;
      playTrack(song);
    });

    const delBtn = row.querySelector('.btn-delete-song');
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSongFromLibrary(song.id);
    });

    libraryTable.appendChild(row);
  });

  if (window.lucide) lucide.createIcons();
}

function renderRecent() {
  renderSongList(state.recent, recentList);
}

function renderQueue() {
  queueListTable.innerHTML = '';
  state.queue.forEach((song, idx) => {
    const isCurrent = idx === state.queueIndex;
    const row = document.createElement('div');
    row.className = `song-row ${isCurrent ? 'playing' : ''}`;
    row.innerHTML = `
      <div class="col-idx">${idx + 1}</div>
      <div class="col-thumb">
        <img src="${song.thumbnail}" alt="thumb">
      </div>
      <div class="col-title-artist">
        <div class="col-title">${escapeHtml(song.title)}</div>
        <div class="col-artist">${escapeHtml(song.channel)}</div>
      </div>
      <div class="col-duration">${song.durationFormatted || ''}</div>
    `;
    row.addEventListener('click', () => {
      state.queueIndex = idx;
      playTrack(song, false);
    });
    queueListTable.appendChild(row);
  });
}

// --------------------------------------------------------
// 9. EVENT LISTENERS
// --------------------------------------------------------
function initEventListeners() {
  // Navigation Tabs
  document.querySelectorAll('.nav-item, .mobile-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const page = item.getAttribute('data-page');
      switchPage(page);
    });
  });

  // Library Subtabs (Playlists vs Downloads)
  document.querySelectorAll('.library-subtab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.library-subtab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.getAttribute('data-libtab');
      document.getElementById('lib-pane-playlists').style.display = tab === 'playlists' ? 'block' : 'none';
      document.getElementById('lib-pane-downloads').style.display = tab === 'downloads' ? 'block' : 'none';
      document.getElementById('lib-pane-playlist-detail').style.display = 'none';
    });
  });

  // Back to Playlists Button
  const backPlBtn = document.getElementById('btn-back-to-playlists');
  if (backPlBtn) {
    backPlBtn.addEventListener('click', () => {
      document.getElementById('lib-pane-playlist-detail').style.display = 'none';
      document.getElementById('lib-pane-playlists').style.display = 'block';
    });
  }

  // Play All Playlist Button
  const btnPlayAll = document.getElementById('btn-pl-play-all');
  if (btnPlayAll) {
    btnPlayAll.addEventListener('click', () => {
      if (state.activePlaylist && state.activePlaylist.songs?.length > 0) {
        state.queue = [...state.activePlaylist.songs];
        state.queueIndex = 0;
        playTrack(state.queue[0], false);
      }
    });
  }

  // Shuffle Playlist Button
  const btnShufflePl = document.getElementById('btn-pl-shuffle');
  if (btnShufflePl) {
    btnShufflePl.addEventListener('click', () => {
      if (state.activePlaylist && state.activePlaylist.songs?.length > 0) {
        const shuffled = [...state.activePlaylist.songs].sort(() => Math.random() - 0.5);
        state.queue = shuffled;
        state.queueIndex = 0;
        playTrack(state.queue[0], false);
      }
    });
  }

  // Refresh Playlists Button
  const refreshPlBtn = document.getElementById('refresh-playlists-btn');
  if (refreshPlBtn) {
    refreshPlBtn.addEventListener('click', loadPlaylists);
  }

  // Search input debouncing
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    if (query) {
      clearSearchBtn.style.display = 'block';
      clearTimeout(state.searchTimeout);
      state.searchTimeout = setTimeout(() => {
        searchYouTube(query);
      }, 450);
    } else {
      clearSearchBtn.style.display = 'none';
      switchPage('home');
    }
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearSearchBtn.style.display = 'none';
    switchPage('home');
  });

  // Category Chips
  document.querySelectorAll('#category-chips .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#category-chips .chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      const cat = chip.getAttribute('data-cat');
      loadTrending(cat);
    });
  });

  // Controls (Desktop & Mobile)
  playPauseBtn.addEventListener('click', togglePlay);
  btnNext.addEventListener('click', playNext);
  btnPrev.addEventListener('click', playPrev);

  // Mobile mini controls
  if (miniBtnPlayPause) miniBtnPlayPause.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePlay();
  });
  if (miniBtnNext) miniBtnNext.addEventListener('click', (e) => {
    e.stopPropagation();
    playNext();
  });

  // Fullscreen Sheet Playback Controls
  if (sheetBtnPlayPause) sheetBtnPlayPause.addEventListener('click', togglePlay);
  if (sheetBtnNext) sheetBtnNext.addEventListener('click', playNext);
  if (sheetBtnPrev) sheetBtnPrev.addEventListener('click', playPrev);

  if (sheetBtnShuffle) {
    sheetBtnShuffle.addEventListener('click', () => {
      btnShuffle.click();
      sheetBtnShuffle.classList.toggle('active', state.isShuffle);
    });
  }
  if (sheetBtnRepeat) {
    sheetBtnRepeat.addEventListener('click', () => {
      btnRepeat.click();
      sheetBtnRepeat.classList.toggle('active', state.repeatMode !== 'off');
    });
  }
  if (sheetLikeBtn) {
    sheetLikeBtn.addEventListener('click', () => {
      sheetLikeBtn.classList.toggle('liked');
      if (pLikeBtn) pLikeBtn.classList.toggle('liked', sheetLikeBtn.classList.contains('liked'));
    });
  }

  // Fullscreen Sheet Trigger
  playerLeftPanel.addEventListener('click', openFullscreen);
  btnFullscreen.addEventListener('click', openFullscreen);
  btnCloseSheet.addEventListener('click', closeFullscreen);

  const bottomPlayerEl = document.getElementById('bottom-player');
  if (bottomPlayerEl) {
    bottomPlayerEl.addEventListener('click', (e) => {
      if (e.target.closest('.mobile-mini-controls') || 
          e.target.closest('.mini-scrubber-bar') || 
          e.target.closest('.player-buttons') || 
          e.target.closest('.volume-wrapper') || 
          e.target.closest('button')) {
        return;
      }
      openFullscreen();
    });
  }

  // Sheet Tabs (Queue / Lyrics / AI Story)
  document.querySelectorAll('.sheet-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sheet-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.getAttribute('data-tab');
      document.getElementById('pane-queue').style.display = tab === 'queue' ? 'block' : 'none';
      document.getElementById('pane-lyrics').style.display = tab === 'lyrics' ? 'block' : 'none';
      const storyPane = document.getElementById('pane-story');
      if (storyPane) storyPane.style.display = tab === 'story' ? 'block' : 'none';
    });
  });

  document.getElementById('btn-open-lyrics').addEventListener('click', () => {
    openFullscreen();
    document.querySelector('.sheet-tab-btn[data-tab="lyrics"]').click();
  });

  document.getElementById('btn-open-queue').addEventListener('click', () => {
    openFullscreen();
    document.querySelector('.sheet-tab-btn[data-tab="queue"]').click();
  });

  // Mode Switcher: Song (Audio + Ambient Art) vs Video (Music Video HD)
  const btnToggleVideo = document.getElementById('btn-toggle-video-mode');
  const ytWrapper = document.getElementById('yt-player-wrapper');
  const labelMedia = document.getElementById('label-media-mode');

  if (btnToggleVideo) {
    btnToggleVideo.addEventListener('click', () => {
      isVideoMode = !isVideoMode;
      if (ytWrapper) {
        ytWrapper.style.opacity = isVideoMode ? '1' : '0';
        ytWrapper.style.pointerEvents = isVideoMode ? 'auto' : 'none';
      }
      if (labelMedia) {
        labelMedia.textContent = isVideoMode ? '🎬 โหมด MV (แสดงวิดีโอ HD)' : '🎵 โหมดเพลง (Audio)';
      }
      showToast(isVideoMode ? '🎬 สลับไปแสดง Music Video HD' : '🎵 สลับไปแสดงภาพปกอัลบั้ม');
    });
  }

  // Karaoke Mode Toggle
  const btnKaraoke = document.getElementById('btn-karaoke-mode');
  if (btnKaraoke) {
    btnKaraoke.addEventListener('click', toggleKaraoke);
  }

  // AI DJ Button & Modal
  const btnAiDj = document.getElementById('btn-ai-dj');
  const btnCloseAiDj = document.getElementById('btn-close-ai-dj');
  const modalAiDj = document.getElementById('modal-ai-dj');
  const btnSubmitAiDj = document.getElementById('btn-submit-ai-dj');
  const inputAiDj = document.getElementById('ai-dj-prompt-input');

  if (btnAiDj) {
    btnAiDj.addEventListener('click', openAiDjModal);
  }
  if (btnCloseAiDj) {
    btnCloseAiDj.addEventListener('click', closeAiDjModal);
  }
  if (modalAiDj) {
    modalAiDj.addEventListener('click', (e) => {
      if (e.target === modalAiDj) closeAiDjModal();
    });
  }

  // AI DJ preset mood tag clicks
  document.querySelectorAll('.ai-dj-tag').forEach(tag => {
    tag.addEventListener('click', () => {
      const prompt = tag.getAttribute('data-prompt');
      runAiDj(prompt);
    });
  });

  if (btnSubmitAiDj && inputAiDj) {
    btnSubmitAiDj.addEventListener('click', () => {
      runAiDj(inputAiDj.value.trim());
    });
    inputAiDj.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        runAiDj(inputAiDj.value.trim());
      }
    });
  }

  btnSheetDownload.addEventListener('click', () => {
    if (state.currentTrack) {
      downloadSong(state.currentTrack, btnSheetDownload);
    }
  });

  // Theme switch buttons in settings
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.getAttribute('data-set-theme');
      setTheme(theme);
    });
  });

  // Theme toggle button on top bar
  document.getElementById('theme-toggle-btn').addEventListener('click', () => {
    const themes = ['red', 'cyan', 'emerald', 'purple', 'oled'];
    const currentIdx = themes.indexOf(state.activeTheme);
    const nextTheme = themes[(currentIdx + 1) % themes.length];
    setTheme(nextTheme);
  });

  // Like button toggle
  pLikeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    pLikeBtn.classList.toggle('liked');
  });

  // Clean Cache button
  const cleanCacheBtn = document.getElementById('btn-clean-cache');
  if (cleanCacheBtn) {
    cleanCacheBtn.addEventListener('click', () => {
      fetch('/api/cache/clean', { method: 'POST' })
        .then(r => r.json())
        .then(res => {
          alert(`ล้างแคชเรียบร้อยแล้ว คืนพื้นที่ได้ ${res.freed}`);
          updateStorageInfo();
          loadLibrary();
        });
    });
  }

  // Refresh Library button
  const refreshBtn = document.getElementById('refresh-library-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadLibrary);
  }
}

function switchPage(page) {
  state.activePage = page;

  // Update Nav links
  document.querySelectorAll('.nav-item, .mobile-nav-item').forEach(item => {
    item.classList.toggle('active', item.getAttribute('data-page') === page);
  });

  // Show/Hide views
  document.getElementById('view-home').style.display = page === 'home' || page === 'explore' ? 'block' : 'none';
  document.getElementById('view-search').style.display = page === 'search' ? 'block' : 'none';
  document.getElementById('view-library').style.display = page === 'library' ? 'block' : 'none';
  document.getElementById('view-settings').style.display = page === 'settings' ? 'block' : 'none';

  if (page === 'library') {
    loadLibrary();
  }
}

function openFullscreen() {
  fullscreenSheet.classList.add('open');
}

function closeFullscreen() {
  fullscreenSheet.classList.remove('open');
}

// --------------------------------------------------------
// 10. UTILITIES
// --------------------------------------------------------
function formatDuration(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function formatViews(views) {
  if (!views) return '';
  if (views >= 1000000) return `${(views / 1000000).toFixed(1)}M ครั้ง`;
  if (views >= 1000) return `${(views / 1000).toFixed(1)}K ครั้ง`;
  return `${views} ครั้ง`;
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m]);
}
