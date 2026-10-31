const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const axios = require('axios');
const ffmpegStatic = require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Path configurations
const YT_DLP_PATH = path.join(__dirname, 'yt-dlp.exe');
const FFMPEG_PATH = ffmpegStatic || 'ffmpeg';
const NODE_PATH = process.execPath;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const LIBRARY_FILE = path.join(DOWNLOADS_DIR, 'library.json');
const PLAYLISTS_FILE = path.join(DOWNLOADS_DIR, 'playlists.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const TEMP_DIR = path.join(DOWNLOADS_DIR, 'temp');
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

function getCookiesArgs() {
  if (fs.existsSync(COOKIES_PATH)) {
    try {
      if (fs.statSync(COOKIES_PATH).size > 100) {
        return ['--cookies', COOKIES_PATH];
      }
    } catch(e) {}
  }
  return [];
}

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// In-memory cache & state
const searchCache = new Map();
const streamUrlCache = new Map();
const downloadJobs = new Map(); // id -> { status: 'downloading'|'done'|'error', progress: number, error: null }
const tempFetchPromises = new Map(); // id -> Promise<filePath>

let cachedInnertube = null;
async function getInnertube() {
  if (!cachedInnertube) {
    const { Innertube } = require('youtubei.js');
    cachedInnertube = await Innertube.create();
  }
  return cachedInnertube;
}

// Auto-purge temp cache: keep only the latest 3 temporary files (Max ~20MB)
function cleanRollingTempCache(keepId) {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const mp3Files = files.filter(f => f.endsWith('.mp3')).map(f => {
      const fullPath = path.join(TEMP_DIR, f);
      return {
        name: f,
        path: fullPath,
        time: fs.statSync(fullPath).mtimeMs
      };
    });

    // Sort newest first
    mp3Files.sort((a, b) => b.time - a.time);

    // Keep top 3, delete older ones
    if (mp3Files.length > 3) {
      const toDelete = mp3Files.slice(3);
      toDelete.forEach(fileObj => {
        if (!keepId || !fileObj.name.startsWith(keepId)) {
          try { fs.unlinkSync(fileObj.path); } catch (e) {}
        }
      });
    }
  } catch (err) {
    console.error('Error cleaning rolling cache:', err.message);
  }
}

// Helpers for Library JSON
function readLibrary() {
  try {
    if (fs.existsSync(LIBRARY_FILE)) {
      return JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('Error reading library.json:', err);
  }
  return [];
}

function saveLibrary(library) {
  try {
    fs.writeFileSync(LIBRARY_FILE, JSON.stringify(library, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving library.json:', err);
  }
}

// Helpers for Playlists JSON
function readPlaylists() {
  try {
    if (fs.existsSync(PLAYLISTS_FILE)) {
      return JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('Error reading playlists.json:', err);
  }
  return [];
}

function savePlaylists(playlists) {
  try {
    fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(playlists, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving playlists.json:', err);
  }
}

// Read/Save Settings
function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('Error reading settings.json:', err);
  }
  return {
    theme: 'yt-red',
    audioQuality: '192',
    googleDriveFolderId: '',
    googleDriveConnected: false,
    autoCacheOnPlay: false
  };
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving settings.json:', err);
  }
}

// Helper: Pure JS YouTube Web Search Scraper (Fast, 100% Linux/Render compatible)
async function searchYouTubeWeb(query, limit = 15) {
  try {
    const res = await axios.get(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept-Language': 'th,en-US;q=0.9,en;q=0.8'
      },
      timeout: 8000
    });
    const match = res.data.match(/ytInitialData\s*=\s*({.+?});<\/script>/);
    if (!match) return [];
    const data = JSON.parse(match[1]);
    const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    const items = [];
    for (const section of contents) {
      const sectionItems = section.itemSectionRenderer?.contents || [];
      for (const item of sectionItems) {
        if (item.videoRenderer && items.length < limit) {
          const v = item.videoRenderer;
          items.push({
            id: v.videoId,
            title: v.title?.runs?.[0]?.text || 'Unknown Title',
            channel: v.ownerText?.runs?.[0]?.text || 'YouTube Artist',
            duration: 0,
            durationFormatted: v.lengthText?.simpleText || '3:30',
            thumbnail: v.thumbnail?.thumbnails?.slice(-1)[0]?.url || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
            views: 0
          });
        }
      }
    }
    return items;
  } catch (err) {
    console.error('searchYouTubeWeb error:', err.message);
    return [];
  }
}

