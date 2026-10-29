const API = 'https://dictation-moonrise-subplot.ngrok-free.dev/api';
const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      'ngrok-skip-browser-warning': '1',
      Authorization: `Bearer ${store.get('token') || ''}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (res.status === 401) { const e = new Error('unauthorized'); e.auth = true; throw e; }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
const tw = (iso) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

function setOnline(on) {
  $('status').innerHTML = on ? '<span class="dot"></span>在線上' : '<span class="dot off"></span>離線中（電腦可能關機）';
  $('offline').classList.toggle('hidden', on);
}

// ---------- 分頁 ----------

let tab = 'chat';
function showTab(name) {
  tab = name;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  $('chat').classList.toggle('hidden', name !== 'chat');
  $('chips').classList.toggle('hidden', name !== 'chat');
  $('composer').classList.toggle('hidden', name !== 'chat');
  $('report').classList.toggle('hidden', name !== 'report');
  if (name === 'chat') { renderChat(); $('chat').scrollTop = $('chat').scrollHeight; markRead(); }
  else loadReport();
  updateDot();
  poll();
}
for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => showTab(b.dataset.tab);

// ---------- 對話 ----------

let messages = [];
let pollTimer = null;
const waiting = () => messages.length && messages.at(-1).role === 'user';

function renderChat() {
  const box = $('msgs');
  const atBottom = $('chat').scrollHeight - $('chat').scrollTop - $('chat').clientHeight < 80;
  box.innerHTML = messages.length
    ? messages.map((m) => `<div class="msg ${m.role} ${m.kind || ''}">${m.kind === 'notice' ? '<b class="tag">通知</b>' : ''}${linkify(m.text)}<time>${tw(m.time)}</time></div>`).join('')
      + (waiting() ? '<div class="typing">秘書處理中…</div>' : '')
    : '<p class="hint">交代秘書事情，例如「今天有什麼行程」「摘要今天的郵件」。處理比較久時，回覆好了會傳通知給你。</p>';
  if (atBottom || waiting()) $('chat').scrollTop = $('chat').scrollHeight;
}

let stick = true;
$('chat').addEventListener('scroll', () => {
  const c = $('chat');
  stick = c.scrollHeight - c.scrollTop - c.clientHeight < 80;
});
new ResizeObserver(() => { if (stick) $('chat').scrollTop = $('chat').scrollHeight; }).observe($('chat'));

const lastSecretaryTime =() => messages.filter((m) => m.role === 'secretary').at(-1)?.time || '';

function markRead() {
  if (document.hidden || !messages.length) return;
  const t = lastSecretaryTime();
  if (store.get('readAt') === t) return;
  store.set('readAt', t);
  navigator.clearAppBadge?.().catch(() => {});
  api('/read', { method: 'POST', body: '{}' }).catch(() => {});
}

function updateDot() {
  const unread = tab !== 'chat' && lastSecretaryTime() > (store.get('readAt') || '');
  document.querySelector('#tabs button[data-tab="chat"]').classList.toggle('unread', unread);
}

async function poll() {
  clearTimeout(pollTimer);
  if (document.hidden || !store.get('token')) return;
  try {
    const list = await api('/chat');
    setOnline(true);
    if (JSON.stringify(list) !== JSON.stringify(messages)) {
      messages = list;
      store.set('chat', JSON.stringify(list));
      if (tab === 'chat') { renderChat(); markRead(); }
    }
    updateDot();
  } catch (e) {
    if (e.auth) return showLogin('密碼失效，請重新輸入');
    setOnline(false);
  }
  if (waiting()) pollTimer = setTimeout(poll, 2000);
}



async function send(text) {
  text = text.trim();
  if (!text) return;
  $('sendBtn').disabled = true;
  try {
    const msg = await api('/chat', { method: 'POST', body: JSON.stringify({ text }) });
    messages.push(msg);
    $('input').value = '';
    autosize();
    renderChat();
    $('chat').scrollTop = $('chat').scrollHeight;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, 2000);
  } catch (e) {
    alert(e.auth ? '密碼失效' : '送不出去，秘書可能離線了');
  } finally {
    $('sendBtn').disabled = false;
  }
}

function autosize() {
  const t = $('input');
  t.style.height = '42px';
  t.style.height = Math.min(t.scrollHeight + 2, 122) + 'px';
}
$('input').addEventListener('input', autosize);
$('sendBtn').onclick = () => send($('input').value);
for (const b of document.querySelectorAll('#chips button')) b.onclick = () => send(b.textContent);

// ---------- 粉專報告 ----------

function renderReport(r) {
  if (!r || r.empty) { $('stats').innerHTML = '<p class="hint">還沒有報告</p>'; return; }
  $('pageTitle').textContent = `${r.page.name} 近 7 天`;
  $('updated').textContent = `追蹤 ${r.page.followers}｜更新於 ${tw(r.generatedAt)}`;
  const show = ['page_media_view', 'page_total_media_view_unique', 'page_post_engagements', 'page_daily_follows_unique'];
  $('stats').innerHTML = r.metrics.filter((m) => show.includes(m.key)).map((m) => {
    const diff = m.prevWeek ? Math.round(((m.week - m.prevWeek) / m.prevWeek) * 100) : null;
    const d = diff === null ? '' : `<div class="d ${diff >= 0 ? 'up' : 'down'}">${diff >= 0 ? '+' : ''}${diff}% 比前 7 天</div>`;
    return `<div class="stat"><div class="v">${m.week}</div><div class="l">${esc(m.label)}</div>${d}</div>`;
  }).join('');

  $('unrepliedBadge').innerHTML = r.unrepliedCount ? `<span class="badge">未回 ${r.unrepliedCount}</span>` : '';
  const list = [...r.newComments, ...r.unreplied.filter((u) => !r.newComments.some((c) => c.id === u.id))];
  $('comments').innerHTML = list.length
    ? list.map((c) => `<div class="item">${esc(c.message) || '(貼圖或照片)'}<div class="meta">${tw(c.time)}｜${c.replied ? '已回' : '未回'}｜${esc(c.post)}</div></div>`).join('')
    : '<p class="hint">昨天沒有新留言，也沒有未回的留言</p>';

  $('posts').innerHTML = r.posts.map((p) =>
    `<div class="item"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.message) || '(影片或照片)'}</a><div class="meta">${tw(p.time)}｜讚 ${p.reactions}｜留言 ${p.comments}</div></div>`
  ).join('');
}

async function loadReport() {
  const cached = store.get('report');
  if (cached) renderReport(JSON.parse(cached));
  try {
    const r = await api('/report');
    store.set('report', JSON.stringify(r));
    renderReport(r);
    setOnline(true);
  } catch (e) {
    if (e.auth) return showLogin('密碼失效，請重新輸入');
    setOnline(false);
  }
}
$('refreshBtn').onclick = loadReport;
$('testBtn').onclick = async () => {
  try { const r = await api('/test-push', { method: 'POST' }); alert(r.sent ? '已送出測試通知' : '還沒有開啟通知的裝置'); }
  catch { alert('連不到秘書'); }
};

// ---------- 登入與通知 ----------

function showLogin(msg = '') {
  for (const id of ['chat', 'chips', 'composer', 'report', 'tabs']) $(id).classList.add('hidden');
  $('login').classList.remove('hidden');
  $('loginMsg').textContent = msg;
}

function showApp() {
  $('login').classList.add('hidden');
  $('tabs').classList.remove('hidden');
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const canPush = 'serviceWorker' in navigator && 'PushManager' in window;
  if (!standalone) {
    $('notifyCard').classList.remove('hidden');
    $('notifyBtn').classList.add('hidden');
    $('notifyMsg').textContent = '要收通知，請在 Safari 按「分享 → 加入主畫面」，再從主畫面打開秘書。';
  } else if (canPush && Notification.permission !== 'granted') {
    $('notifyCard').classList.remove('hidden');
  }
  const cached = store.get('chat');
  if (cached && !messages.length) messages = JSON.parse(cached);
  showTab(tab);
}

$('loginBtn').onclick = async () => {
  store.set('token', $('pw').value.trim());
  try { await api('/report'); showApp(); } catch (e) { showLogin(e.auth ? '密碼不正確' : '連不到秘書，電腦可能關機了'); }
};

function urlB64(key) {
  const pad = '='.repeat((4 - (key.length % 4)) % 4);
  const raw = atob((key + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

$('notifyBtn').onclick = async () => {
  try {
    if (await Notification.requestPermission() !== 'granted') { $('notifyMsg').textContent = '沒有允許通知。可以到 iPhone 設定 → 通知 → 秘書 打開。'; return; }
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api('/vapid');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(key) });
    await api('/subscribe', { method: 'POST', body: JSON.stringify(sub) });
    $('notifyMsg').textContent = '通知已開啟';
    $('notifyBtn').classList.add('hidden');
    setTimeout(() => $('notifyCard').classList.add('hidden'), 1500);
  } catch (e) {
    $('notifyMsg').textContent = `開啟失敗：${e.message}`;
  }
};

document.addEventListener('visibilitychange', () => { if (!document.hidden && store.get('token')) showTab(tab); });
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data === 'new-message') poll(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
store.get('token') ? showApp() : showLogin();
