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
const tw = (iso) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

function render(r) {
  if (!r || r.empty) { $('stats').innerHTML = '<p class="hint">還沒有報告</p>'; return; }
  $('updated').textContent = `${r.page.name}｜追蹤 ${r.page.followers}｜更新於 ${tw(r.generatedAt)}`;
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

async function load() {
  const cached = store.get('report');
  if (cached) render(JSON.parse(cached));
  try {
    const r = await api('/report');
    store.set('report', JSON.stringify(r));
    render(r);
    $('offline').classList.add('hidden');
  } catch (e) {
    if (e.auth) return showLogin('密碼失效，請重新輸入');
    $('offline').classList.remove('hidden');
  }
}

function showLogin(msg = '') {
  $('login').classList.remove('hidden');
  $('app').classList.add('hidden');
  $('loginMsg').textContent = msg;
}

function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const canPush = 'serviceWorker' in navigator && 'PushManager' in window;
  if (!standalone) {
    $('notifyCard').classList.remove('hidden');
    $('notifyBtn').classList.add('hidden');
    $('notifyMsg').textContent = '要收通知，請在 Safari 按「分享 → 加入主畫面」，再從主畫面打開秘書。';
  } else if (canPush && Notification.permission !== 'granted') {
    $('notifyCard').classList.remove('hidden');
  }
  load();
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
  } catch (e) {
    $('notifyMsg').textContent = `開啟失敗：${e.message}`;
  }
};

$('refreshBtn').onclick = load;
$('testBtn').onclick = async () => {
  try { const r = await api('/test-push', { method: 'POST' }); alert(r.sent ? '已送出測試通知' : '還沒有開啟通知的裝置'); }
  catch { alert('連不到秘書'); }
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
store.get('token') ? showApp() : showLogin();
