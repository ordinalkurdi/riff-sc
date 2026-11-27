'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sc = require('../src/main/soundcloud-oauth');

test('authorization URL carries PKCE params and fixed redirect', () => {
  const verifier = sc.createCodeVerifier();
  const url = new URL(sc.createAuthorizationUrl({
    clientId: 'abc', state: 'st', codeChallenge: sc.createCodeChallenge(verifier)
  }));
  assert.equal(url.origin + url.pathname, 'https://secure.soundcloud.com/authorize');
  assert.equal(url.searchParams.get('client_id'), 'abc');
  assert.equal(url.searchParams.get('redirect_uri'), sc.REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'st');
});

test('extractTrackId handles Riff track shapes', () => {
  assert.equal(sc.extractTrackId({ id: '12345' }), '12345');
  assert.equal(sc.extractTrackId({ id: 'x', url: 'https://api.soundcloud.com/tracks/777' }), '777');
  assert.equal(sc.extractTrackId({ id: 'soundcloud:tracks:42' }), '42');
  assert.equal(sc.extractTrackId({ url: 'https://soundcloud.com/a/b' }), null);
});

test('like uses POST, unlike uses DELETE, with OAuth header', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, method: opts.method, auth: opts.headers.Authorization });
    return { ok: true, status: 200, text: async () => '' };
  };
  assert.deepEqual(await sc.setTrackLiked('tok', '99', true, fakeFetch), { success: true });
  assert.deepEqual(await sc.setTrackLiked('tok', '99', false, fakeFetch), { success: true });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[1].method, 'DELETE');
  assert.equal(calls[0].url, 'https://api.soundcloud.com/likes/tracks/99');
  assert.equal(calls[0].auth, 'OAuth tok');
});

test('fetchAllLikedTracks follows next_href and maps tracks', async () => {
  const pages = [
    { collection: [{ id: 1, title: 'A', user: { username: 'U' }, duration: 61000, permalink_url: 'https://soundcloud.com/u/a' }], next_href: 'https://api.soundcloud.com/me/likes/tracks?cursor=2' },
    { collection: [{ track: { id: 2, title: 'B', user: { username: 'V' }, duration: 1000 } }], next_href: null }
  ];
  let i = 0;
  const fakeFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(pages[i++]) });
  const tracks = await sc.fetchAllLikedTracks('tok', { fetchImpl: fakeFetch });
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].duration, 61);
  assert.equal(tracks[1].artist, 'V');
  assert.equal(tracks[1].platform, 'soundcloud');
});
