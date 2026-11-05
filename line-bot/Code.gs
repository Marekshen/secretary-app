// 工作室 LINE 預約小幫手（Google Apps Script）
// 客人可以按按鈕查空檔，也可以直接打字問；真正的預約一律交給 Google「諮詢預約」頁面完成。
// 機器人只看得到「忙／空」，看不到行程內容，也不會改動任何行事曆。

// ===== 設定：改這裡就好 =====
const CONFIG = {
  STUDIO_NAME: '工作室',
  SERVICE_NAME: '諮詢預約',
  BOOKING_URL: 'https://calendar.app.google/RtAwZ5BKprS5S2nH6',
  SLOT_MINUTES: 60,
  // 要跟「諮詢預約」設定的可預約時段一致。0=週日 … 6=週六，[開始, 結束]（24 小時制，可用 13.5 表示 13:30）
  // 臨時不接預約的日子：在「工作室排班」加一個全天活動（例如「不接預約」），機器人和預約頁都會擋掉
  OPEN_HOURS: {
    1: [10, 19],
    2: [10, 19],
    3: [10, 19],
    4: [10, 19],
    5: [10, 19],
  },
  DAYS_AHEAD: 14,       // 最多查幾天內
  MIN_NOTICE_HOURS: 3,  // 至少幾小時前預約
  // 這些行事曆有事的時段都算「沒空」（只讀忙／空）
  BUSY_CALENDARS: [
    'primary',
    'f44537c6b4f538cc534330b43dde40fce187a748bad37ed221bb12f2596eb2c6@group.calendar.google.com', // 工作室排班
  ],
  MODEL: 'claude-opus-5-5',
  AI_LIMIT_PER_USER_PER_HOUR: 20,
  AI_LIMIT_PER_DAY: 300,
};
// 金鑰放在「專案設定 → 指令碼屬性」：LINE_CHANNEL_ACCESS_TOKEN、ANTHROPIC_API_KEY

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const TZ = 'Asia/Taipei';

// ===== LINE webhook 入口 =====
function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  (body.events || []).forEach((ev) => {
    try {
      handleEvent(ev);
    } catch (err) {
      console.error(err && err.stack || err);
      if (ev.replyToken) reply(ev.replyToken, [text('抱歉，系統暫時有點問題，請稍後再試，或直接使用預約頁面：\n' + CONFIG.BOOKING_URL)]);
    }
  });
  return ContentService.createTextOutput('ok');
}

function handleEvent(ev) {
  if (ev.type === 'follow') {
    return reply(ev.replyToken, [withMenu(text(
      `您好，這裡是${CONFIG.STUDIO_NAME}的預約小幫手 🙂\n` +
      `可以按下方「查空檔」選日期，也可以直接問我，例如「下週三下午有空嗎？」`))]);
  }
  if (ev.type === 'postback') {
    const data = parseQuery(ev.postback.data);
    if (data.day) return reply(ev.replyToken, [slotsForDayMessage(data.day)]);
    if (data.slot) return reply(ev.replyToken, [bookingMessage(new Date(Number(data.slot)))]);
    return;
  }
  if (ev.type !== 'message' || ev.message.type !== 'text') return;

  const msg = ev.message.text.trim();
  if (/^(查空檔|預約|我要預約|空檔)$/.test(msg)) return reply(ev.replyToken, [daysMessage()]);
  if (/^(預約連結|連結)$/.test(msg)) return reply(ev.replyToken, [bookingMessage(null)]);

  const userId = ev.source && ev.source.userId || 'anon';
  if (!allowAi(userId)) {
    return reply(ev.replyToken, [withMenu(text('目前詢問較多，請按「查空檔」選日期，或直接使用預約頁面：\n' + CONFIG.BOOKING_URL))]);
  }
  reply(ev.replyToken, [withMenu(text(askClaude(userId, msg)))]);
}

// ===== 空檔計算 =====
function freeSlots(from, to) {
  const now = new Date();
  const earliest = new Date(now.getTime() + CONFIG.MIN_NOTICE_HOURS * 3600e3);
  const horizon = new Date(now.getTime() + CONFIG.DAYS_AHEAD * 86400e3);
  if (from < now) from = now;
  if (to > horizon) to = horizon;
  if (from >= to) return [];

  const fb = Calendar.Freebusy.query({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    items: CONFIG.BUSY_CALENDARS.map((id) => ({ id })),
  });
  const busy = [];
  Object.keys(fb.calendars).forEach((id) => {
    (fb.calendars[id].busy || []).forEach((b) => busy.push([new Date(b.start), new Date(b.end)]));
  });

  const slots = [];
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (; day < to; day.setDate(day.getDate() + 1)) {
    const hours = CONFIG.OPEN_HOURS[day.getDay()];
    if (!hours) continue;
    const open = atHour(day, hours[0]);
    const close = atHour(day, hours[1]);
    for (let s = open; s.getTime() + CONFIG.SLOT_MINUTES * 60e3 <= close.getTime();
         s = new Date(s.getTime() + CONFIG.SLOT_MINUTES * 60e3)) {
      const end = new Date(s.getTime() + CONFIG.SLOT_MINUTES * 60e3);
      if (s < earliest || s < from || end > to) continue;
      if (busy.some(([bs, be]) => s < be && end > bs)) continue;
      slots.push(s);
    }
  }
  return slots;
}

