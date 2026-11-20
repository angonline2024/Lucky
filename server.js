'use strict';
/*
 * ระบบจองเลข 00-99 สำหรับ LINE OA
 * ไม่มี dependency ภายนอก ใช้ Node.js 18 ขึ้นไป
 *
 *   หน้าลูกค้า  /        (เปิดผ่าน LIFF ใน LINE หรือเว็บ)
 *   หน้าหลังบ้าน /admin   (ใช้ ADMIN_KEY)
 *   Webhook     /webhook (ตั้งใน Messaging API ของ LINE OA)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const env = process.env;
const DEV = env.DEV_MODE === '1';
const PORT = Number(env.PORT) || 3000;
const LIFF_ID = env.LIFF_ID || '';
const LOGIN_CHANNEL_ID = env.LINE_LOGIN_CHANNEL_ID || '';
const CHANNEL_TOKEN = env.LINE_CHANNEL_ACCESS_TOKEN || '';
const CHANNEL_SECRET = env.LINE_CHANNEL_SECRET || '';
const ADMIN_USER_IDS = (env.ADMIN_LINE_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const DATA_FILE = env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
let ADMIN_KEY = env.ADMIN_KEY || '';

const MAX_PER_ORDER = 30;
const MAX_PENDING_PER_USER = 60;
const NUM = /^\d{2}$/;

if (DEV && !ADMIN_KEY) ADMIN_KEY = 'dev';
if (!DEV) {
  const problems = [];
  if (ADMIN_KEY.length < 12) problems.push('ADMIN_KEY ต้องตั้งค่าและยาวอย่างน้อย 12 ตัวอักษร');
  if (!LIFF_ID) problems.push('ยังไม่ได้ตั้งค่า LIFF_ID');
  if (!LOGIN_CHANNEL_ID) problems.push('ยังไม่ได้ตั้งค่า LINE_LOGIN_CHANNEL_ID');
  if (problems.length) {
    console.error('เริ่มระบบไม่ได้:\n - ' + problems.join('\n - '));
    console.error('ดูตัวอย่างใน .env.example หรือทดลองในเครื่องด้วย DEV_MODE=1');
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/* ข้อมูล: เก็บเป็นไฟล์ JSON (เขียนแบบ atomic) เหมาะกับ 100 เลข        */
/* ------------------------------------------------------------------ */
const DEFAULT_SETTINGS = {
  shopName: 'ผังจองเลข',
  defaultPrice: 100,
  promptpayId: '',
  accountName: '',
  lineUrl: '',
  closed: false,
  holdMinutes: 0,
};
const db = { settings: { ...DEFAULT_SETTINGS }, prices: {}, bookings: {} };

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    db.settings = { ...DEFAULT_SETTINGS, ...(j.settings || {}) };
    db.prices = j.prices || {};
    db.bookings = j.bookings || {};
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}
function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}
load();

const priceOf = (n) => (db.prices[n] != null ? Number(db.prices[n]) : Number(db.settings.defaultPrice) || 0);
const liffUrl = () => (LIFF_ID ? 'https://liff.line.me/' + LIFF_ID : 'http://localhost:' + PORT + '/');
const baht = (n) => Number(n).toLocaleString('th-TH');

function makeCode(prefix) {
  const a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (;;) {
    let s = prefix || '';
    while (s.length < 5) s += a[crypto.randomInt(a.length)];
    if (!Object.values(db.bookings).some((b) => b.groupId === s)) return s;
  }
}

/* ------------------------------------------------------------------ */
/* PromptPay (EMVCo) QR payload                                       */
/* ------------------------------------------------------------------ */
function crc16(s) {
  let c = 0xffff;
  for (let i = 0; i < s.length; i++) {
    c ^= s.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) c = (c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1) & 0xffff;
  }
  return c.toString(16).toUpperCase().padStart(4, '0');
}
const tlv = (id, v) => id + String(v.length).padStart(2, '0') + v;
function ppKind(raw) {
  const d = String(raw || '').replace(/[^0-9]/g, '');
  if (d.length === 10 && d[0] === '0') return { t: '01', v: '0066' + d.slice(1) };
  if (d.length === 11 && d.startsWith('66')) return { t: '01', v: '00' + d };
  if (d.length === 13 && d.startsWith('0066')) return { t: '01', v: d };
  if (d.length === 13) return { t: '02', v: d };
  if (d.length === 15) return { t: '03', v: d };
  return null;
}
function ppPayload(raw, amount) {
  const k = ppKind(raw);
  if (!k) return null;
  const withAmt = Number(amount) > 0;
  const acc = tlv('00', 'A000000677010111') + tlv(k.t, k.v);
  const p =
    tlv('00', '01') + tlv('01', withAmt ? '12' : '11') + tlv('29', acc) + tlv('53', '764') +
    (withAmt ? tlv('54', Number(amount).toFixed(2)) : '') + tlv('58', 'TH') + '6304';
  return p + crc16(p);
}

