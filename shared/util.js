/**
 * Shared, dependency-free helpers. Usable in extension pages (window.BVP)
 * and in Node unit tests (module.exports).
 */
(function (root) {
  'use strict';

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  }

  function hashString(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
  }

  function truncate(str, n) {
    str = String(str == null ? '' : str);
    return str.length > n ? str.slice(0, n - 1) + '…' : str;
  }

  const api = { formatTime, hashString, truncate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BVP = api;
})(typeof window !== 'undefined' ? window : globalThis);