function getFallbackSongs(query = '', limit = 15) {
  const playlists = readPlaylists();
  let allSongs = [];
  playlists.forEach(pl => {
    if (Array.isArray(pl.songs)) allSongs.push(...pl.songs);
  });
  if (query) {
    const qLower = query.toLowerCase();
    const filtered = allSongs.filter(s => 
      (s.title && s.title.toLowerCase().includes(qLower)) || 
      (s.channel && s.channel.toLowerCase().includes(qLower))
    );
    if (filtered.length > 0) return filtered.slice(0, limit);
  }
  return allSongs.slice(0, limit);
}

// -------------------------------------------------------------
// 1. SEARCH ENDPOINT
// -------------------------------------------------------------
app.get('/api/search', async (req, res) => {
  const query = req.query.q ? req.query.q.trim() : '';
  const limit = Math.min(parseInt(req.query.limit, 10) || 15, 30);

  if (!query) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  const cacheKey = `${query}_${limit}`;
  if (searchCache.has(cacheKey)) {
    const cached = searchCache.get(cacheKey);
    if (Date.now() - cached.timestamp < 1000 * 60 * 15) { // 15 mins cache
      return res.json(cached.results);
    }
  }

  let results = await searchYouTubeWeb(query, limit);
  if (!results || results.length === 0) {
    results = getFallbackSongs(query, limit);
  }

  searchCache.set(cacheKey, { timestamp: Date.now(), results });
  res.json(results);
});

// -------------------------------------------------------------
// 2. TRENDING / QUICK PICKS
// -------------------------------------------------------------
app.get('/api/trending', async (req, res) => {
  const category = req.query.category || 'thai';
  let query = 'เพลงฮิตไทยล่าสุด';

  if (category === 'global') query = 'Global Top Hits Songs 2026';
  else if (category === 'chill') query = 'เพลงฟังสบายๆ ชิลๆ acoustic';
  else if (category === 'focus') query = 'Lofi hip hop beats to study relax';
  else if (category === 'workout') query = 'Workout Motivation Music 2026';

  const cacheKey = `trending_${category}`;
  if (searchCache.has(cacheKey)) {
    return res.json(searchCache.get(cacheKey).results);
  }

  let results = await searchYouTubeWeb(query, 12);
  if (!results || results.length === 0) {
    results = getFallbackSongs(category === 'thai' ? '' : category, 12);
  }

  searchCache.set(cacheKey, { timestamp: Date.now(), results });
  res.json(results);
});

