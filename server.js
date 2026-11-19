'use strict';
// KINGSMAN LABEL 1팀 LIVE status backend — YouTube Data API server.
// Requires Node.js 20+ and the YOUTUBE_API_KEY environment variable.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.YOUTUBE_API_KEY || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const API_BASE = 'https://www.googleapis.com/youtube/v3';
// Tune via Render environment variables if needed; these conservative defaults
// are shared by ALL visitors, never per visitor.
const SEARCH_DAILY_BUDGET = Math.min(90, Math.max(0, Number(process.env.SEARCH_DAILY_BUDGET ?? 10) || 0));
const UPLOADS_REFRESH_MS = Math.max(120000, Number(process.env.UPLOADS_REFRESH_MS || 1200000));
const VIDEO_REFRESH_MS = Math.max(60000, Number(process.env.VIDEO_REFRESH_MS || 180000));
const SEARCH_REFRESH_MS = SEARCH_DAILY_BUDGET ? Math.ceil(86400000 / SEARCH_DAILY_BUDGET) : Infinity;
const MAX_AGE_MS = 30 * 60000;
const BACKGROUND_TICK_MS = 30000;
const MAX_VIDEO_IDS_PER_CHANNEL = 8;
const UPLOADS_RETRY_MS = 6 * 60 * 60 * 1000; // Re-try unavailable upload playlists every 6h
const configured = JSON.parse(fs.readFileSync(path.join(__dirname, 'config/members.json'), 'utf8'));
const validId = id => /^UC[A-Za-z0-9_-]{22}$/.test(id);
const validHandle = handle => /^@[\p{L}\p{N}_.-]{3,30}$/u.test(handle);
const validVideoId = id => /^[A-Za-z0-9_-]{11}$/.test(id);
const members = configured.map((member, index) => ({
  id: String(member.id || `member_${index}`).replace(/[^a-zA-Z0-9_-]/g, ''),
  name: String(member.name || `멤버 ${index + 1}`),
  channelInput: String(member.channel || '').trim(),
  tag: String(member.tag || ''),
  channelId: null, uploadsPlaylist: null, recentUploadsFetched: false,
  uploadsUnavailable: false, uploadsRetryAt: 0,
  recentVideoIds: [], channelUrl: null,
  status: 'setup', title: '', image: '', videoId: null,
  lastCheckedAt: null, error: ''
}));
let resolveAt = 0, uploadsAt = 0, videosAt = 0, searchAt = 0;
let searchCursor = 0, fallbackSearchCursor = 0, normalSearchCursor = 0, inFlight = null, lastSyncError = '';
let searchesToday = 0, quotaDay = '', searchBlockedUntilNextDay = false;
let readQuotaBlockedUntilNextDay = false;
const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded']);

function youtubeQuotaDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const out = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${out.year}-${out.month}-${out.day}`;
}
function resetDailyBudget(now = new Date()) {
  const day = youtubeQuotaDay(now);
  if (quotaDay !== day) {
    quotaDay = day;
    searchesToday = 0;
    searchBlockedUntilNextDay = false;
    readQuotaBlockedUntilNextDay = false;
    lastSyncError = '';
  }
}
function toChannelUrl(m) {
  return m.channelId ? `https://www.youtube.com/channel/${m.channelId}` :
    validHandle(m.channelInput) ? `https://www.youtube.com/${m.channelInput}` : '';
}
function thumbnail(video) {
  const images = video?.snippet?.thumbnails || {};
  return (images.high || images.medium || images.default)?.url || '';
}
function markLive(m, video) {
  m.status = 'live';
  m.title = String(video.snippet?.title || '라이브 방송 중');
  m.image = thumbnail(video) || `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
  m.videoId = video.id; m.lastCheckedAt = new Date().toISOString(); m.error = '';
  // Preserve an active video even if it isn't in the uploads playlist yet.
  m.recentVideoIds = [video.id, ...m.recentVideoIds.filter(id => id !== video.id)].slice(0, MAX_VIDEO_IDS_PER_CHANNEL);
}
function markOffline(m) {
  m.status = 'offline'; m.title = ''; m.image = ''; m.videoId = null;
  m.lastCheckedAt = new Date().toISOString(); m.error = '';
}
function markFailure(m, message) {
  m.error = String(message || '확인 실패');
  if (!m.lastCheckedAt) m.status = 'error';
  // Never overwrite last known state with a guess after a network failure.
}
function makeApiError(data, status) {
  const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || 'API_ERROR';
  const error = new Error(`${reason}: ${data?.error?.message || `HTTP ${status}`}`);
  error.reason = reason; error.status = status; return error;
}
async function youtube(endpoint, params) {
  if (!API_KEY) throw new Error('YOUTUBE_API_KEY가 설정되지 않았습니다.');
  if (readQuotaBlockedUntilNextDay) throw new Error('오늘 YouTube API 조회 한도를 초과했습니다.');
  const url = new URL(`${API_BASE}/${endpoint}`);
  for (const [key, value] of Object.entries({ ...params, key: API_KEY })) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(18000)
  });
  let data;
  try { data = await response.json(); } catch { throw new Error('유튜브 API 응답을 읽을 수 없습니다.'); }
  if (!response.ok) {
    const err = makeApiError(data, response.status);
    if (QUOTA_REASONS.has(err.reason)) {
      if (endpoint === 'search') searchBlockedUntilNextDay = true;
      else readQuotaBlockedUntilNextDay = true;
    }
    throw err;
  }
  return data;
}
async function resolveChannels() {
  const active = members.filter(m => validId(m.channelInput) || validHandle(m.channelInput));
  for (const m of members) {
    if (!m.channelInput) { m.status = 'setup'; m.error = '유튜브 채널 주소를 등록해주세요.'; }
    else if (!active.includes(m)) { m.status = 'error'; m.error = 'UC 채널 ID 또는 @핸들을 입력하세요.'; }
  }
  const ids = [];
  for (const m of active) {
    try {
      if (validId(m.channelInput)) m.channelId = m.channelInput;
      else {
        const data = await youtube('channels', { part: 'id', forHandle: m.channelInput });
        m.channelId = data.items?.[0]?.id || null;
        if (!m.channelId) throw new Error('채널 핸들을 찾지 못했습니다.');
      }
      ids.push(m.channelId); m.channelUrl = toChannelUrl(m);
      if (m.status === 'setup' || m.status === 'error') m.status = 'checking';
      m.error = '';
    } catch (err) { m.status = 'error'; m.error = err.message; }
  }
  for (let i = 0; i < ids.length; i += 50) {
    try {
      const data = await youtube('channels', { part: 'contentDetails', id: ids.slice(i, i + 50).join(',') });
      for (const ch of data.items || []) {
        for (const m of members.filter(m => m.channelId === ch.id)) {
          m.uploadsPlaylist = ch.contentDetails?.relatedPlaylists?.uploads || null;
        }
      }
    } catch (err) {
      lastSyncError = err.message;
      for (const m of members.filter(m => ids.includes(m.channelId))) markFailure(m, err.message);
    }
  }
}
async function recentUploads() {
  const now = Date.now();
  // Some valid YouTube channels currently have no accessible uploads playlist.
  // A known playlistNotFound is not a bad handle or a fatal channel error.
  const active = members.filter(m => m.channelId && m.uploadsPlaylist && now >= m.uploadsRetryAt);
  if (!active.length) return;
  const results = await Promise.allSettled(active.map(m => youtube('playlistItems', {
    part: 'contentDetails', playlistId: m.uploadsPlaylist, maxResults: MAX_VIDEO_IDS_PER_CHANNEL
  })));
  for (let i = 0; i < results.length; i++) {
    const m = active[i], result = results[i];
    if (result.status === 'fulfilled') {
      m.uploadsUnavailable = false;
      m.uploadsRetryAt = 0;
      m.recentUploadsFetched = true;
      const fresh = (result.value.items || []).map(item => item.contentDetails?.videoId).filter(validVideoId);
      m.recentVideoIds = [...new Set([...(m.videoId ? [m.videoId] : []), ...fresh])].slice(0, MAX_VIDEO_IDS_PER_CHANNEL);
    } else if (result.reason?.reason === 'playlistNotFound') {
      // Don't repeatedly call a missing playlist every refresh cycle.
      m.uploadsUnavailable = true;
      m.uploadsRetryAt = Date.now() + UPLOADS_RETRY_MS;
      m.recentUploadsFetched = false;
      m.error = '';
      if (!m.lastCheckedAt) m.status = 'checking';
      // searchOneChannel will prioritize channels with unavailable playlists.
    } else {
      lastSyncError = result.reason.message;
      markFailure(m, result.reason.message);
    }
  }
}
async function inspectKnownVideos() {
  const candidates = [...new Set(members.flatMap(m => m.recentVideoIds))];
  if (!candidates.length) {
    for (const m of members.filter(m => m.recentUploadsFetched && m.status === 'checking')) markOffline(m);
    return;
  }
  const liveByChannel = new Map();
  let allSucceeded = true;
  for (let i = 0; i < candidates.length; i += 50) {
    try {
      const data = await youtube('videos', {
        part: 'snippet,liveStreamingDetails', id: candidates.slice(i, i + 50).join(',')
      });
      for (const video of data.items || []) {
        if (validVideoId(video.id) && video.snippet?.liveBroadcastContent === 'live') {
          const owner = video.snippet.channelId;
          if (!liveByChannel.has(owner)) liveByChannel.set(owner, video);
        }
      }
    } catch (err) { allSucceeded = false; lastSyncError = err.message; }
  }
  if (!allSucceeded) return;
  for (const m of members) {
    if (!m.channelId) continue;
    const live = liveByChannel.get(m.channelId);
    if (live) markLive(m, live);
    else if (m.status === 'live' || (m.recentUploadsFetched && ['offline', 'checking'].includes(m.status))) markOffline(m);
  }
}
async function searchOneChannel() {
  resetDailyBudget();
  const active = members.filter(m => m.channelId);
  if (!active.length || !SEARCH_DAILY_BUDGET || searchesToday >= SEARCH_DAILY_BUDGET || searchBlockedUntilNextDay || readQuotaBlockedUntilNextDay) return;
  // Spend most of the fixed search budget on channels where playlists cannot work.
  // Keep every fifth search for normal channels to catch indexing delays.
  const fallback = active.filter(m => m.uploadsUnavailable || !m.uploadsPlaylist);
  const normal = active.filter(m => !fallback.includes(m));
  const useFallback = fallback.length > 0 && (searchCursor % 5 !== 4 || !normal.length);
  const pool = useFallback ? fallback : (normal.length ? normal : fallback);
  const m = pool[useFallback ? fallbackSearchCursor++ % pool.length : normalSearchCursor++ % pool.length];
  searchCursor++;
  searchesToday++; // Even failed requests can consume quota.
  try {
    const data = await youtube('search', {
      part: 'snippet', channelId: m.channelId, eventType: 'live', type: 'video', maxResults: 5
    });
    const ids = (data.items || []).map(item => item.id?.videoId).filter(validVideoId);
    m.recentVideoIds = [...new Set([...ids, ...m.recentVideoIds])].slice(0, MAX_VIDEO_IDS_PER_CHANNEL);
    if (!ids.length) { markOffline(m); return; }
    const details = await youtube('videos', { part: 'snippet,liveStreamingDetails', id: ids.join(',') });
    const live = (details.items || []).find(v => v.snippet?.channelId === m.channelId && v.snippet?.liveBroadcastContent === 'live');
    if (live) markLive(m, live); else markOffline(m);
  } catch (err) { lastSyncError = err.message; markFailure(m, err.message); }
}
async function updateIfDue() {
  if (!API_KEY) return;
  resetDailyBudget();
  if (inFlight) return inFlight;
  const now = Date.now();
  if (resolveAt && now - uploadsAt < UPLOADS_REFRESH_MS && now - videosAt < VIDEO_REFRESH_MS && now - searchAt < SEARCH_REFRESH_MS) return;
  inFlight = (async () => {
    if (!resolveAt) { resolveAt = Date.now(); await resolveChannels(); }
    if (!uploadsAt || Date.now() - uploadsAt >= UPLOADS_REFRESH_MS) {
      uploadsAt = Date.now(); await recentUploads();
    }
    if (!videosAt || Date.now() - videosAt >= VIDEO_REFRESH_MS) {
      videosAt = Date.now(); await inspectKnownVideos();
    }
    if (SEARCH_DAILY_BUDGET && (!searchAt || Date.now() - searchAt >= SEARCH_REFRESH_MS)) {
      searchAt = Date.now(); await searchOneChannel();
    }
  })().catch(err => { lastSyncError = err.message; console.error('동기화 실패:', err.message); })
    .finally(() => { inFlight = null; });
  return inFlight;
}
function exposedMember(m) {
  const last = m.lastCheckedAt ? Date.parse(m.lastCheckedAt) : 0;
  const stale = Boolean(last && Date.now() - last > (m.uploadsUnavailable ? 60 * 60000 : MAX_AGE_MS));
  return {
    id: m.id, name: m.name, tag: m.tag,
    channelUrl: m.channelUrl || toChannelUrl(m),
    status: stale && ['live', 'offline'].includes(m.status) ? 'stale' : m.status,
    live: m.status === 'live' && !stale,
    title: m.title, image: m.image,
    videoUrl: validVideoId(m.videoId) ? `https://www.youtube.com/watch?v=${m.videoId}` : '',
    lastCheckedAt: m.lastCheckedAt,
    message: m.status === 'setup' || m.status === 'error' ? m.error :
      (stale ? '마지막 LIVE 확인 결과가 오래되었습니다.' :
        (m.uploadsUnavailable ? '업로드 목록이 없어 검색 API로 확인 중입니다. LIVE 감지가 지연될 수 있습니다.' : ''))
  };
}
function statusPayload() {
  resetDailyBudget();
  return {
    mode: !API_KEY ? 'needs_api_key' : 'connected',
    members: members.map(exposedMember), serverTime: new Date().toISOString(),
    searchesToday, searchDailyBudget: SEARCH_DAILY_BUDGET,
    nextSearchAt: Number.isFinite(SEARCH_REFRESH_MS) && searchAt ? new Date(searchAt + SEARCH_REFRESH_MS).toISOString() : null,
    lastError: lastSyncError ? '일부 채널을 최신 상태로 확인하지 못했을 수 있습니다.' : '',
    note: '업로드 목록 약 20분 간격, 알려진 영상 약 3분 간격 확인. 업로드 목록이 없는 채널은 검색 API로 우선 확인합니다.'
  };
}
function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(payload));
}
function handleHttp(req, res) {
  const method = req.method || 'GET';
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (!['GET', 'HEAD'].includes(method)) return json(res, 405, { error: 'Method Not Allowed' });
  if (pathname === '/health') return json(res, 200, { ok: true });
  if (pathname === '/api/live') {
    void updateIfDue();
    return json(res, 200, statusPayload());
  }
  let filePath;
  if (pathname === '/' || pathname === '/index.html') filePath = path.join(PUBLIC_DIR, 'index.html');
  else if (/^\/assets\/[\w.-]+\.(jpg|jpeg|png|webp|svg)$/.test(pathname)) filePath = path.join(PUBLIC_DIR, pathname.slice(1));
  else return json(res, 404, { error: 'Not Found' });
  const ext = path.extname(filePath);
  const mime = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) return json(res, 404, { error: 'Not Found' });
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
    if (method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}
const server = http.createServer(handleHttp);
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`YouTube Live Label 서버 시작: http://localhost:${PORT}`);
    console.log('API 키:', API_KEY ? '등록됨' : '미설정');
    void updateIfDue();
    // A single server-side timer: visitor count does not affect API requests.
    const timer = setInterval(() => { void updateIfDue(); }, BACKGROUND_TICK_MS);
    timer.unref();
  });
}
module.exports = { server, youtubeQuotaDay, validHandle, validId, validVideoId, exposedMember, statusPayload };