/* ------------------------------------------------------------------ */
/* มุมมองข้อมูล                                                       */
/* ------------------------------------------------------------------ */
function groupView(gid) {
  const rows = Object.values(db.bookings).filter((b) => b.groupId === gid).sort((a, b) => (a.num < b.num ? -1 : 1));
  if (!rows.length) return null;
  const pending = rows.filter((r) => r.status === 'pending');
  const due = pending.reduce((a, r) => a + r.price, 0);
  const total = rows.reduce((a, r) => a + r.price, 0);
  const hold = Number(db.settings.holdMinutes) || 0;
  return {
    gid,
    name: rows[0].name,
    createdAt: rows[0].createdAt,
    rows: rows.map((r) => ({ n: r.num, price: r.price, status: r.status })),
    due,
    total,
    payload: db.settings.promptpayId && due > 0 ? ppPayload(db.settings.promptpayId, due) : null,
    expiresAt: hold > 0 && pending.length ? Math.min(...pending.map((r) => r.createdAt)) + hold * 60000 : null,
  };
}
function groupsOfUser(userId) {
  const ids = [...new Set(Object.values(db.bookings).filter((b) => b.userId === userId).map((b) => b.groupId))];
  return ids.map(groupView).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}
function publicSettings() {
  const s = db.settings;
  return { shopName: s.shopName, defaultPrice: s.defaultPrice, accountName: s.accountName, closed: s.closed, lineUrl: s.lineUrl, holdMinutes: s.holdMinutes };
}

/* ------------------------------------------------------------------ */
/* LINE: ตรวจ ID token / ส่งข้อความ                                    */
/* ------------------------------------------------------------------ */
const devOutbox = [];
const tokenCache = new Map();
async function verifyIdToken(token) {
  const hit = tokenCache.get(token);
  if (hit && hit.exp > Date.now() / 1000) return hit;
  try {
    const r = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: token, client_id: LOGIN_CHANNEL_ID }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.sub) return null;
    if (tokenCache.size > 2000) tokenCache.clear();
    const v = { userId: j.sub, name: j.name || '', exp: j.exp };
    tokenCache.set(token, v);
    return v;
  } catch (e) {
    console.error('verify id token error:', e.message);
    return null;
  }
}
async function authUser(req) {
  if (DEV) return { userId: String(req.headers['x-dev-user'] || 'dev-user').slice(0, 64), name: 'ลูกค้าทดสอบ' };
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return m ? verifyIdToken(m[1]) : null;
}
async function lineCall(endpoint, body) {
  if (!CHANNEL_TOKEN) {
    if (DEV) devOutbox.push({ endpoint, body });
    return;
  }
  try {
    const r = await fetch('https://api.line.me/v2/bot/message/' + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + CHANNEL_TOKEN },
      body: JSON.stringify(body),
    });
    if (!r.ok) console.error('LINE', endpoint, 'failed', r.status, await r.text());
  } catch (e) {
    console.error('LINE', endpoint, 'error:', e.message);
  }
}
const push = (to, text) => (to ? lineCall('push', { to, messages: [{ type: 'text', text: text.slice(0, 4800) }] }) : undefined);
const reply = (replyToken, text) => lineCall('reply', { replyToken, messages: [{ type: 'text', text: text.slice(0, 4800) }] });
const notifyAdmins = (text) => ADMIN_USER_IDS.forEach((id) => push(id, text));
const numsText = (rows) => rows.map((r) => r.n || r.num).sort().join(', ');

/* ------------------------------------------------------------------ */
/* ปล่อยเลขที่ค้างชำระเกินเวลา                                         */
/* ------------------------------------------------------------------ */
function sweep() {
  const hold = Number(db.settings.holdMinutes) || 0;
  if (hold <= 0) return;
  const cutoff = Date.now() - hold * 60000;
  const expired = Object.values(db.bookings).filter((b) => b.status === 'pending' && b.createdAt < cutoff);
  if (!expired.length) return;
  const byGroup = {};
  expired.forEach((b) => {
    delete db.bookings[b.num];
    (byGroup[b.groupId] = byGroup[b.groupId] || { userId: b.userId, rows: [] }).rows.push(b);
  });
  save();
  Object.keys(byGroup).forEach((gid) => {
    const g = byGroup[gid];
    push(g.userId, `การจองรหัส ${gid} หมดเวลาชำระ\nเลข ${numsText(g.rows)} กลับไปว่างแล้ว หากยังต้องการ กรุณาจองใหม่ที่ ${liffUrl()}`);
  });
}
setInterval(sweep, 60000).unref();