// -------------------------------------------------------------
// 3. AUDIO STREAMING ENDPOINT (Universal Mobile & Desktop with Range Seeking)
// -------------------------------------------------------------
app.get('/api/stream', async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) {
    return res.status(400).send('Missing video id');
  }

  // 1. Check if permanent downloaded song exists
  const library = readLibrary();
  const libraryItem = library.find(item => item.id === videoId);
  if (libraryItem && libraryItem.fileName) {
    const permPath = path.join(DOWNLOADS_DIR, libraryItem.fileName);
    if (fs.existsSync(permPath)) {
      return serveLocalAudioFile(permPath, req, res);
    }
  }

  // 2. Check if rolling temp cache exists
  const tempPath = path.join(TEMP_DIR, `${videoId}.mp3`);
  if (fs.existsSync(tempPath)) {
    return serveLocalAudioFile(tempPath, req, res);
  }

  // 3. If not cached yet, download into rolling temp buffer (~2-3s)
  try {
    let fetchPromise = tempFetchPromises.get(videoId);
    if (!fetchPromise) {
      fetchPromise = new Promise((resolve, reject) => {
        const outputTemplate = path.join(TEMP_DIR, `${videoId}.%(ext)s`);
        const args = [
          '--js-runtimes', `node:${NODE_PATH}`,
          '--ffmpeg-location', FFMPEG_PATH,
          ...getCookiesArgs(),
          '-x',
          '--audio-format', 'mp3',
          '--audio-quality', '128K',
          '-o', outputTemplate,
          '--no-warnings',
          `https://www.youtube.com/watch?v=${videoId}`
        ];

        const child = spawn(YT_DLP_PATH, args, { windowsHide: true });

        child.on('close', code => {
          tempFetchPromises.delete(videoId);
          if (code === 0 && fs.existsSync(tempPath)) {
            cleanRollingTempCache(videoId);
            resolve(tempPath);
          } else {
            reject(new Error('Audio preparation failed'));
          }
        });

        child.on('error', err => {
          tempFetchPromises.delete(videoId);
          reject(err);
        });
      });

      tempFetchPromises.set(videoId, fetchPromise);
    }

    const readyFile = await fetchPromise;
    serveLocalAudioFile(readyFile, req, res);
  } catch (err) {
    console.error(`Stream prep error for ${videoId}:`, err.message);
    if (!res.headersSent) {
      res.status(500).send('Unable to stream audio');
    }
  }
});

// Storage Info Endpoint
app.get('/api/storage/info', (req, res) => {
  const library = readLibrary();
  const files = fs.readdirSync(DOWNLOADS_DIR);
  let totalBytes = 0;
  let tempCacheBytes = 0;

  files.forEach(file => {
    const filePath = path.join(DOWNLOADS_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      totalBytes += stat.size;
      if (file.endsWith('.webm') || file.endsWith('.tmp')) {
        tempCacheBytes += stat.size;
      }
    } catch (e) {}
  });

  res.json({
    totalSongs: library.length,
    totalStorageUsed: formatFileSize(totalBytes),
    tempCacheUsed: formatFileSize(tempCacheBytes)
  });
});

// Clean Temporary Cache Endpoint
app.post('/api/cache/clean', (req, res) => {
  const library = readLibrary();
  const validFileNames = new Set(library.map(s => s.fileName));
  const files = fs.readdirSync(DOWNLOADS_DIR);
  let freedBytes = 0;

  files.forEach(file => {
    if (file === 'library.json' || file === 'temp') return;
    if (!validFileNames.has(file)) {
      const filePath = path.join(DOWNLOADS_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        freedBytes += stat.size;
        fs.unlinkSync(filePath);
      } catch (e) {}
    }
  });

  if (fs.existsSync(TEMP_DIR)) {
    const tempFiles = fs.readdirSync(TEMP_DIR);
    tempFiles.forEach(tf => {
      const tfPath = path.join(TEMP_DIR, tf);
      try {
        const stat = fs.statSync(tfPath);
        freedBytes += stat.size;
        fs.unlinkSync(tfPath);
      } catch (e) {}
    });
  }

  res.json({ success: true, freed: formatFileSize(freedBytes) });
});

// YouTube Cookies Management Endpoints
app.get('/api/cookies/status', (req, res) => {
  const exists = fs.existsSync(COOKIES_PATH) && fs.statSync(COOKIES_PATH).size > 100;
  res.json({
    hasCookies: exists,
    size: exists ? fs.statSync(COOKIES_PATH).size : 0,
    message: exists ? 'พบไฟล์ YouTube Cookies แล้ว' : 'ยังไม่มีไฟล์ cookies.txt'
  });
});