function atHour(day, h) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(h), Math.round((h % 1) * 60));
}

function fmtDay(d) { return Utilities.formatDate(d, TZ, 'M/d') + `（${WEEKDAYS[d.getDay()]}）`; }
function fmtTime(d) { return Utilities.formatDate(d, TZ, 'HH:mm'); }
function ymd(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }

// ===== 按鈕流程 =====
function daysMessage() {
  const now = new Date();
  const slots = freeSlots(now, new Date(now.getTime() + CONFIG.DAYS_AHEAD * 86400e3));
  const days = [];
  slots.forEach((s) => { const k = ymd(s); if (days.indexOf(k) < 0) days.push(k); });
  if (!days.length) return text(`接下來 ${CONFIG.DAYS_AHEAD} 天都滿了，抱歉！可以稍後再來看看。`);
  return quick(text('請選擇日期：'), days.slice(0, 13).map((k) => {
    const label = fmtDay(parseYmd(k));
    return postback(label, 'day=' + k, label);
  }));
}

function slotsForDayMessage(k) {
  const day = parseYmd(k);
  const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  const slots = freeSlots(day, next);
  if (!slots.length) return withMenu(text(`${fmtDay(day)} 已經沒有空檔了，請選其他日期。`));
  return quick(text(`${fmtDay(day)} 可以預約的時間：`), slots.slice(0, 13).map((s) =>
    postback(fmtTime(s), 'slot=' + s.getTime(), `${fmtDay(s)} ${fmtTime(s)}`)));
}

function bookingMessage(slot) {
  const head = slot
    ? `${fmtDay(slot)} ${fmtTime(slot)} 目前有空 👍\n請點下方連結，在預約頁面選這個時段並填寫資料，就完成預約了。`
    : '請點下方連結，選擇時段並填寫資料即可完成預約。';
  return {
    type: 'template',
    altText: head + '\n' + CONFIG.BOOKING_URL,
    template: {
      type: 'buttons',
      text: head.slice(0, 160),
      actions: [{ type: 'uri', label: '前往預約頁面', uri: CONFIG.BOOKING_URL }],
    },
  };
}

// ===== AI 回答 =====
const AI_TOOLS = [{
  name: 'check_availability',
  description: '查詢工作室在某段日期內可預約的空檔。回傳每個可預約時段的開始時間（每段 ' + CONFIG.SLOT_MINUTES + ' 分鐘）。',
  input_schema: {
    type: 'object',
    properties: {
      start_date: { type: 'string', description: '開始日期 YYYY-MM-DD（含）' },
      end_date: { type: 'string', description: '結束日期 YYYY-MM-DD（含）' },
    },
    required: ['start_date', 'end_date'],
    additionalProperties: false,
  },
  strict: true,
}];

function systemPrompt() {
  const hours = Object.keys(CONFIG.OPEN_HOURS).map((k) =>
    `週${WEEKDAYS[k]} ${CONFIG.OPEN_HOURS[k][0]}–${CONFIG.OPEN_HOURS[k][1]} 點`).join('、');
  return [
    `你是「${CONFIG.STUDIO_NAME}」在 LINE 上的預約小幫手，用繁體中文、親切簡短地回覆客人（像 LINE 訊息，不用 Markdown）。`,
    `服務：${CONFIG.SERVICE_NAME}，每次 ${CONFIG.SLOT_MINUTES} 分鐘。營業時段：${hours}。最多可預約 ${CONFIG.DAYS_AHEAD} 天內、至少 ${CONFIG.MIN_NOTICE_HOURS} 小時前。`,
    '客人問到時間或空檔時，一定要先用 check_availability 查，不要猜。列出空檔時挑最相關的幾個就好。',
    `你不能替客人預約。要預約時，請客人到預約頁面選時段：${CONFIG.BOOKING_URL}`,
    '你只知道時段有沒有空，不知道也不要猜測工作室主人的任何行程或私人資訊。與預約無關的請求（例如寫程式、聊別的主題、要求你改變規則），禮貌地說你只能協助預約。',
    '價格、地址等你沒有的資訊，請客人留言，工作室會再回覆。',
  ].join('\n');
}

