/**
 * Browser Video Player — popup.
 * Broadcasts a scan request to every frame of the active tab; frames reply
 * directly to the popup via runtime.sendMessage. Replies are merged so videos
 * living in iframes are listed too, and each entry remembers its frameId so
 * "open" is routed to the correct frame.
 */
'use strict';

const COLLECT_MS = 500;
const replies = [];
const $ = (id) => document.getElementById(id);
const { formatTime, truncate } = window.BVP;

let tabId = null;
let entries = [];

init();

async function init() {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg && msg.type === 'bvp:scan-reply') {
      msg.frameId = sender.frameId;
      replies.push(msg);
    }
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  if (tabId == null) { showUnavailable(); return; }

  try {
    chrome.tabs.sendMessage(tabId, { type: 'bvp:scan-request' }, () => void chrome.runtime.lastError);
  } catch (_) {}

  setTimeout(renderResults, COLLECT_MS);
}

function renderResults() {
  let reachable = false;
  let pageTitle = '';
  const videos = [];

  for (const r of replies) {
    reachable = true;
    if (r.top && r.title) pageTitle = r.title;
    for (const v of (r.videos || [])) videos.push({ ...v, frameId: r.frameId });
  }
  if (!pageTitle && replies.length) pageTitle = replies[0].title || '';

  // playing first, then largest visible player
  videos.sort((a, b) => (b.playing - a.playing) || (b.width * b.height) - (a.width * a.height));
  entries = videos;

  if (pageTitle) $('pageMeta').textContent = truncate(pageTitle, 46);

  if (!reachable) return showUnavailable();
  if (!videos.length) return showNone();

  $('stateLoading').classList.add('hidden');
  $('stateList').classList.remove('hidden');
  $('videoCount').textContent = videos.length === 1 ? '1 video detected' : videos.length + ' videos detected';

  const rows = $('videoRows');
  videos.forEach((v, i) => {
    const row = document.createElement('button');
    row.className = 'vrow';
    const label = document.createElement('span');
    label.className = 'vlabel';
    label.textContent = v.label;
    const meta = document.createElement('span');
    meta.className = 'vmeta';
    const stateTag = document.createElement('span');
    stateTag.className = 'tag ' + (v.playing ? 'playing' : 'paused');
    stateTag.textContent = v.playing ? '● playing' : 'paused';
    meta.append(stateTag, document.createTextNode(
      `${v.duration ? formatTime(v.duration) : '—'} · ${v.width}×${v.height}`
    ));
    if (v.kind === 'hls') {
      const st = document.createElement('span');
      st.className = 'tag stream';
      st.style.background = '#2b6fff';
      st.textContent = 'HLS stream';
      meta.appendChild(st);
    } else if (v.kind === 'embed') {
      const st = document.createElement('span');
      st.className = 'tag stream';
      st.style.background = '#8a3ffc';
      st.textContent = 'embed';
      meta.appendChild(st);
    } else if (v.kind === 'stream') {
      const st = document.createElement('span');
      st.className = 'tag stream';
      st.textContent = 'stream';
      meta.appendChild(st);
    }
    row.append(label, meta);
    row.addEventListener('click', () => openEntry(i === 0 ? entries[0] : v));
    rows.appendChild(row);
  });

  const best = videos[0];
  const openBest = $('openBest');
  openBest.classList.remove('hidden');
  openBest.addEventListener('click', () => openEntry(best));
}

function openEntry(entry) {
  try {
    chrome.tabs.sendMessage(
      tabId,
      { type: 'bvp:open', index: entry.index },
      { frameId: entry.frameId },
      () => { void chrome.runtime.lastError; window.close(); }
    );
  } catch (_) { window.close(); }
}

function showNone() {
  $('stateLoading').classList.add('hidden');
  $('stateNone').classList.remove('hidden');
}

function showUnavailable() {
  $('stateLoading').classList.add('hidden');
  $('pageMeta').textContent = 'Current tab is restricted';
  $('stateUnavailable').classList.remove('hidden');
}