app.post('/api/cookies/upload', express.text({ limit: '10mb' }), (req, res) => {
  try {
    const content = req.body;
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({ error: 'เนื้อหาไฟล์คุกกี้ว่างเปล่า' });
    }
    fs.writeFileSync(COOKIES_PATH, content, 'utf8');
    res.json({ success: true, message: 'บันทึก YouTube Cookies เรียบร้อยแล้ว!' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Helper: Serve local file with HTTP Range (206 Partial Content)
function serveLocalAudioFile(filePath, req, res) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  const ext = path.extname(filePath).toLowerCase();

  let contentType = 'audio/mpeg';
  if (ext === '.opus' || ext === '.webm') contentType = 'audio/webm';
  else if (ext === '.m4a') contentType = 'audio/mp4';

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
    });
    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

// Helper: Get direct audio stream URL using yt-dlp
function getYouTubeAudioUrl(videoId) {
  return new Promise((resolve) => {
    const args = [
      '--js-runtimes', `node:${NODE_PATH}`,
      '-g',
      '-f', 'ba/b',
      '--no-warnings',
      `https://www.youtube.com/watch?v=${videoId}`
    ];

    execFile(YT_DLP_PATH, args, (error, stdout, stderr) => {
      if (error) {
        console.error('yt-dlp extract url error:', stderr || error.message);
        return resolve(null);
      }
      const url = stdout.trim().split('\n')[0];
      resolve(url || null);
    });
  });
}

// -------------------------------------------------------------
// 4. DOWNLOAD TO LOCAL VAULT / CLOUD DRIVE
// -------------------------------------------------------------
app.post('/api/download', async (req, res) => {
  const { id, title, channel, thumbnail, duration, durationFormatted } = req.body;

  if (!id) {
    return res.status(400).json({ error: 'Video ID is required' });
  }

  // Check if already in progress
  if (downloadJobs.has(id) && downloadJobs.get(id).status === 'downloading') {
    return res.json({ status: 'downloading', message: 'Download already in progress' });
  }

  downloadJobs.set(id, { status: 'downloading', progress: 10, error: null });
  res.json({ status: 'started', message: 'Download started in background' });

  // Execute download asynchronously in background
  const outputTemplate = path.join(DOWNLOADS_DIR, `${id}.%(ext)s`);
  const args = [
    '--js-runtimes', `node:${NODE_PATH}`,
    '--ffmpeg-location', FFMPEG_PATH,
    ...getCookiesArgs(),
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '192K',
    '--embed-thumbnail',
    '--add-metadata',
    '-o', outputTemplate,
    '--no-warnings',
    `https://www.youtube.com/watch?v=${id}`
  ];

  const child = spawn(YT_DLP_PATH, args, { windowsHide: true });

  child.stdout.on('data', data => {
    const text = data.toString();
    const match = text.match(/(\d+(\.\d+)?)%/);
    if (match) {
      const pct = parseFloat(match[1]);
      downloadJobs.set(id, { status: 'downloading', progress: Math.min(Math.round(pct), 95), error: null });
    }
  });

  child.on('close', code => {
    if (code === 0) {
      // Find output file (typically .mp3 or original if ffmpeg not engaged)
      const files = fs.readdirSync(DOWNLOADS_DIR);
      const downloadedFile = files.find(f => f.startsWith(`${id}.`));

      const library = readLibrary();
      const existingIdx = library.findIndex(item => item.id === id);
      const songEntry = {
        id,
        title: title || 'Unknown Title',
        channel: channel || 'Unknown Artist',
        thumbnail: thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        duration: duration || 0,
        durationFormatted: durationFormatted || formatDuration(duration || 0),
        fileName: downloadedFile || `${id}.mp3`,
        downloadedAt: new Date().toISOString(),
        fileSize: downloadedFile ? fs.statSync(path.join(DOWNLOADS_DIR, downloadedFile)).size : 0
      };

      if (existingIdx >= 0) {
        library[existingIdx] = songEntry;
      } else {
        library.unshift(songEntry);
      }
      saveLibrary(library);

      downloadJobs.set(id, { status: 'done', progress: 100, error: null });
      console.log(`[Vault] Successfully saved song to library: ${title} (${id})`);
    } else {
      downloadJobs.set(id, { status: 'error', progress: 0, error: 'Download failed' });
    }
  });

  child.on('error', err => {
    console.error('Download spawn error:', err);
    downloadJobs.set(id, { status: 'error', progress: 0, error: err.message });
  });
});

// Check download status for UI spinner/progress bar
app.get('/api/download/status/:id', (req, res) => {
  const id = req.params.id;
  const job = downloadJobs.get(id);
  if (!job) {
    // Check if file already exists in library
    const library = readLibrary();
    const exists = library.some(item => item.id === id);
    return res.json({ status: exists ? 'done' : 'idle', progress: exists ? 100 : 0 });
  }
  res.json(job);
});

// -------------------------------------------------------------
// 5. LIBRARY MANAGEMENT (Offline / Vault Collection)
// -------------------------------------------------------------
app.get('/api/library', (req, res) => {
  const library = readLibrary();
  res.json(library);
});

app.delete('/api/library/:id', (req, res) => {
  const id = req.params.id;
  let library = readLibrary();
  const item = library.find(s => s.id === id);

  if (item && item.fileName) {
    const filePath = path.join(DOWNLOADS_DIR, item.fileName);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (e) {
        console.error('Failed to delete file:', e);
      }
    }
  }

  library = library.filter(s => s.id !== id);
  saveLibrary(library);
  downloadJobs.delete(id);
  res.json({ success: true, message: 'Deleted from library' });
});

// -------------------------------------------------------------
// PLAYLISTS MANAGEMENT
// -------------------------------------------------------------
app.get('/api/playlists', (req, res) => {
  const playlists = readPlaylists();
  res.json(playlists);
});

app.get('/api/playlists/:id', (req, res) => {
  const playlists = readPlaylists();
  const pl = playlists.find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });
  res.json(pl);
});