/* ------------------------------------------------------------------ */
/* HTTP พื้นฐาน                                                        */
/* ------------------------------------------------------------------ */
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const a = (hits.get(key) || []).filter((t) => now - t < windowMs);
  a.push(now);
  hits.set(key, a);
  return a.length > max;
}
setInterval(() => hits.clear(), 10 * 60000).unref();
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || '';

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function readRaw(req, limit = 200 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const raw = await readRaw(req);
  if (!raw.length) return {};
  try {
    const j = JSON.parse(raw.toString('utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (e) {
    throw Object.assign(new Error('bad json'), { status: 400 });
  }
}
function isAdmin(req) {
  const k = req.headers['x-admin-key'];
  if (!ADMIN_KEY || typeof k !== 'string') return false;
  const h = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(k), h(ADMIN_KEY));
}
const cleanPhone = (p) => String(p || '').replace(/[^0-9]/g, '');

/* ------------------------------------------------------------------ */
/* API ลูกค้า                                                          */
/* ------------------------------------------------------------------ */
function publicState() {
  const slots = {};
  Object.values(db.bookings).forEach((b) => (slots[b.num] = { status: b.status, price: b.price }));
  return { cfg: { liffId: LIFF_ID, dev: DEV }, settings: publicSettings(), prices: db.prices, slots };
}

async function handleBook(req, res) {
  const user = await authUser(req);
  if (!user) return send(res, 401, { error: 'login' });
  if (limited('book:' + user.userId, 12, 60000)) return send(res, 429, { error: 'slow' });
  const body = await readJson(req);
  sweep();
  if (db.settings.closed) return send(res, 403, { error: 'closed' });
  const nums = [...new Set((Array.isArray(body.numbers) ? body.numbers : []).map(String))];
  if (!nums.length || nums.length > MAX_PER_ORDER || nums.some((n) => !NUM.test(n))) return send(res, 400, { error: 'bad_numbers' });
  const name = String(body.name || '').trim().slice(0, 60);
  if (!name) return send(res, 400, { error: 'name' });
  const phone = cleanPhone(body.phone);
  if (phone && (phone.length < 9 || phone.length > 10)) return send(res, 400, { error: 'phone' });
  const taken = nums.filter((n) => db.bookings[n]);
  if (taken.length) return send(res, 409, { error: 'taken', numbers: taken.sort() });
  const open = Object.values(db.bookings).filter((b) => b.userId === user.userId && b.status === 'pending').length;
  if (open + nums.length > MAX_PENDING_PER_USER) return send(res, 429, { error: 'too_many_pending' });

  const gid = makeCode();
  const now = Date.now();
  nums.sort().forEach((n) => {
    db.bookings[n] = { num: n, name, phone, price: priceOf(n), status: 'pending', groupId: gid, userId: user.userId, note: '', createdAt: now, updatedAt: now, paidAt: null };
  });
  save();
  const g = groupView(gid);
  const hold = g.expiresAt ? `\nชำระภายใน ${new Date(g.expiresAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'short' })}` : '';
  push(user.userId, `จองเลข ${numsText(g.rows)} สำเร็จ\nรหัสจอง ${gid}\nยอดชำระ ${baht(g.due)} บาท${hold}\nสแกนจ่ายและดูใบสรุปได้ที่ ${liffUrl()}\nชำระแล้วส่งสลิปในแชทนี้ได้เลย`);
  notifyAdmins(`มีการจองใหม่\nรหัส ${gid} · ${name}${phone ? ' · ' + phone : ''}\nเลข ${numsText(g.rows)}\nยอด ${baht(g.due)} บาท`);
  send(res, 200, { group: g });
}

/* ------------------------------------------------------------------ */
/* API หลังบ้าน                                                        */
/* ------------------------------------------------------------------ */
function validateSettings(b, cur) {
  const out = {};
  if ('shopName' in b) out.shopName = String(b.shopName || '').trim().slice(0, 80) || DEFAULT_SETTINGS.shopName;
  if ('accountName' in b) out.accountName = String(b.accountName || '').trim().slice(0, 80);
  if ('promptpayId' in b) {
    const p = String(b.promptpayId || '').trim();
    if (p && !ppKind(p)) return { error: 'promptpay' };
    out.promptpayId = p;
  }
  if ('lineUrl' in b) {
    const u = String(b.lineUrl || '').trim();
    if (u && !/^https:\/\//i.test(u)) return { error: 'line_url' };
    out.lineUrl = u.slice(0, 300);
  }
  if ('closed' in b) out.closed = !!b.closed;
  if ('holdMinutes' in b) {
    const h = Number(b.holdMinutes) || 0;
    if (!Number.isInteger(h) || h < 0 || h > 10080) return { error: 'hold' };
    out.holdMinutes = h;
  }
  if ('defaultPrice' in b) {
    const p = Number(b.defaultPrice);
    if (!isFinite(p) || p < 0 || p > 1e7) return { error: 'price' };
    out.defaultPrice = p;
  }
  return { value: { ...cur, ...out } };
}

async function handleAdmin(req, res, url) {
  const ip = clientIp(req);
  if (!isAdmin(req)) {
    if (limited('adminfail:' + ip, 10, 60000)) return send(res, 429, { error: 'slow' });
    return send(res, 401, { error: 'admin' });
  }
  const p = url.pathname;
  const m = req.method;
  let r;

  if (m === 'GET' && p === '/api/admin/state') {
    sweep();
    return send(res, 200, { settings: db.settings, prices: db.prices, bookings: db.bookings, liffUrl: liffUrl(), cfg: { liffId: LIFF_ID, dev: DEV } });
  }
  if (m === 'PUT' && p === '/api/admin/settings') {
    const v = validateSettings(await readJson(req), db.settings);
    if (v.error) return send(res, 400, { error: v.error });
    db.settings = v.value;
    save();
    return send(res, 200, { settings: db.settings });
  }
  if (m === 'PUT' && p === '/api/admin/prices') {
    const b = await readJson(req);
    const def = 'defaultPrice' in b ? Number(b.defaultPrice) : Number(db.settings.defaultPrice);
    if (!isFinite(def) || def < 0 || def > 1e7) return send(res, 400, { error: 'price' });
    const map = {};
    const src = b.map && typeof b.map === 'object' ? b.map : {};
    for (const n of Object.keys(src)) {
      const v = Number(src[n]);
      if (!NUM.test(n) || !isFinite(v) || v < 0 || v > 1e7) return send(res, 400, { error: 'price' });
      if (v !== def) map[n] = v;
    }
    db.settings.defaultPrice = def;
    db.prices = map;
    save();
    return send(res, 200, { settings: db.settings, prices: db.prices });
  }
  if ((r = /^\/api\/admin\/booking\/(\d{2})$/.exec(p))) {
    const n = r[1];
    if (m === 'DELETE') {
      delete db.bookings[n];
      save();
      return send(res, 200, { ok: true });
    }
    if (m === 'PUT') {
      const b = await readJson(req);
      const price = Number(b.price);
      const st = b.status;
      if (b.price === '' || b.price == null || !isFinite(price) || price < 0) return send(res, 400, { error: 'price' });
      if (!['free', 'pending', 'paid'].includes(st)) return send(res, 400, { error: 'status' });
      const old = db.bookings[n];
      if (st === 'free') {
        if (price === Number(db.settings.defaultPrice)) delete db.prices[n];
        else db.prices[n] = price;
        delete db.bookings[n];
      } else {
        const name = String(b.name || '').trim().slice(0, 60);
        if (!name) return send(res, 400, { error: 'name' });
        const now = Date.now();
        db.bookings[n] = {
          num: n, name, phone: cleanPhone(b.phone).slice(0, 15), price, status: st,
          note: String(b.note || '').trim().slice(0, 120),
          groupId: (old && old.groupId) || makeCode('ADM'),
          userId: (old && old.userId) || '',
          createdAt: (old && old.createdAt) || now, updatedAt: now,
          paidAt: st === 'paid' ? (old && old.paidAt) || now : null,
        };
        if (st === 'paid' && (!old || old.status !== 'paid') && old && old.userId) push(old.userId, `ยืนยันการชำระเงินเลข ${n} แล้ว ขอบคุณค่ะ`);
      }
      save();
      return send(res, 200, { ok: true });
    }
  }
  if ((r = /^\/api\/admin\/group\/([A-Z0-9]{3,8})$/.exec(p)) && m === 'DELETE') {
    const rows = Object.values(db.bookings).filter((b) => b.groupId === r[1]);
    if (!rows.length) return send(res, 404, { error: 'not_found' });
    rows.forEach((b) => delete db.bookings[b.num]);
    save();
    if (rows[0].userId) push(rows[0].userId, `การจองรหัส ${r[1]} (เลข ${numsText(rows)}) ถูกยกเลิก หากมีข้อสงสัยกรุณาติดต่อแอดมิน`);
    return send(res, 200, { ok: true });
  }
  if ((r = /^\/api\/admin\/group\/([A-Z0-9]{3,8})\/paid$/.exec(p)) && m === 'POST') {
    const rows = Object.values(db.bookings).filter((b) => b.groupId === r[1] && b.status === 'pending');
    if (!rows.length) return send(res, 404, { error: 'not_found' });
    const now = Date.now();
    rows.forEach((b) => Object.assign(b, { status: 'paid', paidAt: now, updatedAt: now }));
    save();
    if (rows[0].userId) push(rows[0].userId, `ยืนยันการชำระเงินแล้ว\nรหัสจอง ${r[1]} เลข ${numsText(rows)}\nขอบคุณค่ะ`);
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'not_found' });
}

/* ------------------------------------------------------------------ */
/* Webhook ของ LINE OA                                                 */
/* ------------------------------------------------------------------ */
async function handleWebhook(req, res) {
  const raw = await readRaw(req, 1024 * 1024);
  if (!CHANNEL_SECRET) return send(res, 503, { error: 'webhook_not_configured' });
  const sig = String(req.headers['x-line-signature'] || '');
  const expect = crypto.createHmac('sha256', CHANNEL_SECRET).update(raw).digest('base64');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return send(res, 401, { error: 'signature' });
  res.writeHead(200).end('ok');
  let events = [];
  try { events = JSON.parse(raw.toString('utf8')).events || []; } catch (e) { return; }
  for (const ev of events) {
    const uid = ev.source && ev.source.userId;
    if (ev.type === 'follow') {
      reply(ev.replyToken, `ยินดีต้อนรับค่ะ กดเลือกเลขและจองได้ที่นี่\n${liffUrl()}`);
    } else if (ev.type === 'message' && ev.message) {
      if (ev.message.type === 'image') {
        const open = uid ? groupsOfUser(uid).filter((g) => g.due > 0) : [];
        reply(ev.replyToken, 'รับสลิปแล้วค่ะ แอดมินจะตรวจสอบและยืนยันให้เร็วที่สุด');
        notifyAdmins('ลูกค้าส่งสลิปในแชท LINE\n' + (open.length ? open.map((g) => `รหัส ${g.gid} · ${g.name} · ${baht(g.due)} บาท`).join('\n') : 'ไม่พบรายการรอชำระของลูกค้ารายนี้ กรุณาตรวจในแชท'));
      } else if (ev.message.type === 'text') {
        reply(ev.replyToken, `กดเพื่อเลือกเลขและจอง\n${liffUrl()}`);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* ไฟล์หน้าเว็บ                                                        */
/* ------------------------------------------------------------------ */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' || pathname === '/admin' || pathname === '/admin/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not_found' });
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/healthz') return send(res, 200, { ok: true });
    if (p === '/webhook' && req.method === 'POST') return await handleWebhook(req, res);
    if (p.startsWith('/api/admin/')) return await handleAdmin(req, res, url);
    if (p === '/api/state' && req.method === 'GET') { sweep(); return send(res, 200, publicState()); }
    if (p === '/api/my' && req.method === 'GET') {
      const user = await authUser(req);
      if (!user) return send(res, 401, { error: 'login' });
      sweep();
      return send(res, 200, { name: user.name, groups: groupsOfUser(user.userId) });
    }
    if (p === '/api/book' && req.method === 'POST') return await handleBook(req, res);
    if (DEV && p === '/api/_dev/outbox') return send(res, 200, devOutbox);
    if (p.startsWith('/api/')) return send(res, 404, { error: 'not_found' });
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
    send(res, 405, { error: 'method' });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'server_error' });
    if (!e.status) console.error(e);
  }
});
server.listen(PORT, () => {
  console.log(`ระบบจองเลขพร้อมแล้วที่ http://localhost:${PORT}  (หลังบ้าน /admin)${DEV ? '  [DEV_MODE: ไม่ตรวจ LINE login, รหัสหลังบ้าน = dev]' : ''}`);
});
module.exports = { ppPayload, crc16, ppKind };
