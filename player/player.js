/**
 * Browser Video Player — player page logic.
 * Loads the payload handed off via chrome.storage.session and plays the
 * video's direct URL with a full custom control surface.
 */
(() => {
  'use strict';

  const { formatTime, hashString, truncate } = window.BVP;

  const $ = (id) => document.getElementById(id);
  const video = $('video');
  const playerEl = $('player');

  const els = {
    videoTitle: $('videoTitle'), sourceNote: $('sourceNote'),
    spinner: $('spinner'), bigPlay: $('bigPlay'), bigPlayBtn: $('bigPlayBtn'),
    errorBox: $('errorBox'), errorDetail: $('errorDetail'), errorHint: $('errorHint'),
    errorSrcLink: $('errorSrcLink'), btnRetry: $('btnRetry'), btnPopout: $('btnPopout'), btnLoadOther: $('btnLoadOther'),
    endedBox: $('endedBox'), btnReplay: $('btnReplay'), btnEndedNext: $('btnEndedNext'),
    toast: $('toast'), controls: $('controls'), embedFrame: $('embedFrame'),
    progress: $('progress'), rail: $('rail'), bufferedBar: $('bufferedBar'),
    playedBar: $('playedBar'), scrubHandle: $('scrubHandle'), seekTip: $('seekTip'),
    tCur: $('tCur'), tDur: $('tDur'),
    btnPlay: $('btnPlay'), icoPlay: $('icoPlay'), icoPause: $('icoPause'),
    btnBack10: $('btnBack10'), btnFwd10: $('btnFwd10'),
    btnPrev: $('btnPrev'), btnNext: $('btnNext'),
    btnMute: $('btnMute'), icoVol: $('icoVol'), icoMuted: $('icoMuted'), volume: $('volume'),
    btnSpeed: $('btnSpeed'), speedMenu: $('speedMenu'), speedWrap: $('speedWrap'),
    btnPip: $('btnPip'), btnTheater: $('btnTheater'),
    btnFull: $('btnFull'), icoFull: $('icoFull'), icoExitFull: $('icoExitFull'),
    directLoad: $('directLoad'), directUrl: $('directUrl'), directGo: $('directGo')
  };

  const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const PENDING_KEY = 'bvp:pending';
  const POS_KEY = 'bvp:positions';
  const SET_KEY = 'bvp:settings';

  let hlsInstance = null;

  const state = {
    playlist: [], index: -1, posKey: null,
    resumeAt: null, dragging: false, wasPlaying: false,
    hideTimer: 0, singleClickTimer: 0, lastSaveAt: 0,
    speedMenuOpen: false, hasMedia: false, pageTitle: ''
  };

  const clamp = (n, a, b) => Math.min(Math.max(n, a), b);

  // ================= init =================
  init();

  async function init() {
    buildSpeedMenu();
    bindUI();
    bindVideoEvents();
    bindKeyboard();
    if (!document.pictureInPictureEnabled) els.btnPip.classList.add('hidden');
    await restoreSettings();

    const pending = await takePending();
    if (pending && Array.isArray(pending.playlist) && pending.playlist.length) {
      loadPayload(pending);
    } else {
      showDirectLoad();
    }
  }

  async function takePending() {
    try {
      const data = await chrome.storage.session.get(PENDING_KEY);
      const p = data[PENDING_KEY];
      if (p) await chrome.storage.session.remove(PENDING_KEY);
      if (!p) return null;
      if (Date.now() - (p.openedAt || 0) > 60000) return null; // stale guard
      return p;
    } catch (_) { return null; }
  }

  // ================= loading =================
  function loadPayload(p) {
    state.playlist = p.playlist;
    state.pageTitle = p.pageTitle || '';
    els.sourceNote.textContent = state.pageTitle ? 'from ' + truncate(state.pageTitle, 48) : '';
    const idx = clamp(Number(p.index) || 0, 0, state.playlist.length - 1);
    showPlayerChrome();
    loadIndex(idx, { resumeAt: state.playlist[idx].currentTime || 0 });
  }

  function loadIndex(i, opts = {}) {
    const item = state.playlist[i];
    if (!item) return;
    state.index = i;
    state.hasMedia = false;
    state.posKey = posKeyFor(item, i);
    state.resumeAt = opts.resumeAt ?? null;

    if (hlsInstance) {
      try { hlsInstance.destroy(); } catch (_) {}
      hlsInstance = null;
    }

    hideOverlay('error'); hideOverlay('ended'); hideOverlay('bigPlay');
    setTitle(item);
    updatePrevNext();
    updateProgress();
    els.bufferedBar.style.width = '0%';

    if (!item.url) { showFatal('none', item); return; }

    if (item.kind === 'embed') {
      video.classList.add('hidden');
      if (els.embedFrame) {
        els.embedFrame.classList.remove('hidden');
        els.embedFrame.src = item.url;
      }
      showSpinner(false);
      state.hasMedia = true;
      showToast('Playing platform embed');
      return;
    }

    video.classList.remove('hidden');
    if (els.embedFrame) {
      els.embedFrame.classList.add('hidden');
      els.embedFrame.src = 'about:blank';
    }

    if (item.kind === 'stream' || item.url.startsWith('blob:')) { showFatal('stream', item); return; }

    showSpinner(true);
    if (item.poster) video.poster = item.poster;

    const isHls = item.kind === 'hls' || item.url.includes('.m3u8');
    if (isHls && window.Hls && Hls.isSupported()) {
      hlsInstance = new Hls({ enableWorker: true, lowLatencyMode: true });
      hlsInstance.loadSource(item.url);
      hlsInstance.attachMedia(video);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        showSpinner(false);
        tryAutoplay();
      });
      hlsInstance.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          showSpinner(false);
          onVideoError();
        }
      });
    } else {
      video.src = item.url;
      video.load();
      tryAutoplay();
    }
  }

  function posKeyFor(item, i) {
    return 'p:' + hashString(item.url || (state.pageTitle + '#' + i));
  }

  function setTitle(item) {
    els.videoTitle.textContent = item.label || 'Untitled video';
    document.title = (item.label || 'Video') + ' — Browser Video Player';
  }

  function showPlayerChrome() {
    els.directLoad.classList.add('hidden');
    playerEl.classList.remove('hidden');
  }

  function showDirectLoad() {
    playerEl.classList.add('hidden');
    els.directLoad.classList.remove('hidden');
  }

  async function tryAutoplay() {
    try {
      await video.play();
    } catch (_) {
      // Autoplay with sound is often blocked for API-opened tabs.
      try {
        video.muted = true;
        await video.play();
        showToast('Autoplay was muted by the browser — press M or click to unmute', 4200);
        document.addEventListener('click', function unmute() {
          if (video.muted) { video.muted = false; }
          document.removeEventListener('click', unmute);
        });
      } catch (_2) {
        showOverlay('bigPlay'); // needs an explicit user gesture
      }
    }
  }

  // ================= overlays =================
  function showOverlay(name) {
    const map = { spinner: els.spinner, bigPlay: els.bigPlay, error: els.errorBox, ended: els.endedBox };
    Object.entries(map).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
  }
  function hideOverlay(name) {
    const map = { spinner: els.spinner, bigPlay: els.bigPlay, error: els.errorBox, ended: els.endedBox };
    if (map[name]) map[name].classList.add('hidden');
  }
  function showSpinner(on) { els.spinner.classList.toggle('hidden', !on); }

  function showFatal(kind, item) {
    showSpinner(false);
    els.errorBox.classList.remove('hidden');
    if (kind === 'stream' || kind === 'none') {
      els.errorDetail.textContent = kind === 'none'
        ? 'This video exposes no direct media URL.'
        : 'This video doesn’t expose a direct media URL.';
      els.errorHint.textContent =
        'It is most likely streamed with MediaSource Extensions or DRM (YouTube, Netflix, ' +
        'most live/embedded players). Those streams only play inside the original page, so the ' +
        'extension player cannot replay them. Videos with a direct file URL (mp4, webm, ogg, ' +
        'hls .m3u8 only where natively supported) work.';
      els.errorSrcLink.classList.add('hidden');
      els.btnRetry.classList.add('hidden');
    } else {
      els.errorSrcLink.classList.remove('hidden');
      els.btnRetry.classList.remove('hidden');
      els.errorSrcLink.href = item.url;
    }
  }

  let toastTimer = 0;
  function showToast(text, ms = 2200) {
    els.toast.textContent = text;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
  }

  // ================= video events =================
  function bindVideoEvents() {
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('play', () => { setPlayIcon(true); hideOverlay('bigPlay'); hideOverlay('ended'); scheduleHide(); });
    video.addEventListener('playing', () => { state.hasMedia = true; showSpinner(false); setPlayIcon(true); });
    video.addEventListener('canplay', () => showSpinner(false));
    video.addEventListener('seeked', () => showSpinner(false));
    video.addEventListener('waiting', () => { if (!video.paused) showSpinner(true); });
    video.addEventListener('pause', () => { setPlayIcon(false); showControlsNow(); persistPosition(true); });
    video.addEventListener('timeupdate', () => { if (!state.dragging) updateProgress(); persistPosition(); });
    video.addEventListener('progress', updateBuffered);
    video.addEventListener('durationchange', () => { updateDuration(); updateProgress(); });
    video.addEventListener('volumechange', syncVolumeUI);
    video.addEventListener('ratechange', syncSpeedUI);
    video.addEventListener('ended', () => { persistPosition(true); showOverlay('ended'); showControlsNow(); });
    video.addEventListener('error', onVideoError);
    video.addEventListener('enterpictureinpicture', syncPipUI);
    video.addEventListener('leavepictureinpicture', syncPipUI);
    document.addEventListener('fullscreenchange', syncFullUI);
    window.addEventListener('pagehide', () => persistPosition(true));
  }

  async function onLoadedMetadata() {
    state.hasMedia = true;
    updateDuration();
    let t = state.resumeAt; state.resumeAt = null;
    const saved = await getPosition(state.posKey);
    const cand = Math.max(t || 0, saved || 0);
    if (cand > 4 && Number.isFinite(video.duration) && cand < video.duration - 8) {
      video.currentTime = cand;
      showToast('Resumed at ' + formatTime(cand));
    }
  }

  function onVideoError() {
    if (!video.getAttribute('src') && !video.currentSrc) return;
    showSpinner(false);
    const err = video.error;
    let detail = 'The video source may not be supported inside the extension player.';
    if (err) {
      switch (err.code) {
        case MediaError.MEDIA_ERR_ABORTED: detail = 'Loading was aborted.'; break;
        case MediaError.MEDIA_ERR_NETWORK: detail = 'A network error occurred while fetching the video. The host may block playback outside its own site.'; break;
        case MediaError.MEDIA_ERR_DECODE: detail = 'The video data could not be decoded.'; break;
        case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: detail = 'This format is not supported here, or the server refused to serve it to the extension player.'; break;
      }
    }
    els.errorDetail.textContent = detail;
    els.errorHint.textContent = 'Some servers only allow playback when the request comes from their own page (referrer or cookie checks). That cannot be bypassed safely.';
    showFatal('media', state.playlist[state.index] || { url: video.currentSrc });
  }

  // ================= progress / seeking =================
  function seekable() { return state.hasMedia && Number.isFinite(video.duration) && video.duration > 0; }

  function updateDuration() {
    const d = video.duration;
    els.tDur.textContent = Number.isFinite(d) ? formatTime(d) : '—';
    els.progress.setAttribute('aria-valuemax', Number.isFinite(d) ? Math.round(d) : 0);
  }

  function updateProgress() {
    const d = video.duration || 0;
    const cur = video.currentTime || 0;
    els.tCur.textContent = formatTime(cur);
    const pct = d ? (cur / d) * 100 : 0;
    els.playedBar.style.width = pct + '%';
    els.scrubHandle.style.left = pct + '%';
    els.progress.setAttribute('aria-valuenow', Math.round(cur));
  }

  function updateBuffered() {
    const b = video.buffered, d = video.duration;
    if (!b || !b.length || !Number.isFinite(d) || !d) { els.bufferedBar.style.width = '0%'; return; }
    let end = 0;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= video.currentTime + 0.5 && video.currentTime <= b.end(i) + 0.5) { end = b.end(i); break; }
      end = Math.max(end, b.end(i));
    }
    els.bufferedBar.style.width = (end / d) * 100 + '%';
  }

  function progressRatio(e) {
    const r = els.rail.getBoundingClientRect();
    return clamp((e.clientX - r.left) / (r.width || 1), 0, 1);
  }

  function seekFromEvent(e) {
    if (!seekable()) return;
    video.currentTime = progressRatio(e) * video.duration;
    updateProgress();
  }

  function seekBy(delta) {
    if (!seekable()) return;
    video.currentTime = clamp(video.currentTime + delta, 0, video.duration);
  }

  function seekToPct(p) {
    if (!seekable()) return;
    video.currentTime = p * video.duration;
  }

  // ================= transport =================
  function togglePlay() {
    if (!state.hasMedia) return;
    if (video.paused || video.ended) video.play().catch(() => showOverlay('bigPlay'));
    else video.pause();
  }

  function setPlayIcon(playing) {
    els.icoPlay.classList.toggle('hidden', playing);
    els.icoPause.classList.toggle('hidden', !playing);
  }

  function updatePrevNext() {
    els.btnPrev.disabled = state.index <= 0;
    els.btnNext.disabled = state.index >= state.playlist.length - 1;
    els.btnEndedNext.classList.toggle('hidden', state.index >= state.playlist.length - 1);
  }

  function step(delta) {
    const next = state.index + delta;
    if (next < 0 || next >= state.playlist.length) return;
    persistPosition(true);
    loadIndex(next);
  }

  // ================= volume / speed =================
  function bumpVolume(delta) {
    video.volume = clamp(Math.round((video.volume + delta) * 100) / 100, 0, 1);
    if (video.volume > 0 && video.muted) video.muted = false;
    saveSettings({ volume: video.volume });
  }

  function syncVolumeUI() {
    els.volume.value = video.muted ? 0 : video.volume;
    const muted = video.muted || video.volume === 0;
    els.icoVol.classList.toggle('hidden', muted);
    els.icoMuted.classList.toggle('hidden', !muted);
  }

  function buildSpeedMenu() {
    for (const r of RATES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = r + 'x';
      b.dataset.rate = String(r);
      b.addEventListener('click', () => { video.playbackRate = r; closeSpeedMenu(); });
      els.speedMenu.appendChild(b);
    }
  }

  function syncSpeedUI() {
    const r = parseFloat(video.playbackRate.toFixed(2));
    els.btnSpeed.textContent = r + 'x';
    els.speedMenu.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.rate) === r);
    });
  }

  function toggleSpeedMenu(force) {
    state.speedMenuOpen = typeof force === 'boolean' ? force : !state.speedMenuOpen;
    els.speedMenu.classList.toggle('hidden', !state.speedMenuOpen);
  }
  const closeSpeedMenu = () => toggleSpeedMenu(false);

  // ================= display modes =================
  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      playerEl.requestFullscreen().catch(() => showToast('Fullscreen unavailable'));
    }
  }

  function syncFullUI() {
    const fs = !!document.fullscreenElement;
    els.icoFull.classList.toggle('hidden', fs);
    els.icoExitFull.classList.toggle('hidden', !fs);
  }

  async function togglePip() {
    if (!document.pictureInPictureEnabled) { showToast('Picture-in-picture is not supported here'); return; }
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch (_) { showToast('Picture-in-picture failed'); }
  }

  function syncPipUI() {
    els.btnPip.classList.toggle('active', !!document.pictureInPictureElement);
  }

  function toggleTheater() {
    const on = !document.body.classList.contains('theater');
    document.body.classList.toggle('theater', on);
    els.btnTheater.classList.toggle('active', on);
    saveSettings({ theater: on });
  }

  // ================= controls visibility =================
  function showControlsNow() {
    playerEl.classList.remove('idle');
    clearTimeout(state.hideTimer);
    if (!video.paused && !video.ended) {
      state.hideTimer = setTimeout(() => {
        if (!state.dragging && !state.speedMenuOpen) playerEl.classList.add('idle');
      }, 2600);
    }
  }
  const scheduleHide = showControlsNow;

  // ================= persistence =================
  async function getPosition(key) {
    try {
      const d = await chrome.storage.local.get(POS_KEY);
      const rec = (d[POS_KEY] || {})[key];
      return rec && Number.isFinite(rec.t) ? rec.t : 0;
    } catch (_) { return 0; }
  }

  async function persistPosition(force = false) {
    if (!state.posKey || !state.hasMedia) return;
    const now = Date.now();
    if (!force && now - state.lastSaveAt < 3000) return;
    state.lastSaveAt = now;
    try {
      const d = await chrome.storage.local.get(POS_KEY);
      const map = d[POS_KEY] || {};
      const t = video.currentTime, dur = video.duration;
      if (t > 2 && (!Number.isFinite(dur) || t < dur - 5)) {
        map[state.posKey] = { t, d: Number.isFinite(dur) ? dur : null, ts: now };
      } else {
        delete map[state.posKey]; // finished or untouched → no resume
      }
      const keys = Object.keys(map);
      if (keys.length > 200) {
        keys.sort((a, b) => (map[a].ts || 0) - (map[b].ts || 0));
        keys.slice(0, keys.length - 200).forEach((k) => delete map[k]);
      }
      await chrome.storage.local.set({ [POS_KEY]: map });
    } catch (_) {}
  }

  async function restoreSettings() {
    try {
      const d = await chrome.storage.local.get(SET_KEY);
      const s = d[SET_KEY] || {};
      if (typeof s.volume === 'number') video.volume = clamp(s.volume, 0, 1);
      if (s.theater) { document.body.classList.add('theater'); els.btnTheater.classList.add('active'); }
    } catch (_) {}
  }

  async function saveSettings(patch) {
    try {
      const d = await chrome.storage.local.get(SET_KEY);
      await chrome.storage.local.set({ [SET_KEY]: { ...(d[SET_KEY] || {}), ...patch } });
    } catch (_) {}
  }

  // ================= UI wiring =================
  function bindUI() {
    els.btnPlay.addEventListener('click', togglePlay);
    els.btnBack10.addEventListener('click', () => seekBy(-10));
    els.btnFwd10.addEventListener('click', () => seekBy(10));
    els.btnPrev.addEventListener('click', () => step(-1));
    els.btnNext.addEventListener('click', () => step(1));
    els.btnMute.addEventListener('click', () => { video.muted = !video.muted; });
    els.btnFull.addEventListener('click', toggleFullscreen);
    els.btnPip.addEventListener('click', togglePip);
    els.btnTheater.addEventListener('click', toggleTheater);
    els.btnSpeed.addEventListener('click', (e) => { e.stopPropagation(); toggleSpeedMenu(); });
    els.btnRetry.addEventListener('click', () => loadIndex(state.index));
    if (els.btnPopout) {
      els.btnPopout.addEventListener('click', () => {
        const item = state.playlist[state.index] || {};
        const targetUrl = item.url || state.pageTitle || location.href;
        window.open(targetUrl, '_blank', 'width=1080,height=640,menubar=no,toolbar=no');
      });
    }
    els.btnLoadOther.addEventListener('click', showDirectLoad);
    els.btnReplay.addEventListener('click', () => { hideOverlay('ended'); video.currentTime = 0; video.play().catch(() => {}); });
    els.btnEndedNext.addEventListener('click', () => step(1));
    els.bigPlayBtn.addEventListener('click', () => { hideOverlay('bigPlay'); video.play().catch(() => {}); });
    els.directGo.addEventListener('click', () => loadDirect(els.directUrl.value));
    els.directUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadDirect(els.directUrl.value); });

    els.volume.addEventListener('input', () => {
      const v = Number(els.volume.value);
      video.volume = v;
      if (v > 0 && video.muted) video.muted = false;
    });
    els.volume.addEventListener('change', () => saveSettings({ volume: video.volume }));

    // progress bar: click + drag to seek, hover tooltip
    els.progress.addEventListener('pointerdown', (e) => {
      if (!seekable()) return;
      state.dragging = true;
      state.wasPlaying = !video.paused;
      els.progress.classList.add('dragging');
      els.progress.setPointerCapture(e.pointerId);
      seekFromEvent(e);
    });
    els.progress.addEventListener('pointermove', (e) => {
      if (state.dragging) seekFromEvent(e);
      else showSeekTip(e);
    });
    els.progress.addEventListener('pointerup', (e) => {
      if (!state.dragging) return;
      state.dragging = false;
      els.progress.classList.remove('dragging');
      seekFromEvent(e);
      if (state.wasPlaying) video.play().catch(() => {});
    });
    els.progress.addEventListener('pointerleave', () => els.seekTip.classList.add('hidden'));

    // click video = play/pause, double-click = fullscreen
    video.addEventListener('click', (e) => {
      if (e.detail !== 1) return;
      state.singleClickTimer = setTimeout(togglePlay, 220);
    });
    video.addEventListener('dblclick', () => {
      clearTimeout(state.singleClickTimer);
      toggleFullscreen();
    });

    document.addEventListener('mousemove', showControlsNow);
    document.addEventListener('click', (e) => {
      if (state.speedMenuOpen && !els.speedWrap.contains(e.target)) closeSpeedMenu();
    });
  }

  function showSeekTip(e) {
    if (!seekable()) return;
    const ratio = progressRatio(e);
    els.seekTip.textContent = formatTime(ratio * video.duration);
    const pr = els.progress.getBoundingClientRect();
    els.seekTip.style.left = clamp(e.clientX - pr.left, 24, pr.width - 24) + 'px';
    els.seekTip.classList.remove('hidden');
  }

  function loadDirect(raw) {
    let url = String(raw || '').trim();
    if (!url) return;
    if (!/^[a-z]+:/i.test(url)) url = 'https://' + url;
    let label = url;
    try { label = decodeURIComponent(new URL(url).pathname.split('/').pop() || url); } catch (_) {}
    let kind = 'direct';
    if (url.includes('.m3u8')) kind = 'hls';
    else if (url.includes('youtube.com') || url.includes('vimeo.com') || url.includes('embed')) kind = 'embed';
    state.playlist = [{ index: 0, label, url, kind, currentTime: 0 }];
    state.pageTitle = '';
    els.sourceNote.textContent = '';
    showPlayerChrome();
    loadIndex(0);
  }

  // ================= keyboard =================
  function isTyping(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  function bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      let handled = true;
      if (k === ' ' || k === 'k') togglePlay();
      else if (k === 'ArrowLeft') seekBy(-5);
      else if (k === 'ArrowRight') seekBy(5);
      else if (k === 'j') seekBy(-10);
      else if (k === 'l') seekBy(10);
      else if (k === 'ArrowUp') bumpVolume(0.1);
      else if (k === 'ArrowDown') bumpVolume(-0.1);
      else if (k === 'm') video.muted = !video.muted;
      else if (k === 'f') toggleFullscreen();
      else if (k === 'p') togglePip();
      else if (k === 't') toggleTheater();
      else if (k === 'Home' || k === '0') seekToPct(0);
      else if (k === 'End') seekToPct(1);
      else if (k >= '1' && k <= '9') seekToPct(Number(k) / 10);
      else handled = false;
      if (handled) { e.preventDefault(); showControlsNow(); }
    });
  }
})();