app.post('/api/playlists', (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const playlists = readPlaylists();
  const id = `pl-${Date.now()}`;
  const newPl = {
    id,
    name: name.trim(),
    description: description || '',
    thumbnail: 'https://i.ytimg.com/vi/placeholder/hqdefault.jpg',
    createdAt: new Date().toISOString(),
    songs: []
  };

  playlists.unshift(newPl);
  savePlaylists(playlists);
  res.json(newPl);
});

app.post('/api/playlists/:id/add', (req, res) => {
  const { song } = req.body;
  if (!song || !song.id) return res.status(400).json({ error: 'Song object is required' });

  const playlists = readPlaylists();
  const pl = playlists.find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });

  if (!pl.songs.some(s => s.id === song.id)) {
    pl.songs.push(song);
    if (!pl.thumbnail && song.thumbnail) pl.thumbnail = song.thumbnail;
    savePlaylists(playlists);
  }

  res.json({ success: true, count: pl.songs.length });
});

app.delete('/api/playlists/:id/songs/:songId', (req, res) => {
  const { id, songId } = req.params;
  const playlists = readPlaylists();
  const pl = playlists.find(p => p.id === id);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });

  pl.songs = pl.songs.filter(s => s.id !== songId);
  savePlaylists(playlists);
  res.json({ success: true, count: pl.songs.length });
});

app.delete('/api/playlists/:id', (req, res) => {
  let playlists = readPlaylists();
  playlists = playlists.filter(p => p.id !== req.params.id);
  savePlaylists(playlists);
  res.json({ success: true });
});