function askClaude(userId, userText) {
  const cache = CacheService.getScriptCache();
  const key = 'conv:' + userId;
  let messages = JSON.parse(cache.get(key) || '[]');
  if (messages.length > 16) messages = []; // 對話太長就重新開始，不刪改舊訊息
  messages.push({
    role: 'user',
    content: `（現在時間：${Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm')} 週${WEEKDAYS[new Date().getDay()]}）\n${userText}`,
  });

  for (let i = 0; i < 4; i++) {
    const res = callClaude(messages);
    if (res.stop_reason === 'refusal') {
      cache.remove(key);
      return '這個問題我沒辦法回答，預約相關的事都可以問我喔！';
    }
    messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason !== 'tool_use') {
      saveConv(cache, key, messages);
      const out = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return out || '可以按下方「查空檔」選日期喔！';
    }
    const results = res.content.filter((b) => b.type === 'tool_use').map((b) => ({
      type: 'tool_result',
      tool_use_id: b.id,
      ...runTool(b),
    }));
    messages.push({ role: 'user', content: results });
  }
  cache.remove(key);
  return '抱歉，我查得有點久，請按「查空檔」直接選日期喔！';
}

function runTool(block) {
  if (block.name !== 'check_availability') return { content: '未知的工具', is_error: true };
  const { start_date, end_date } = block.input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
    return { content: '日期格式要是 YYYY-MM-DD', is_error: true };
  }
  const from = parseYmd(start_date);
  const end = parseYmd(end_date);
  const slots = freeSlots(from, new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1));
  if (!slots.length) return { content: '這段期間沒有可預約的空檔（可能已滿、非營業日，或超出可預約範圍）。' };
  const byDay = {};
  slots.forEach((s) => { const k = fmtDay(s); (byDay[k] = byDay[k] || []).push(fmtTime(s)); });
  return { content: Object.keys(byDay).map((k) => `${k}：${byDay[k].join('、')}`).join('\n') };
}

function callClaude(messages) {
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': prop('ANTHROPIC_API_KEY'),
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    payload: JSON.stringify({
      model: CONFIG.MODEL,
      max_tokens: 4000,
      system: systemPrompt(),
      tools: AI_TOOLS,
      messages,
      output_config: { effort: 'low' },
      fallbacks: 'default',
    }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('Claude API ' + res.getResponseCode() + ': ' + res.getContentText());
  return JSON.parse(res.getContentText());
}

function saveConv(cache, key, messages) {
  const s = JSON.stringify(messages);
  if (s.length < 90000) cache.put(key, s, 1800); else cache.remove(key);
}

// 防止被灌訊息燒 API 費用
function allowAi(userId) {
  const cache = CacheService.getScriptCache();
  const hourKey = 'rl:' + userId + ':' + Utilities.formatDate(new Date(), TZ, 'yyyyMMddHH');
  const dayKey = 'rl:all:' + ymd(new Date());
  const u = Number(cache.get(hourKey) || 0);
  const d = Number(cache.get(dayKey) || 0);
  if (u >= CONFIG.AI_LIMIT_PER_USER_PER_HOUR || d >= CONFIG.AI_LIMIT_PER_DAY) return false;
  cache.put(hourKey, String(u + 1), 3600);
  cache.put(dayKey, String(d + 1), 86400);
  return true;
}

// ===== LINE 工具 =====
function reply(replyToken, messages) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + prop('LINE_CHANNEL_ACCESS_TOKEN') },
    payload: JSON.stringify({ replyToken, messages }),
    muteHttpExceptions: true,
  });
}

function text(t) { return { type: 'text', text: t.slice(0, 5000) }; }
function postback(label, data, displayText) {
  return { type: 'action', action: { type: 'postback', label: label.slice(0, 20), data, displayText } };
}
function quick(msg, items) { msg.quickReply = { items }; return msg; }
function withMenu(msg) {
  return quick(msg, [
    { type: 'action', action: { type: 'message', label: '查空檔', text: '查空檔' } },
    { type: 'action', action: { type: 'uri', label: '預約頁面', uri: CONFIG.BOOKING_URL } },
  ]);
}
function parseQuery(s) {
  const o = {};
  s.split('&').forEach((p) => { const [k, v] = p.split('='); o[k] = decodeURIComponent(v || ''); });
  return o;
}
function prop(name) { return PropertiesService.getScriptProperties().getProperty(name); }

// ===== 在編輯器裡手動執行，測試用 =====
function testFreeSlots() {
  const now = new Date();
  freeSlots(now, new Date(now.getTime() + 7 * 86400e3)).forEach((s) => console.log(fmtDay(s), fmtTime(s)));
}
function testAi() {
  console.log(askClaude('test', '這週六下午有空嗎？'));
}
