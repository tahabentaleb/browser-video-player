/**
 * Browser Video Player — content script.
 * Detects <video> elements (static, dynamic, playing, paused), keeps one
 * floating "Open in Player" button attached to the best candidate, and
 * hands the selected video's state to the player tab via the service worker.
 *
 * Overlay styling is injected into a closed Shadow DOM instead of a separate
 * stylesheet: page CSS can't break it, page CSP can't block it, and it can
 * never leak into the host page.
 */
(() => {
  'use strict';

  if (window.__bvpDetectorLoaded) return;
  window.__bvpDetectorLoaded = true;

  // ---------- YouTube embed patch for Error 153 ----------
  if (location.hostname.includes('youtube') && location.pathname.includes('/embed')) {
    try {
      Object.defineProperty(document, 'referrer', {
        get: () => 'https://www.youtube.com/',
        configurable: true
      });
    } catch (_) {}
    try {
      const origins = ['https://www.youtube.com'];
      origins.item = (i) => origins[i];
      origins.contains = (s) => origins.includes(s);
      Object.defineProperty(location, 'ancestorOrigins', {
        get: () => origins,
        configurable: true
      });
    } catch (_) {}
  }

  // ---------- tunables ----------
  const DEBOUNCE_MS = 200;
  const HEARTBEAT_MS = 2500;   // slow safety net; real work is event-driven
  const MIN_AUTO_W = 140;      // auto-targeting ignores smaller players
  const MIN_AUTO_H = 80;       // (tiny previews/ads) unless hovered directly

  // ---------- state ----------
  let host = null;
  let shadow = null;
  let btn = null;
  let currentVideo = null;
  let hoverVideo = null;
  let scanTimer = 0;
  let placing = false;
  let lastHoverCheck = 0;
  let scrollRaf = 0;

  // ---------- overlay (Shadow DOM) ----------
  const OVERLAY_CSS = `
    :host { all: initial; pointer-events: none; }
    #bvp-btn {
      position: fixed; z-index: 2147483647;
      display: inline-flex; align-items: center; gap: 7px;
      padding: 8px 15px 8px 12px;
      border: 1px solid rgba(255,255,255,0.16);
      border-radius: 999px;
      background: rgba(15,18,24,0.92);
      color: #f2f5fa;
      font: 600 13px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      letter-spacing: 0.2px;
      cursor: pointer;
      pointer-events: auto;
      box-shadow: 0 6px 22px rgba(0,0,0,0.45);
      opacity: 0;
      transform: translate(-50%, 8px);
      transition: opacity .18s ease, transform .18s ease, background .15s ease, border-color .15s ease;
    }
    #bvp-btn.show { opacity: 1; transform: translate(-50%, 0); }
    #bvp-btn:hover, #bvp-btn:focus-visible { background: #2b6fff; border-color: #2b6fff; outline: none; }
    #bvp-btn:active { transform: translate(-50%, 0) scale(0.97); }
    #bvp-btn svg { width: 14px; height: 14px; flex: none; }
  `;

  function ensureOverlay() {
    if (btn && host && host.isConnected) return;
    host = document.createElement('bvp-overlay');
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    btn = document.createElement('button');
    btn.id = 'bvp-btn';
    btn.type = 'button';
    btn.title = 'Open in Browser Video Player';
    btn.setAttribute('aria-label', 'Open this video in Browser Video Player');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      '<path d="M8 5.5v13l10.5-6.5z"/></svg><span>Open in Player</span>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onButtonClick();
    });
    shadow.append(style, btn);
    (document.body || document.documentElement).appendChild(host);
  }

  // ---------- discovery & ranking ----------
  const allVideos = () => Array.from(document.querySelectorAll('video'));

  function visibleRect(v) {
    const r = v.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return null;
    const cs = getComputedStyle(v);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return null;
    const x0 = Math.max(0, r.left);
    const y0 = Math.max(0, r.top);
    const x1 = Math.min(window.innerWidth, r.right);
    const y1 = Math.min(window.innerHeight, r.bottom);
    if (x1 <= x0 || y1 <= y0) return null;
    return { rect: r, visW: x1 - x0, visH: y1 - y0 };
  }

  function isPlaying(v) {
    return !v.paused && !v.ended && v.readyState >= 2 && !v.seeking;
  }

  // Priority per spec: 1) playing  2) visible  3) largest  4) near interaction point
  function score(v, vis) {
    let s = vis.visW * vis.visH;
    if (isPlaying(v)) s += 1e9;
    const r = vis.rect;
    const dx = r.left + r.width / 2 - window.innerWidth / 2;
    const dy = r.top + r.height / 2 - window.innerHeight / 2;
    s += Math.max(0, 2000 - Math.hypot(dx, dy));
    return s;
  }

  function pickTarget() {
    if (hoverVideo && document.contains(hoverVideo)) {
      const vis = visibleRect(hoverVideo);
      if (vis) return hoverVideo; // explicit hover beats auto-ranking
    }
    let target = null;
    let best = -1;
    for (const v of allVideos()) {
      const vis = visibleRect(v);
      if (!vis) continue;
      if (vis.rect.width < MIN_AUTO_W || vis.rect.height < MIN_AUTO_H) continue;
      const s = score(v, vis);
      if (s > best) { best = s; target = v; }
    }
    return target;
  }

  // ---------- button placement ----------
  function refresh() {
    if (document.hidden) return;
    const target = pickTarget();
    if (!target) {
      currentVideo = null;
      if (btn) btn.classList.remove('show');
      return;
    }
    currentVideo = target;
    ensureOverlay();
    placeButton(target);
    if (!btn.classList.contains('show')) btn.classList.add('show');
  }

  function placeButton(v) {
    if (!btn || placing) return;
    placing = true;
    requestAnimationFrame(() => {
      placing = false;
      if (v !== currentVideo) return;
      const vis = visibleRect(v);
      if (!vis) return;
      const r = vis.rect;
      const x = Math.min(Math.max(r.left + r.width / 2, 84), window.innerWidth - 84);
      const y = Math.max(r.top + 26, Math.min(r.bottom, window.innerHeight) - 54);
      btn.style.left = x + 'px';
      btn.style.top = y + 'px';
    });
  }

  function refreshSoon() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = 0; refresh(); }, DEBOUNCE_MS);
  }

  // ---------- source extraction ----------
  function sourceInfo(v) {
    const urls = [];
    const push = (u) => {
      if (u && typeof u === 'string' && !urls.includes(u)) {
        try {
          const resolved = new URL(u, location.href).href;
          if (!urls.includes(resolved)) urls.push(resolved);
        } catch (_) {}
      }
    };

    // 1. Direct tag attributes
    try { push(v.currentSrc); } catch (_) {}
    try { push(v.getAttribute('src')); } catch (_) {}
    v.querySelectorAll('source').forEach((s) => {
      push(s.getAttribute('src'));
      push(s.src);
    });

    // 2. Data attributes on video or parent elements
    let curr = v;
    for (let depth = 0; depth < 5 && curr; depth++) {
      for (const attr of ['data-src', 'data-url', 'data-mp4', 'data-hls', 'data-stream', 'data-stream-url', 'data-video', 'data-video-src', 'data-original']) {
        push(curr.getAttribute(attr));
      }
      curr = curr.parentElement;
    }

    // 3. Document meta & link tags
    document.querySelectorAll('meta[property^="og:video"], link[rel="video_src"]').forEach((el) => {
      push(el.getAttribute('content') || el.getAttribute('href'));
    });

    // 4. Performance entries (network resource timing)
    try {
      const perfEntries = performance.getEntriesByType('resource');
      for (let i = perfEntries.length - 1; i >= 0; i--) {
        const name = perfEntries[i].name;
        if (/\.(mp4|m3u8|webm|ogg|mpd)(\?|$)/i.test(name) || name.includes('master.m3u8') || name.includes('playlist.m3u8')) {
          push(name);
          break;
        }
      }
    } catch (_) {}

    // Check YouTube video ID pattern
    const ytMatch = location.href.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
    if (ytMatch && ytMatch[1]) {
      return {
        url: `https://www.youtube.com/embed/${ytMatch[1]}?autoplay=1&enablejsapi=1&origin=https%3A%2F%2Fwww.youtube.com&widget_referrer=https%3A%2F%2Fwww.youtube.com`,
        kind: 'embed'
      };
    }

    // Check Vimeo video ID pattern
    const vimeoMatch = location.href.match(/(?:vimeo\.com\/(?:video\/)?)([0-9]+)/i);
    if (vimeoMatch && vimeoMatch[1]) {
      return { url: `https://player.vimeo.com/video/${vimeoMatch[1]}?autoplay=1`, kind: 'embed' };
    }

    // Filter non-blob direct or HLS candidate
    const nonBlob = urls.find((u) => u && !u.startsWith('blob:') && !u.startsWith('mediasource:'));
    if (nonBlob) {
      if (/\.m3u8(\?|$)/i.test(nonBlob) || nonBlob.includes('master.m3u8') || nonBlob.includes('playlist.m3u8')) {
        return { url: nonBlob, kind: 'hls' };
      }
      return { url: nonBlob, kind: 'direct' };
    }

    // If iframe embed
    if (window !== window.top && location.href.includes('embed')) {
      return { url: location.href, kind: 'embed' };
    }

    // If blob is present but no non-blob URL extracted, try matching performance resources for video chunks or m3u8
    try {
      const perfEntries = performance.getEntriesByType('resource');
      for (let i = perfEntries.length - 1; i >= 0; i--) {
        const name = perfEntries[i].name;
        if (name.startsWith('http') && (name.includes('.m3u8') || name.includes('.mp4') || name.includes('/video/'))) {
          const kind = name.includes('.m3u8') ? 'hls' : 'direct';
          return { url: name, kind };
        }
      }
    } catch (_) {}

    if (urls.length) return { url: urls[0], kind: 'stream' }; // fallback stream tag
    return { url: '', kind: 'none' };
  }

  function labelFor(v, url, i) {
    if (url) {
      try {
        const u = new URL(url, location.href);
        const name = decodeURIComponent(u.pathname.split('/').pop() || '');
        if (name && /\.\w{2,5}$/.test(name)) return name;
      } catch (_) {}
    }
    const t = (document.title || '').trim();
    return t ? `${t} — video ${i + 1}` : `Video ${i + 1}`;
  }

  function describeVideo(v, i) {
    const info = sourceInfo(v);
    const r = v.getBoundingClientRect();
    return {
      index: i,
      label: labelFor(v, info.url, i),
      url: info.url,
      kind: info.kind, // direct | stream (blob/MSE) | none
      duration: Number.isFinite(v.duration) ? v.duration : null,
      playing: !v.paused && !v.ended,
      width: Math.round(r.width),
      height: Math.round(r.height),
      currentTime: v.currentTime || 0,
      poster: v.poster || null
    };
  }

  // ---------- hand-off ----------
  function openInPlayer(videos, index) {
    const v = videos[index];
    if (!v) return;
    const payload = {
      pageTitle: document.title || location.hostname,
      pageUrl: location.href,
      index,
      playlist: videos.map((el, i) => describeVideo(el, i))
    };
    try { v.pause(); } catch (_) {} // avoid double audio
    chrome.runtime.sendMessage({ type: 'bvp:open-player', payload }, () => {
      void chrome.runtime.lastError;
    });
  }

  function bestAutoIndex(videos) {
    const t = pickTarget();
    return t ? videos.indexOf(t) : 0;
  }

  function onButtonClick() {
    const videos = allVideos();
    if (!currentVideo) return;
    const idx = videos.indexOf(currentVideo);
    if (idx === -1) return refreshSoon();
    openInPlayer(videos, idx);
  }

  // ---------- messaging from popup ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'bvp:scan-request') {
      const videos = allVideos();
      // Frames with zero videos stay silent (except top), so iframe videos
      // can surface even when the top frame has none.
      if (videos.length === 0 && window !== window.top) return;
      chrome.runtime.sendMessage({
        type: 'bvp:scan-reply',
        top: window === window.top,
        title: document.title,
        url: location.href,
        videos: videos.map((v, i) => describeVideo(v, i))
      }).catch(() => {}); // popup may have closed
    } else if (msg.type === 'bvp:open') {
      const videos = allVideos();
      if (!videos.length) { sendResponse({ ok: false }); return; }
      let i = Number.isInteger(msg.index) ? msg.index : bestAutoIndex(videos);
      if (i < 0 || i >= videos.length) i = 0;
      openInPlayer(videos, i);
      sendResponse({ ok: true });
    }
  });

  // ---------- watchers ----------
  function onMutations(muts) {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && (n.tagName === 'VIDEO' || (n.querySelector && n.querySelector('video')))) {
          return refreshSoon();
        }
      }
      for (const n of m.removedNodes) {
        if (n.nodeType !== 1) continue;
        if (n === currentVideo || n === hoverVideo) {
          currentVideo = null; hoverVideo = null;
          return refreshSoon();
        }
        if (n.tagName === 'VIDEO' || (n.querySelector && n.querySelector('video'))) {
          if (currentVideo && !document.contains(currentVideo)) currentVideo = null;
          if (hoverVideo && !document.contains(hoverVideo)) hoverVideo = null;
          return refreshSoon();
        }
      }
    }
  }

  function onPointerMove(e) {
    const now = Date.now();
    if (now - lastHoverCheck < 120) return;
    lastHoverCheck = now;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const v = el && el.closest ? el.closest('video') : null;
    if (v !== hoverVideo) { hoverVideo = v; refreshSoon(); }
  }

  function onLayout() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (currentVideo) placeButton(currentVideo);
      refreshSoon();
    });
  }

  function init() {
    for (const ev of ['play', 'playing', 'pause', 'loadedmetadata', 'timeupdate', 'emptied']) {
      document.addEventListener(ev, refreshSoon, true);
    }
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('scroll', onLayout, { passive: true, capture: true });
    window.addEventListener('resize', onLayout, { passive: true });

    const mo = new MutationObserver(onMutations);
    mo.observe(document.documentElement, { childList: true, subtree: true });

    setInterval(refreshSoon, HEARTBEAT_MS); // light safety net only
    refreshSoon();
  }

  init();
})();