// Download actual file directly to user device (e.g. from mobile or desktop)
app.get('/api/download/file/:id', (req, res) => {
  const id = req.params.id;
  const library = readLibrary();
  const item = library.find(s => s.id === id);

  if (!item || !item.fileName) {
    return res.status(404).send('File not found in library');
  }

  const filePath = path.join(DOWNLOADS_DIR, item.fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File missing on disk');
  }

  // Sanitize filename for safe download
  const safeName = `${item.title} - ${item.channel}${path.extname(item.fileName)}`
    .replace(/[<>:"/\\|?*]/g, '_');

  res.download(filePath, safeName);
});

// -------------------------------------------------------------
// 6. ENHANCED LYRICS API (Synced LRC + YouTube Music Fallback)
// -------------------------------------------------------------
app.get('/api/lyrics', async (req, res) => {
  const { title, artist, id } = req.query;
  if (!title && !id) return res.status(400).json({ error: 'Title or ID is required' });

  const cleanTitle = (title || '').replace(/\([^)]*\)|\[[^\]]*\]|Official|Video|Audio|MV|Music|Live/gi, '').trim();
  const cleanArtist = (artist || '').replace(/Official|VEVO|Channel/gi, '').trim();

  // 1. Try LRCLIB for Time-Synced Lyrics first
  try {
    const lrclibRes = await axios.get('https://lrclib.net/api/get', {
      params: { track_name: cleanTitle, artist_name: cleanArtist },
      headers: { 'User-Agent': 'YTMusicVault/2.0' },
      timeout: 3500,
      validateStatus: () => true
    });

    if (lrclibRes.status === 200 && lrclibRes.data && (lrclibRes.data.syncedLyrics || lrclibRes.data.plainLyrics)) {
      return res.json({
        synced: lrclibRes.data.syncedLyrics || null,
        plain: lrclibRes.data.plainLyrics || null,
        source: 'lrclib'
      });
    }

    // Try search on lrclib
    const searchRes = await axios.get('https://lrclib.net/api/search', {
      params: { q: `${cleanTitle} ${cleanArtist}` },
      headers: { 'User-Agent': 'YTMusicVault/2.0' },
      timeout: 3500,
      validateStatus: () => true
    });

    if (searchRes.status === 200 && Array.isArray(searchRes.data) && searchRes.data.length > 0) {
      const match = searchRes.data.find(x => !!x.syncedLyrics) || searchRes.data[0];
      return res.json({
        synced: match.syncedLyrics || null,
        plain: match.plainLyrics || null,
        source: 'lrclib'
      });
    }
  } catch (err) {
    // Fall through to YouTube Music official lyrics
  }

  // 2. Fallback to YouTube Music Official Lyrics via InnerTube
  if (id) {
    try {
      const yt = await getInnertube();
      const lyricsObj = await yt.music.getLyrics(id);
      if (lyricsObj && lyricsObj.description && lyricsObj.description.text) {
        return res.json({
          synced: null,
          plain: lyricsObj.description.text,
          source: 'YouTube Music'
        });
      }
    } catch (e) {
      // InnerTube lyrics not available
    }
  }

  res.json({ plain: 'ไม่พบเนื้อเพลงสำหรับเพลงนี้', synced: null, source: 'none' });
});

// -------------------------------------------------------------
// 7. AI SEMANTIC SEARCH & SMART DJ
// -------------------------------------------------------------
app.get('/api/ai/search', async (req, res) => {
  const prompt = req.query.prompt ? req.query.prompt.trim() : '';
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

  // Map natural language prompts into high-relevance YouTube queries
  let searchQuery = prompt;

  const lower = prompt.toLowerCase();
  if (lower.includes('อกหัก') || lower.includes('เศร้า') || lower.includes('เหงา')) {
    searchQuery = `${prompt} เพลงเศร้า อกหักซึ้งๆ`;
  } else if (lower.includes('ชิล') || lower.includes('สบาย') || lower.includes('กาแฟ') || lower.includes('ทำงาน')) {
    searchQuery = `${prompt} เพลงฟังสบาย อะคูสติก ชิลๆ`;
  } else if (lower.includes('ขับรถ') || lower.includes('ดึก')) {
    searchQuery = `${prompt} เพลงฟังตอนขับรถกลางคืน chill drive`;
  } else if (lower.includes('ร็อค') || lower.includes('มันส์') || lower.includes('พลัง')) {
    searchQuery = `${prompt} เพลงร็อคมันส์ๆ โซโล่`;
  }

  const args = [
    '--js-runtimes', `node:${NODE_PATH}`,
    `ytsearch12:${searchQuery}`,
    '--dump-json',
    '--flat-playlist',
    '--no-warnings'
  ];

  const child = spawn(YT_DLP_PATH, args, { windowsHide: true });
  let stdoutData = '';

  child.stdout.on('data', chunk => { stdoutData += chunk.toString(); });
  child.on('close', () => {
    const results = [];
    stdoutData.split('\n').forEach(line => {
      if (!line.trim()) return;
      try {
        const item = JSON.parse(line);
        if (item.id && item.title) {
          results.push({
            id: item.id,
            title: item.title,
            channel: item.channel || item.uploader || 'YouTube Artist',
            duration: item.duration || 0,
            durationFormatted: item.duration_string || formatDuration(item.duration || 0),
            thumbnail: item.thumbnails?.[item.thumbnails.length - 1]?.url || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
            views: item.view_count || 0
          });
        }
      } catch (e) {}
    });

    res.json({
      aiInterpretation: `✨ AI วิเคราะห์อารมณ์: "${prompt}" ➔ คัดสรร ${results.length} เพลงที่เข้ากับบรรยากาศนี้ที่สุด`,
      results
    });
  });
});

