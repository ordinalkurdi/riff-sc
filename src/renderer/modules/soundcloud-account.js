'use strict';

// SoundCloud account: connect via OAuth, mirror hearts to SoundCloud likes,
// and pull existing SoundCloud likes into Riff favorites.
(function () {
  var api = window.electronAPI;
  var scConnected = false;
  var scBusy = false;

  var elStatus = document.getElementById('sc-account-status');
  var elLogin = document.getElementById('btn-sc-login');
  var elSync = document.getElementById('btn-sc-sync');
  var elLogout = document.getElementById('btn-sc-logout');
  var elCreds = document.getElementById('sc-account-creds');
  var elClientId = document.getElementById('sc-client-id');
  var elClientSecret = document.getElementById('sc-client-secret');
  var elRedirect = document.getElementById('sc-redirect-uri');
  var elTwoWay = document.getElementById('sc-two-way-row');

  function toast(msg, type) {
    if (typeof showToast === 'function') showToast(msg, type || 'info');
  }

  function isScTrack(track) {
    if (!track) return false;
    if (track.platform === 'soundcloud') return true;
    return /soundcloud\.com/i.test(String(track.url || ''));
  }

  function render(status) {
    scConnected = !!(status && status.loggedIn);
    if (elRedirect && status && status.redirectUri) elRedirect.textContent = status.redirectUri;
    if (elStatus) {
      if (scConnected) {
        var name = status.user && status.user.name;
        elStatus.textContent = name ? 'Connected as ' + name : 'Connected';
        elStatus.style.color = 'var(--md-sys-color-primary, #6750A4)';
      } else {
        elStatus.textContent = 'Not connected';
        elStatus.style.color = '';
      }
    }
    if (elLogin) {
      elLogin.classList.toggle('hidden', scConnected);
      elLogin.disabled = scBusy;
    }
    if (elSync) elSync.classList.toggle('hidden', !scConnected);
    if (elLogout) elLogout.classList.toggle('hidden', !scConnected);
    if (elCreds) elCreds.style.display = scConnected ? 'none' : 'flex';
    if (elTwoWay) elTwoWay.style.display = scConnected ? 'flex' : 'none';
    if (elClientId && status && status.clientId && !elClientId.value) elClientId.value = status.clientId;
  }

  async function refreshStatus() {
    if (!api || !api.soundcloudAuthStatus) return;
    try {
      render(await api.soundcloudAuthStatus());
    } catch (_) {
      render(null);
    }
  }

  async function login() {
    if (!api || !api.soundcloudLogin || scBusy) return;
    scBusy = true;
    if (elLogin) { elLogin.disabled = true; elLogin.textContent = 'Waiting for browser…'; }
    try {
      var res = await api.soundcloudLogin({
        clientId: elClientId ? elClientId.value.trim() : '',
        clientSecret: elClientSecret ? elClientSecret.value.trim() : ''
      });
      if (res && res.success) {
        if (elClientSecret) elClientSecret.value = '';
        toast('SoundCloud connected.', 'success');
      } else {
        toast((res && res.error) || 'SoundCloud sign-in failed.', 'error');
      }
    } catch (e) {
      toast('SoundCloud sign-in failed: ' + (e && e.message ? e.message : e), 'error');
    } finally {
      scBusy = false;
      if (elLogin) elLogin.textContent = 'Connect';
      await refreshStatus();
    }
  }

  async function logout() {
    if (!api || !api.soundcloudLogout) return;
    var res = await api.soundcloudLogout();
    if (res && res.success) toast(res.warning || 'SoundCloud disconnected.', res.warning ? 'info' : 'success');
    else toast((res && res.error) || 'Could not disconnect SoundCloud.', 'error');
    await refreshStatus();
  }

  // Pull SoundCloud likes -> Riff favorites (does not touch SoundCloud).
  async function syncLikesFromSoundCloud() {
    if (!api || !api.soundcloudFetchLikes || scBusy) return;
    scBusy = true;
    if (elSync) { elSync.disabled = true; elSync.textContent = 'Syncing…'; }
    try {
      var res = await api.soundcloudFetchLikes();
      if (!res || !res.success) {
        toast((res && res.error) || 'Could not load your SoundCloud likes.', 'error');
        return;
      }
      var added = 0;
      // Oldest first + unshift keeps SoundCloud's newest like on top.
      res.tracks.slice().reverse().forEach(function (track) {
        if (!state.favorites.some(function (f) { return isSameTrack(f, track); })) {
          state.favorites.unshift(typeof stampAddedAt === 'function' ? stampAddedAt(track) : track);
          added++;
        }
      });
      if (added) {
        localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites));
        if (typeof updateFavoritesBadge === 'function') updateFavoritesBadge();
        if (typeof updateFavoriteIcon === 'function') updateFavoriteIcon();
        if (state.currentView === 'favorites' && typeof renderFavoritesView === 'function') renderFavoritesView();
      }
      toast(added
        ? 'Added ' + added + ' liked song' + (added === 1 ? '' : 's') + ' from SoundCloud.'
        : 'Your favorites already include all your SoundCloud likes.', 'success');
    } catch (e) {
      toast('SoundCloud sync failed: ' + (e && e.message ? e.message : e), 'error');
    } finally {
      scBusy = false;
      if (elSync) { elSync.disabled = false; elSync.textContent = 'Sync likes'; }
    }
  }

  // Called from toggleFavoriteTrack(): mirror a heart/un-heart to SoundCloud.
  var warnedWriteFailure = false;
  window.scSyncLike = async function (track, liked) {
    if (!scConnected || !isScTrack(track) || !api || !api.soundcloudSetLike) return;
    try {
      var res = await api.soundcloudSetLike({ track: track, liked: !!liked });
      if (res && res.success) return;
      if (res && res.skipped) return;
      if (!warnedWriteFailure) {
        warnedWriteFailure = true;
        toast('Saved in Riff, but SoundCloud did not accept the like (' + ((res && res.error) || 'unknown error') + ').', 'error');
      }
    } catch (_) { /* local favorite already saved; stay silent */ }
  };

  if (elLogin) elLogin.addEventListener('click', login);
  if (elLogout) elLogout.addEventListener('click', logout);
  if (elSync) elSync.addEventListener('click', syncLikesFromSoundCloud);
  window.scRefreshStatus = refreshStatus;
  refreshStatus();
})();
