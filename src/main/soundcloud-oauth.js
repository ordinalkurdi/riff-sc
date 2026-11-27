'use strict';

const crypto = require('crypto');

// SoundCloud official API: OAuth 2.1 + PKCE.
// Docs: https://developers.soundcloud.com/docs/api/guide
// NOTE: SoundCloud currently treats every client as "confidential", so a
// client_id AND client_secret (from your own registered SoundCloud app) are required.
const AUTH_URL = 'https://secure.soundcloud.com/authorize';
const TOKEN_URL = 'https://secure.soundcloud.com/oauth/token';
const API_BASE = 'https://api.soundcloud.com';

// Fixed loopback port: SoundCloud requires the redirect URI to match the one
// registered on the app EXACTLY, so a random port (like the Google flow) can't be used.
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

function createCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function createCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function createOAuthState() {
  return crypto.randomBytes(32).toString('base64url');
}

function createAuthorizationUrl({ clientId, state, codeChallenge }) {
  if (!clientId || !state || !codeChallenge) {
    throw new Error('Missing SoundCloud OAuth request parameters');
  }
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return url.toString();
}

async function requestToken(params, fetchImpl = fetch) {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json; charset=utf-8'
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30000)
  });
  let data;
  try {
    data = await response.json();
  } catch (_) {
    data = {};
  }
  if (!response.ok || !data.access_token) {
    const description = data.error_description || data.error || `HTTP ${response.status}`;
    throw new Error(`SoundCloud token request failed: ${description}`);
  }
  return data;
}

function exchangeAuthorizationCode({ clientId, clientSecret, code, codeVerifier }, fetchImpl = fetch) {
  return requestToken({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
    code
  }, fetchImpl);
}

// Refresh tokens are SINGLE-USE: always persist the new refresh_token from the response.
function refreshAccessToken({ clientId, clientSecret, refreshToken }, fetchImpl = fetch) {
  return requestToken({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken
  }, fetchImpl);
}

async function apiRequest(accessToken, method, pathOrUrl, { query, fetchImpl = fetch } = {}) {
  const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : API_BASE + pathOrUrl);
  if (query) Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const response = await fetchImpl(url.toString(), {
    method,
    headers: {
      Accept: 'application/json; charset=utf-8',
      Authorization: `OAuth ${accessToken}`
    },
    signal: AbortSignal.timeout(30000)
  });
  let data = null;
  const text = await response.text().catch(() => '');
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = text; }
  }
  return { ok: response.ok, status: response.status, data };
}

// Pull the numeric SoundCloud track id out of whatever Riff stored on the track.
function extractTrackId(track) {
  if (!track) return null;
  const candidates = [track.scId, track.id, track.url, track.webpage_url];
  for (const c of candidates) {
    if (c == null) continue;
    const s = String(c);
    if (/^\d+$/.test(s)) return s;
    let m = s.match(/soundcloud:tracks:(\d+)/i);
    if (m) return m[1];
    m = s.match(/api(?:-v2)?\.soundcloud\.com\/tracks\/(\d+)/i);
    if (m) return m[1];
  }
  return null;
}

// Fallback for tracks that only have a soundcloud.com permalink.
async function resolveTrackId(accessToken, track, fetchImpl = fetch) {
  const direct = extractTrackId(track);
  if (direct) return direct;
  const permalink = track && (track.url || track.webpage_url);
  if (!permalink || !/^https?:\/\/(?:www\.|m\.)?soundcloud\.com\//i.test(permalink)) return null;
  const res = await apiRequest(accessToken, 'GET', '/resolve', { query: { url: permalink }, fetchImpl });
  if (res.ok && res.data && res.data.id) return String(res.data.id);
  return null;
}

async function setTrackLiked(accessToken, trackId, liked, fetchImpl = fetch) {
  const res = await apiRequest(
    accessToken,
    liked ? 'POST' : 'DELETE',
    `/likes/tracks/${encodeURIComponent(trackId)}`,
    { fetchImpl }
  );
  // 200/201/204 = done. 404 on unlike = it was not liked anyway. 409 on like = already liked.
  if (res.ok || (!liked && res.status === 404) || (liked && res.status === 409)) {
    return { success: true };
  }
  return { success: false, status: res.status, error: `SoundCloud returned HTTP ${res.status}` };
}

function mapTrack(t) {
  if (!t || !t.id) return null;
  const rawThumb = t.artwork_url || (t.user && t.user.avatar_url) || '';
  return {
    id: String(t.id),
    title: t.title || 'untitled',
    artist: (t.user && (t.user.username || t.user.name)) || (t.publisher_metadata && t.publisher_metadata.artist) || 'unknown artist',
    duration: Math.round((Number(t.duration) || 0) / 1000),
    thumbnail: rawThumb ? rawThumb.replace('-large', '-t500x500') : '',
    url: t.permalink_url || `https://api.soundcloud.com/tracks/${t.id}`,
    platform: 'soundcloud'
  };
}

// Pages through GET /me/likes/tracks using linked_partitioning.
async function fetchAllLikedTracks(accessToken, { maxPages = 50, fetchImpl = fetch } = {}) {
  const out = [];
  let next = `${API_BASE}/me/likes/tracks?limit=200&linked_partitioning=true&access=playable,preview,blocked`;
  for (let page = 0; next && page < maxPages; page++) {
    const res = await apiRequest(accessToken, 'GET', next, { fetchImpl });
    if (!res.ok) throw new Error(`SoundCloud likes request failed (HTTP ${res.status})`);
    const body = res.data || {};
    const items = Array.isArray(body) ? body : (body.collection || []);
    items.forEach(item => {
      const t = mapTrack(item && item.track ? item.track : item);
      if (t) out.push(t);
    });
    next = Array.isArray(body) ? null : (body.next_href || null);
  }
  return out;
}

function getMe(accessToken, fetchImpl = fetch) {
  return apiRequest(accessToken, 'GET', '/me', { fetchImpl });
}

async function disconnect(accessToken, fetchImpl = fetch) {
  return apiRequest(accessToken, 'POST', '/disconnect', { fetchImpl });
}

module.exports = {
  REDIRECT_URI,
  REDIRECT_PORT,
  createCodeVerifier,
  createCodeChallenge,
  createOAuthState,
  createAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  extractTrackId,
  resolveTrackId,
  setTrackLiked,
  fetchAllLikedTracks,
  getMe,
  disconnect,
  mapTrack
};