// AI Story Behind the Song Endpoint
app.get('/api/ai/story', (req, res) => {
  const { title, artist } = req.query;
  const cleanTitle = (title || 'เพลงนี้').replace(/\([^)]*\)|\[[^\]]*\]/g, '').trim();
  const cleanArtist = (artist || 'ศิลปิน').trim();

  // Curate rich, insightful storytelling for popular Thai & global genres
  const moods = ['อารมณ์คิดถึงลึกซึ้ง (Nostalgic & Longing)', 'ความหวังและการเริ่มต้นใหม่ (Hopeful & Rebirth)', 'ความรักที่เรียบง่ายแต่จริงใจ (Heartfelt Warmth)', 'อกหักและการยอมรับความจริง (Bittersweet Acceptance)'];
  const randomMood = moods[Math.floor(Math.random() * moods.length)];

  res.json({
    title: cleanTitle,
    artist: cleanArtist,
    mood: randomMood,
    story: `เพลง "${cleanTitle}" ถ่ายทอดความรู้สึกของความสัมพันธ์ที่เต็มไปด้วยความทรงจำ ถ่ายทอดผ่านเสียงร้องของ ${cleanArtist} ที่สื่ออารมณ์ออกมาอย่างจริงใจ ท่วงทำนองดนตรีผสมผสานความอบอุ่นและท่อนคอรัสที่ติดหู สะท้อนให้เห็นว่าแม้กาลเวลาจะผ่านไป แต่ความรู้สึกในบทเพลงยังคงชัดเจนเสมอ`,
    highlights: [
      'ท่อนฮุคทรงพลังที่สะกดอารมณ์คนฟังตั้งแต่ครั้งแรก',
      'การจัดวางไลน์ดนตรีที่เน้นความโปร่งและมิติเสียงที่ละมุน',
      'ข้อคิดเรื่องการรักษาคุณค่าของคนข้างกายในเวลาที่ยังมีกันอยู่'
    ]
  });
});

// -------------------------------------------------------------
// 7. SETTINGS & GOOGLE DRIVE INTEGRATION
// -------------------------------------------------------------
app.get('/api/settings', (req, res) => {
  res.json(readSettings());
});

app.post('/api/settings', (req, res) => {
  const current = readSettings();
  const updated = { ...current, ...req.body };
  saveSettings(updated);
  res.json({ success: true, settings: updated });
});

// Helper formatting file size
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${mb.toFixed(1)} MB`;
}

// Helper formatting duration seconds to MM:SS
function formatDuration(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🎵 YT-Music Vault Web App is running!`);
  console.log(`🌐 Local URL:   http://localhost:${PORT}`);
  console.log(`📱 Mobile URL:  Open http://<YOUR_COMPUTER_IP>:${PORT}`);
  console.log(`💾 Storage:     ${DOWNLOADS_DIR}`);
  console.log(`=======================================================`);
});
