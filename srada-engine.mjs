// =====================================================================
// SRADA — bộ máy tín hiệu vàng chạy 24/7 trên GitHub Actions (không phụ thuộc máy tính ở nhà)
// Mỗi 15 phút: tải nến PAXG (≈ XAU), tìm 2 loại tín hiệu, mô phỏng một TÀI KHOẢN THI QUỸ
// FTMO 2 bước 10.000$ theo đúng luật Srada, rồi báo Telegram.
//   [TUẦN] MACD H1 cắt + giá H1 cùng phía EMA200 + xu hướng H4   · SL 1,5×ATR H1
//   [NGÀY] RSI(2) M15 hồi sâu (<15 / >85) + giá M15 cùng phía EMA50 + xu hướng H4 · SL 1×ATR H1
// Quản lý lệnh: khối lượng theo % rủi ro, SL bậc thang (lãi BE_USD giá → SL về điểm vào,
// sau đó SL luôn cách giá tốt nhất TRAIL_USD, nhảy từng bước STEP_USD), tối đa 24 giờ.
// Luật quỹ: lỗ ngày 5% (Srada tự dừng ở DAY_GUARD), lỗ tổng 10% (tự dừng ở MAX_GUARD),
// vòng 1 +10%, vòng 2 +5%, tối thiểu 4 ngày giao dịch. Ngày tính theo giờ Trung Âu.
// =====================================================================
import fs from 'node:fs';

const env = (k, d) => (process.env[k] ?? '') === '' ? d : process.env[k];
const CFG = {
  ACCOUNT: +env('ACCOUNT', 10000),
  RISK_PCT: { week: +env('RISK_WEEK_PCT', 0.5), day: +env('RISK_DAY_PCT', 0.5) },
  MAX_OPEN_RISK_PCT: +env('MAX_OPEN_RISK_PCT', 1.0),
  DAY_GUARD_PCT: +env('DAY_GUARD_PCT', 3.5),   // Srada tự dừng trong ngày (luật quỹ 5%)
  MAX_GUARD_PCT: +env('MAX_GUARD_PCT', 8),     // Srada dừng hẳn (luật quỹ 10%)
  RULE_DAY_PCT: 5, RULE_MAX_PCT: 10,
  TARGET_PCT: { 1: 10, 2: 5 }, TARGET_BUFFER_PCT: +env('TARGET_BUFFER_PCT', 0.3), MIN_DAYS: 4,
  TP1_R: +env('TP1_R', 0),            // 0 = không chốt một phần
  PART_PCT: +env('PART_PCT', 50),
  TP2_R: +env('TP2_R', 0),            // 0 = không đặt TP cố định
  // SL bậc thang theo từng loại (kiểm chứng 07/2025–10/2026 trên nến M5: NGÀY 5/5, TUẦN 10/10 cho kết quả tốt nhất)
  BE_USD: { day: +env('BE_DAY', 5), week: +env('BE_WEEK', 10) },        // lãi bao nhiêu giá thì SL về điểm vào
  TRAIL_USD: { day: +env('TRAIL_DAY', 5), week: +env('TRAIL_WEEK', 10) }, // sau đó SL cách giá tốt nhất bao nhiêu giá
  STEP_USD: +env('STEP_USD', 1),      // SL nhảy theo bước bao nhiêu giá
  SPREAD: 0.35, MAX_HOLD_H: 24,
  MODES: env('MODES', 'week,day').split(',').map(s => s.trim()).filter(Boolean),
  LOCK_BEFORE: 30,
  WEEKLY_REPORT_DOW: 0, WEEKLY_REPORT_HOUR_VN: 9,
};
const MODE = {
  week: { tag: 'TUẦN', slm: 1.5, barSec: 3600, fresh: 3 },
  day:  { tag: 'NGÀY', slm: 1.0, barSec: 900,  fresh: 8, rsiLo: 15, rsiHi: 85 },
};
const STATE_FILE = 'data/srada.json';
const TG_TOKEN = process.env.TELEGRAM_TOKEN, TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const TZ = 'Asia/Ho_Chi_Minh';
const OZ = 100;   // 1 lot vàng = 100 oz → 1 giá × 1 lot = 100$

// ---------- tiện ích ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = (n, d = 2) => n == null || isNaN(n) ? '—' : (+n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = n => (n >= 0 ? '+' : '−') + '$' + fmt(Math.abs(n), 2);
const pct = (n, d = 2) => (n >= 0 ? '+' : '−') + fmt(Math.abs(n), d) + '%';
const vn = ms => new Date(ms).toLocaleString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
const ceDay = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/Prague' });   // giờ máy chủ FTMO
async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'srada/1.0', Accept: 'application/json' } });
      if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
      if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === tries - 1) throw e; await sleep(1000 * (i + 1)); }
  }
}
const xauOpen = t => { const d = new Date(t * 1000); const w = d.getUTCDay(), h = d.getUTCHours(); return !((w === 5 && h >= 21) || w === 6 || (w === 0 && h < 23)) && h !== 21; };

// ---------- chỉ báo (giống hệt bộ kiểm chứng) ----------
const ema = (v, n) => { const k = 2 / (n + 1), o = new Array(v.length); let p; for (let i = 0; i < v.length; i++) { p = i ? v[i] * k + p * (1 - k) : v[i]; o[i] = i < n - 1 ? NaN : p; } return o; };
const rma = (v, n) => { const o = new Array(v.length).fill(NaN); let a = NaN, s = 0; for (let i = 0; i < v.length; i++) { if (i < n) { s += v[i]; if (i === n - 1) { a = s / n; o[i] = a; } } else { a = (a * (n - 1) + v[i]) / n; o[i] = a; } } return o; };
const atr = (K, n = 14) => rma(K.map((k, i) => i ? Math.max(k.h - k.l, Math.abs(k.h - K[i - 1].c), Math.abs(k.l - K[i - 1].c)) : k.h - k.l), n);
const rsi = (c, n) => { const up = [0], dn = [0]; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; up.push(Math.max(d, 0)); dn.push(Math.max(-d, 0)); } const u = rma(up, n), d = rma(dn, n); return u.map((x, i) => d[i] === 0 ? 100 : 100 - 100 / (1 + x / d[i])); };
function macd(c) { const f = ema(c, 12), s = ema(c, 26), m = c.map((_, i) => f[i] - s[i]); const sg = ema(m.map(x => isNaN(x) ? 0 : x), 9); return { m, s: sg.map((x, i) => i < 34 ? NaN : x) }; }
function toH4(H) { const o = []; for (const k of H) { const b = Math.floor(k.t / 14400) * 14400; const l = o[o.length - 1]; if (l && l.t === b) { l.h = Math.max(l.h, k.h); l.l = Math.min(l.l, k.l); l.c = k.c; } else o.push({ t: b, o: k.o, h: k.h, l: k.l, c: k.c }); } return o; }

// ---------- dữ liệu ----------
async function loadCandles(gran, bars) {
  const out = new Map(); let end = Math.floor(Date.now() / 1000);
  for (let p = 0; p < Math.ceil(bars / 300); p++) {
    const start = end - gran * 300;
    const d = await getJSON(`https://api.exchange.coinbase.com/products/PAXG-USD/candles?granularity=${gran}&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`);
    if (!Array.isArray(d) || !d.length) break;
    for (const k of d) out.set(k[0], { t: k[0], o: +k[3], h: +k[2], l: +k[1], c: +k[4] });
    end = start; await sleep(250);
  }
  return [...out.values()].sort((a, b) => a.t - b.t).slice(-bars);
}
async function loadSpot() { try { const d = await getJSON('https://api.gold-api.com/price/XAU'); return { p: +d.price, at: Date.parse(d.updatedAt) || Date.now() }; } catch { return null; } }
const EV_VI = [[/adp/i, 'Việc làm ADP'], [/non-?farm/i, 'NFP (bảng lương phi nông nghiệp)'], [/unemployment rate/i, 'Tỷ lệ thất nghiệp'], [/cpi/i, 'CPI (lạm phát)'], [/federal funds|rate decision/i, 'Quyết định lãi suất Fed'], [/press conference/i, 'Họp báo Fed'], [/pce/i, 'PCE (lạm phát)'], [/gdp/i, 'GDP'], [/retail sales/i, 'Doanh số bán lẻ'], [/ism manufacturing/i, 'PMI sản xuất ISM'], [/ism services/i, 'PMI dịch vụ ISM'], [/ppi/i, 'PPI'], [/jolts/i, 'JOLTS'], [/claims/i, 'Đơn thất nghiệp']];
const evVi = t => (EV_VI.find(([re]) => re.test(t)) || [0, t])[1];
async function loadCalendar(state) {
  if (state.cal && Date.now() - state.cal.at < 3 * 36e5) return state.cal.items;
  try {
    const a = await getJSON('https://nfs.faireconomy.media/ff_calendar_thisweek.json', 2);
    const items = a.filter(e => e.country === 'USD' && e.impact === 'High').map(e => ({ t: Date.parse(e.date), title: e.title }));
    state.cal = { at: Date.now(), items }; return items;
  } catch (e) { console.log('Không tải được lịch:', e.message); return state.cal?.items || []; }
}

// ---------- xu hướng H4 & ATR H1 ----------
function context(H) {
  const now = Date.now() / 1000;
  const Hc = H.filter(k => k.t + 3600 <= now);
  const H4 = toH4(Hc).filter(k => k.t + 14400 <= now);
  const c4 = H4.map(k => k.c), e4 = ema(c4, 200), M4 = macd(c4);
  const i4 = new Map(); H4.forEach((k, i) => i4.set(k.t, i));
  const A = atr(Hc, 14), iH = new Map(); Hc.forEach((k, i) => iH.set(k.t, i));
  const trendJ = j => (c4[j] > e4[j] && M4.m[j] > M4.s[j]) ? 1 : (c4[j] < e4[j] && M4.m[j] < M4.s[j]) ? -1 : 0;
  const st4At = t => { const j = i4.get(Math.floor(t / 14400) * 14400 - 14400); return j == null ? 0 : trendJ(j); };
  const atrAt = t => { const j = iH.get(Math.floor(t / 3600) * 3600 - 3600); return j == null ? NaN : A[j]; };
  return { Hc, st4At, atrAt, st4Now: trendJ(H4.length - 1) };
}
function detectWeek(ctx) {
  const H = ctx.Hc, c = H.map(k => k.c), e200 = ema(c, 200), M = macd(c), A = atr(H, 14);
  const n = H.length - 1, found = [];
  for (let i = n; i > n - MODE.week.fresh && i > 0; i--) {
    const x = M.m[i] > M.s[i] && M.m[i - 1] <= M.s[i - 1] ? 1 : M.m[i] < M.s[i] && M.m[i - 1] >= M.s[i - 1] ? -1 : 0;
    if (!x || !xauOpen(H[i].t) || (c[i] > e200[i] ? 1 : -1) !== x) continue;
    if (ctx.st4At(H[i].t + 3600) !== x) continue;
    found.push({ mode: 'week', dir: x, barT: H[i].t, entryT: H[i].t + 3600, entry: c[i], atr: A[i] });
  }
  return found;
}
function detectDay(ctx, M15) {
  const now = Date.now() / 1000;
  const M = M15.filter(k => k.t + 900 <= now), c = M.map(k => k.c), r2 = rsi(c, 2), e50 = ema(c, 50);
  const n = M.length - 1, found = [];
  for (let i = n; i > n - MODE.day.fresh && i > 60; i--) {
    if (!xauOpen(M[i].t)) continue;
    const st = ctx.st4At(M[i].t);
    const x = st > 0 && r2[i] < MODE.day.rsiLo && c[i] > e50[i] ? 1 : st < 0 && r2[i] > MODE.day.rsiHi && c[i] < e50[i] ? -1 : 0;
    if (!x) continue;
    const a = ctx.atrAt(M[i].t); if (!(a > 0)) continue;
    found.push({ mode: 'day', dir: x, barT: M[i].t, entryT: M[i].t + 900, entry: c[i], atr: a, rsi2: +r2[i].toFixed(1) });
  }
  return found;
}

// ---------- khối lượng theo rủi ro ----------
function sizeLot(R, riskUSD) {
  let lot = Math.floor(riskUSD / (R * OZ) / 0.01 + 1e-9) * 0.01;
  if (lot < 0.01) lot = 0.01 * OZ * R <= riskUSD * 1.5 ? 0.01 : 0;
  return +lot.toFixed(2);
}
const ladderLock = (gain, mode) => {   // số giá đã khoá lãi theo SL bậc thang (null = chưa tới mốc về điểm vào)
  if (!(CFG.BE_USD[mode] > 0) || gain < CFG.BE_USD[mode]) return null;
  let x = gain - CFG.TRAIL_USD[mode]; if (CFG.STEP_USD > 0) x = Math.floor(x / CFG.STEP_USD + 1e-9) * CFG.STEP_USD;
  return Math.max(0, x);
};

// ---------- theo dõi lệnh trên nến M15 (đường giá mở → đáy/đỉnh → đóng) ----------
function track(sig, bars, events) {
  if (sig.status === 'closed') return;
  const now = Date.now() / 1000, bs = 900;
  const list = bars.filter(k => k.t >= sig.entryT && k.t < sig.entryT + CFG.MAX_HOLD_H * 3600);
  const d = sig.dir, R = sig.R;
  const pnl = (price, lots) => (price - sig.entry) * d * lots * OZ;
  let tp1 = false, tp1T = null, out = null, exitP = null, exitT = null, v = 0, lots = sig.lot;
  let sl = sig.sl, best = sig.entry, beT = null, lock = null, worst = 0;
  outer: for (const k of list) {
    const closed = k.t + bs <= now;
    const path = k.c >= k.o ? [k.o, k.l, k.h, k.c] : [k.o, k.h, k.l, k.c];
    for (let q = 1; q < 4; q++) {
      const a = path[q - 1], b = path[q]; if (a === b) continue;
      if ((b - a) * d < 0) {
        worst = Math.min(worst, v + pnl(b, lots));
        if ((b - sl) * d <= 0) {
          exitP = (a - sl) * d <= 0 ? a : sl; exitT = k.t; v += pnl(exitP, lots);
          const g = (exitP - sig.entry) * d;
          out = g < -0.01 ? 'sl' : g > 0.5 ? 'trail' : 'be';
          break outer;
        }
      } else {
        if (sig.tp1 != null && !tp1 && (b - sig.tp1) * d >= 0) {
          tp1 = true; tp1T = k.t; v += pnl(sig.tp1, sig.partial); lots = +(lots - sig.partial).toFixed(2);
          if ((sl - sig.entry) * d < 0) sl = sig.entry;
        }
        if (sig.tp2 != null && (b - sig.tp2) * d >= 0) { out = 'tp2'; exitP = sig.tp2; exitT = k.t; v += pnl(sig.tp2, lots); break outer; }
        best = d > 0 ? Math.max(best, b) : Math.min(best, b);
        const lk = ladderLock((best - sig.entry) * d, sig.mode);
        if (lk != null) {
          if (beT == null) beT = k.t;
          const want = sig.entry + d * lk;
          if ((want - sl) * d > 0 || (want - sl) * d === 0) { sl = want; lock = lk; }
        }
      }
    }
    if (!closed) { worst = Math.min(worst, v + pnl(k.c, lots)); break; }
  }
  if (!out && now >= sig.entryT + CFG.MAX_HOLD_H * 3600 && list.length) {
    const last = list[list.length - 1]; out = 'time'; exitP = last.c; exitT = last.t; v += pnl(exitP, lots);
  }
  sig.slNow = +sl.toFixed(2); sig.best = +best.toFixed(2); sig.worstUSD = +worst.toFixed(2);
  const lastBar = list[list.length - 1];
  sig.floatUSD = !out && lastBar ? +(v + pnl(lastBar.c, lots)).toFixed(2) : 0;
  sig.openRiskUSD = !out ? +Math.max(0, -(v + pnl(sl, lots))).toFixed(2) : 0;
  if (beT != null && !sig.beMoved) { sig.beMoved = true; sig.beAt = (beT + bs) * 1000; if (!out) events.push({ type: 'bemove', sig }); }
  if (lock != null && !out) {
    const lvl = Math.floor(lock / 5) * 5;   // báo mỗi khi khoá thêm 5 giá, tránh nhắn quá nhiều
    if (lvl >= 5 && lvl > (sig.lockNotified || 0)) { sig.lockNotified = lvl; sig.lockNow = lock; events.push({ type: 'lock', sig }); }
  }
  if (tp1 && !sig.tp1Hit) { sig.tp1Hit = true; sig.tp1At = (tp1T + bs) * 1000; if (!out) events.push({ type: 'tp1', sig }); }
  if (out) {
    sig.status = 'closed'; sig.outcome = out; sig.exitPrice = exitP; sig.exitAt = Math.min(Date.now(), (exitT + bs) * 1000);
    sig.usd = +(out === 'be' && !tp1 ? 0 : v - CFG.SPREAD * sig.lot * OZ).toFixed(2);
    sig.Rm = +(sig.usd / sig.riskUSD).toFixed(2);
    events.push({ type: 'close', sig });
  }
}

// ---------- tài khoản thi quỹ ----------
function newAcct(attempt = 1) { return { attempt, phase: 1, bal: CFG.ACCOUNT, peak: CFG.ACCOUNT, days: [], dayKey: null, dayStart: CFG.ACCOUNT, dayLocked: false, maxLocked: false, phaseStartAt: Date.now(), history: [] }; }
const target = A => A.phase <= 2 ? CFG.ACCOUNT * (1 + CFG.TARGET_PCT[A.phase] / 100) : null;
function rollDay(A, ms) { const k = ceDay(ms); if (A.dayKey !== k) { A.dayKey = k; A.dayStart = A.bal; A.dayLocked = false; } }
// áp dụng 1 lệnh đã đóng vào tài khoản, trả về các thông báo về luật quỹ
function applyClose(A, s) {
  const notes = [];
  rollDay(A, s.exitAt);
  const worstEq = A.bal + Math.min(0, s.worstUSD || 0);
  A.bal = +(A.bal + s.usd).toFixed(2); A.peak = Math.max(A.peak, A.bal);
  const dayLoss = A.dayStart - Math.min(A.bal, worstEq);
  if (A.bal <= CFG.ACCOUNT * (1 - CFG.RULE_MAX_PCT / 100) || dayLoss >= CFG.ACCOUNT * CFG.RULE_DAY_PCT / 100) {
    notes.push({ type: 'fail', A: { ...A }, why: A.bal <= CFG.ACCOUNT * 0.9 ? 'lỗ tổng chạm 10%' : 'lỗ trong ngày chạm 5%' });
    A.history.push({ phase: A.phase, result: 'rớt', at: Date.now() });
    Object.assign(A, newAcct(A.attempt + 1), { history: A.history }); return notes;
  }
  if (!A.maxLocked && A.bal <= CFG.ACCOUNT * (1 - CFG.MAX_GUARD_PCT / 100)) { A.maxLocked = true; notes.push({ type: 'maxguard' }); }
  if (!A.dayLocked && A.dayStart - A.bal >= CFG.ACCOUNT * CFG.DAY_GUARD_PCT / 100) { A.dayLocked = true; notes.push({ type: 'dayguard', loss: A.dayStart - A.bal }); }
  const tg = target(A);
  if (tg && A.bal >= tg + CFG.ACCOUNT * CFG.TARGET_BUFFER_PCT / 100 && A.days.length >= CFG.MIN_DAYS) {
    notes.push({ type: 'pass', phase: A.phase, bal: A.bal, days: A.days.length, since: A.phaseStartAt });
    A.history.push({ phase: A.phase, result: 'qua', at: Date.now(), days: A.days.length });
    A.phase += 1; A.bal = CFG.ACCOUNT; A.peak = CFG.ACCOUNT; A.days = []; A.dayStart = CFG.ACCOUNT; A.dayLocked = false; A.maxLocked = false; A.phaseStartAt = Date.now();
  } else if (tg && A.bal >= tg + CFG.ACCOUNT * CFG.TARGET_BUFFER_PCT / 100 && !A.waitDaysNoted) {
    A.waitDaysNoted = true; notes.push({ type: 'waitdays', days: A.days.length });
  }
  return notes;
}
const phaseName = A => A.phase === 1 ? 'Vòng 1' : A.phase === 2 ? 'Vòng 2' : 'Đã cấp vốn';
function panel(A, open = []) {
  const g = (A.bal - CFG.ACCOUNT) / CFG.ACCOUNT * 100, tg = target(A);
  const fl = open.reduce((a, s) => a + (s.floatUSD || 0), 0);
  const dayLoss = Math.max(0, A.dayStart - A.bal - Math.min(0, fl));
  return `🏦 <b>Srada · thi quỹ 10.000$ · ${phaseName(A)}${A.attempt > 1 ? ` (lần thi ${A.attempt})` : ''}</b>\n` +
    `Số dư <b>$${fmt(A.bal)}</b> (${pct(g)}${tg ? ` / mục tiêu +${CFG.TARGET_PCT[A.phase]}%` : ''})` + (fl ? ` · lệnh đang mở ${usd(fl)}` : '') + `\n` +
    `Lỗ hôm nay: $${fmt(dayLoss)} · Srada dừng ở $${fmt(CFG.ACCOUNT * CFG.DAY_GUARD_PCT / 100, 0)} · luật quỹ $${fmt(CFG.ACCOUNT * CFG.RULE_DAY_PCT / 100, 0)}\n` +
    `Đáy tài khoản: luật quỹ $${fmt(CFG.ACCOUNT * 0.9, 0)} · còn cách $${fmt(A.bal - CFG.ACCOUNT * 0.9)}\n` +
    `Ngày giao dịch: ${A.days.length}/${CFG.MIN_DAYS}` + (A.dayLocked ? `\n🛑 Hôm nay đã dừng vào lệnh (chạm ${CFG.DAY_GUARD_PCT}%)` : '') + (A.maxLocked ? `\n⛔ Đã dừng hẳn (chạm ${CFG.MAX_GUARD_PCT}%) — xem lại trước khi chạy tiếp` : '');
}

// ---------- thống kê ----------
function stats(signals, mode) {
  const list = signals.filter(s => s.status === 'closed' && !s.skipped && (!mode || s.mode === mode)).sort((a, b) => a.exitAt - b.exitAt);
  const n = list.length, win = list.filter(s => s.usd > 0).length, loss = list.filter(s => s.usd < 0).length, by = o => list.filter(s => s.outcome === o).length;
  let peak = 0, cum = 0, dd = 0, streak = 0, maxStreak = 0, sumR = 0;
  for (const s of list) { cum += s.usd; sumR += s.Rm || 0; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); if (s.usd < 0) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0; }
  return { n, win, loss, flat: n - win - loss, tp2: by('tp2'), be: by('be'), trail: by('trail'), sl: by('sl'), time: by('time'), winRate: n ? win / n * 100 : 0, usd: +cum.toFixed(2), avgR: n ? +(sumR / n).toFixed(2) : 0, dd: +dd.toFixed(2), maxStreak };
}

// ---------- Telegram ----------
async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.log('--- (chưa cấu hình Telegram) ---\n' + text.replace(/<[^>]+>/g, '') + '\n'); return; }
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }) });
  if (!r.ok) console.log('Telegram lỗi:', r.status, await r.text());
}
const px = (s, p) => fmt(p + (s.basis || 0));
const tagOf = s => `[${MODE[s.mode].tag}]`;
const ladderText = mode => CFG.BE_USD[mode] > 0 ? `🪜 Lãi ${fmt(CFG.BE_USD[mode], 0)} giá → SL về điểm vào; sau đó giá có lợi thêm ${fmt(CFG.STEP_USD, 0)} giá → SL dời thêm ${fmt(CFG.STEP_USD, 0)} giá (SL luôn cách giá tốt nhất ${fmt(CFG.TRAIL_USD[mode], 0)} giá)` : '';
function msgNew(s, cal, spot, A, open) {
  const side = s.dir > 0 ? '🟢 <b>MUA</b>' : '🔴 <b>BÁN</b>';
  const lockEv = cal.find(e => e.t >= s.entryT * 1000 - CFG.LOCK_BEFORE * 6e4 && e.t <= s.entryT * 1000 + 3 * 36e5);
  const why = s.mode === 'week'
    ? `✓ H4 ${s.dir > 0 ? 'tăng' : 'giảm'} (giá ${s.dir > 0 ? 'trên' : 'dưới'} EMA200 + MACD cùng chiều)\n✓ H1 ${s.dir > 0 ? 'trên' : 'dưới'} EMA200, MACD vừa cắt ${s.dir > 0 ? 'lên' : 'xuống'}`
    : `✓ H4 ${s.dir > 0 ? 'tăng' : 'giảm'} (giá ${s.dir > 0 ? 'trên' : 'dưới'} EMA200 + MACD cùng chiều)\n✓ M15 ${s.dir > 0 ? 'hồi sâu' : 'hồi mạnh lên'}: RSI(2) = ${s.rsi2}, giá vẫn ${s.dir > 0 ? 'trên' : 'dưới'} EMA50`;
  let m = `${side} XAU/USD ${tagOf(s)} — Srada #${s.no}\n⏱ Nến ${s.mode === 'week' ? 'H1' : 'M15'} đóng ${vn(s.entryT * 1000)} (giờ VN)\n\n`;
  if (s.skipped) m += `⏸ <b>Srada KHÔNG vào lệnh này</b> — ${s.skipWhy}\n(vẫn theo dõi để thống kê, không tính vào tài khoản)\n\n`;
  m += `📍 Vào: <b>${px(s, s.entry)}</b>${spot ? ` (giá hiện tại ~${fmt(spot.p)})` : ''}\n` +
    `📦 Khối lượng: <b>${fmt(s.lot)} lot</b> (tài khoản 10.000$)\n` +
    `🛑 SL: <b>${px(s, s.sl)}</b> (cách ${fmt(s.R, 1)} giá) → ${usd(-s.riskUSD)} = ${fmt(s.riskUSD / CFG.ACCOUNT * 100)}% tài khoản\n` +
    (s.tp1 != null ? `🎯 TP1: <b>${px(s, s.tp1)}</b> → chốt ${fmt(s.partial)} lot, SL phần còn lại về điểm vào\n` : '') +
    (s.tp2 != null ? `🏁 TP2: <b>${px(s, s.tp2)}</b>\n` : `🏁 Không đặt TP — để SL bậc thang tự chốt lời\n`) +
    `${ladderText(s.mode)}\n⌛ Đóng muộn nhất: ${vn((s.entryT + CFG.MAX_HOLD_H * 3600) * 1000)}\n\n${why}\n`;
  if (lockEv) m += `\n⚠️ Tin mạnh <b>${evVi(lockEv.title)}</b> lúc ${vn(lockEv.t)} — giá có thể giật mạnh, SL bậc thang dễ bị quét.`;
  if (s.lateMin > 20) {
    const moved = spot ? (spot.p - (s.entry + (s.basis || 0))) * s.dir : null;
    m += `\nℹ️ Phát hiện trễ ${s.lateMin} phút` + (moved != null ? ` — giá đã đi ${moved >= 0 ? 'thuận' : 'ngược'} ${fmt(Math.abs(moved))} giá so với điểm vào.` : '.');
    if (moved != null && moved > 0.5 * s.atr) m += ` Giá đã chạy xa: chỉ vào nếu giá hồi lại gần <b>${px(s, s.entry)}</b>, hoặc bỏ qua.`;
  }
  return m + `\n\n${panel(A, open)}\n\n<i>Công cụ hỗ trợ, không phải lời khuyên đầu tư.</i>`;
}
function msgEvent(ev, all, A) {
  const s = ev.sig;
  if (ev.type === 'bemove') return `🛡 <b>#${s.no} ${tagOf(s)} lãi ${fmt(CFG.BE_USD[s.mode], 0)} giá</b> — SL về điểm vào <b>${px(s, s.entry)}</b>, lệnh hết rủi ro.\nTừ giờ SL tự bám theo, luôn cách giá tốt nhất ${fmt(CFG.TRAIL_USD[s.mode], 0)} giá.`;
  if (ev.type === 'lock') return `🪜 <b>#${s.no} ${tagOf(s)}</b> SL đã lên <b>${px(s, s.slNow)}</b> — khoá chắc <b>+${fmt(s.lockNow, 0)} giá</b> (${usd(s.lockNow * (s.lot - (s.tp1Hit ? s.partial : 0)) * OZ)}). Giá tốt nhất ${px(s, s.best)}.`;
  if (ev.type === 'tp1') return `🎯 <b>#${s.no} ${tagOf(s)} chạm TP1</b> ${px(s, s.tp1)} — chốt ${fmt(s.partial)} lot, SL phần còn lại về điểm vào.`;
  const st = stats(all), sm = stats(all, s.mode);
  const icon = { tp2: '🏆', be: '🤝', trail: '🔒', sl: '❌', time: '⌛' }[s.outcome];
  const name = { tp2: 'CHẠM TP2', be: 'HOÀ VỐN (SL ở điểm vào)', trail: 'CHỐT LÃI bằng SL bậc thang', sl: 'CHẠM CẮT LỖ', time: 'HẾT 24 GIỜ, đóng theo giá' }[s.outcome];
  return `${icon} <b>#${s.no} ${tagOf(s)} ${s.dir > 0 ? 'MUA' : 'BÁN'} — ${name}</b>\nĐóng ở ${px(s, s.exitPrice)} (${pct((s.exitPrice - s.entry) * s.dir, 1).replace('%', ' giá')}) · ${fmt(s.lot)} lot · Kết quả: <b>${usd(s.usd)}</b> (${s.Rm >= 0 ? '+' : ''}${s.Rm}R)` +
    (s.skipped ? ' · <i>lệnh Srada không vào, không tính vào tài khoản</i>' : '') + `\n\n` +
    `📊 ${tagOf(s)}: ${sm.n} lệnh · thắng ${sm.win} · thua ${sm.loss} · hoà ${sm.flat} (${fmt(sm.winRate, 0)}% thắng) · ${usd(sm.usd)}\n` +
    `📊 Cả 2 loại: ${st.n} lệnh · ${fmt(st.winRate, 0)}% thắng · TB ${st.avgR >= 0 ? '+' : ''}${st.avgR}R/lệnh\n\n${panel(A, all.filter(x => x.status !== 'closed' && !x.skipped))}`;
}
function msgRule(n, A) {
  if (n.type === 'pass') return n.phase === 1
    ? `🏆🏆 <b>SRADA QUA VÒNG 1!</b> Đạt +10% sau ${Math.round((Date.now() - n.since) / 864e5)} ngày, ${n.days} ngày giao dịch.\nTài khoản ảo chuyển sang <b>Vòng 2 (mục tiêu +5%)</b>, số dư đặt lại 10.000$.`
    : n.phase === 2 ? `🏆🏆🏆 <b>SRADA QUA CẢ 2 VÒNG!</b> Trên tài khoản thật, đây là lúc FTMO cấp vốn.\nTài khoản ảo chuyển sang <b>Đã cấp vốn</b>: từ giờ lãi được tính 80% cho anh.` : '';
  if (n.type === 'waitdays') return `⏳ Đã chạm mục tiêu nhưng mới ${n.days}/${CFG.MIN_DAYS} ngày giao dịch — cần thêm ngày (EA trên MT5 sẽ tự mở lệnh nhỏ nhất cho đủ ngày).`;
  if (n.type === 'dayguard') return `🛑 <b>Srada dừng vào lệnh hôm nay</b> — lỗ trong ngày $${fmt(n.loss)} chạm ngưỡng ${CFG.DAY_GUARD_PCT}% (luật quỹ 5%). Mai (sau 5–6 giờ sáng giờ VN) tự chạy lại.`;
  if (n.type === 'maxguard') return `⛔ <b>Srada DỪNG HẲN</b> — số dư chạm ngưỡng tự bảo vệ ${CFG.MAX_GUARD_PCT}% (luật quỹ 10%). Nên xem lại trước khi chạy tiếp.`;
  if (n.type === 'fail') return `💥 <b>Tài khoản thi RỚT</b> (${n.why}) ở ${phaseName(n.A)}. Trên tài khoản thật sẽ mất phí thi.\nSrada mở lượt thi ảo mới (lần ${A.attempt}).`;
  return '';
}
function msgWeekly(all, A) {
  const weekAgo = Date.now() - 7 * 864e5;
  let m = `📅 <b>Tổng kết tuần — Srada</b>\n`;
  for (const md of CFG.MODES) {
    const wk = all.filter(s => s.mode === md && s.status === 'closed' && s.exitAt >= weekAgo && !s.skipped), w = wk.reduce((a, s) => a + s.usd, 0), sm = stats(all, md);
    m += `\n<b>[${MODE[md].tag}]</b> tuần qua: ${wk.length} lệnh · ${wk.filter(s => s.usd > 0).length} thắng · ${wk.filter(s => s.usd < 0).length} thua · <b>${usd(w)}</b>\n` +
      `   Từ đầu: ${sm.n} lệnh · ${fmt(sm.winRate, 0)}% thắng · chốt lãi bậc thang ${sm.trail} · hoà ${sm.be} · SL ${sm.sl} · hết giờ ${sm.time} · ${usd(sm.usd)}\n`;
  }
  const st = stats(all);
  const open = all.filter(s => s.status !== 'closed' && !s.skipped);
  m += `\nSụt giảm lớn nhất $${fmt(st.dd)} · chuỗi thua dài nhất ${st.maxStreak}` +
    (open.length ? `\n⏳ Đang mở: ${open.map(s => `#${s.no} ${tagOf(s)} ${s.dir > 0 ? 'MUA' : 'BÁN'}`).join(', ')}` : '') +
    `\n\n${panel(A, open)}` +
    `\n\nKiểm chứng 07/2025–10/2026 trên nến M5 (cùng luật): ~61% lệnh có lãi, TB +0,15R/lệnh, có lúc thua 5 lệnh liên tiếp — một tuần chưa nói lên nhiều.`;
  return m;
}

// ---------- chạy ----------
async function main() {
  fs.mkdirSync('data', { recursive: true });
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { version: 1, signals: [], startedAt: Date.now(), acct: newAcct() };
  state.config = { ...CFG, RISK_PCT: CFG.RISK_PCT, TARGET_PCT: CFG.TARGET_PCT };
  const A = state.acct;
  const before = JSON.stringify(state.signals);
  const [H, M15, spot] = await Promise.all([loadCandles(3600, 2400), loadCandles(900, 700), loadSpot()]);
  if (H.length < 1200 || M15.length < 200) throw new Error(`Thiếu dữ liệu nến: H1=${H.length} M15=${M15.length}`);
  const cal = await loadCalendar(state);
  const basis = spot && Date.now() - spot.at < 6 * 36e5 && xauOpen(Date.now() / 1000) ? +(spot.p - M15[M15.length - 1].c).toFixed(2) : 0;
  const ctx = context(H);
  const msgs = [];

  // 1) cập nhật lệnh đang mở
  const events = [];
  for (const s of state.signals) track(s, M15, events);
  const closeAndApply = evs => {
    for (const ev of evs.sort((a, b) => (a.sig.exitAt || 0) - (b.sig.exitAt || 0))) {
      if (ev.type === 'close' && !ev.sig.skipped && !ev.sig.applied) {
        ev.sig.applied = true; const notes = applyClose(A, ev.sig);
        msgs.push(msgEvent(ev, state.signals, A)); for (const n of notes) msgs.push(msgRule(n, A));
      } else msgs.push(msgEvent(ev, state.signals, A));
    }
  };
  closeAndApply(events);
  rollDay(A, Date.now());

  // 2) tín hiệu mới — mỗi loại chỉ 1 lệnh mở tại một thời điểm
  let dirty = false;
  const found = [...(CFG.MODES.includes('week') ? detectWeek(ctx) : []), ...(CFG.MODES.includes('day') ? detectDay(ctx, M15) : [])].sort((a, b) => a.barT - b.barT);
  for (const f of found) {
    const id = `${f.mode}_${f.barT}_${f.dir}`;
    if (state.signals.some(s => s.id === id)) continue;
    const blocker = state.signals.find(s => s.mode === f.mode && (s.status !== 'closed' || (s.exitAt || 0) > f.entryT * 1000));
    if (blocker) { console.log('Đang có lệnh cùng loại, bỏ qua:', id); continue; }
    const R = f.atr * MODE[f.mode].slm, riskWant = CFG.ACCOUNT * CFG.RISK_PCT[f.mode] / 100;
    const lot = sizeLot(R, riskWant), riskUSD = +(R * Math.max(lot, 0.01) * OZ).toFixed(2);
    const open = state.signals.filter(s => s.status !== 'closed' && !s.skipped);
    const openRisk = open.reduce((a, s) => a + (s.openRiskUSD || 0), 0);
    const floatPnl = open.reduce((a, s) => a + (s.floatUSD || 0), 0);
    let skipWhy = null;
    if (A.maxLocked) skipWhy = `đã dừng hẳn (chạm ${CFG.MAX_GUARD_PCT}%)`;
    else if (A.dayLocked) skipWhy = `hôm nay đã chạm ngưỡng lỗ ${CFG.DAY_GUARD_PCT}%`;
    else if (!lot) skipWhy = `SL quá xa (${fmt(R, 1)} giá), lot nhỏ nhất đã vượt rủi ro cho phép`;
    else if (openRisk + riskUSD > CFG.ACCOUNT * CFG.MAX_OPEN_RISK_PCT / 100 + 0.01) skipWhy = `tổng rủi ro đang mở sẽ vượt ${CFG.MAX_OPEN_RISK_PCT}%`;
    else if (A.bal + floatPnl - openRisk - riskUSD < Math.max(A.dayStart - CFG.ACCOUNT * CFG.DAY_GUARD_PCT / 100, CFG.ACCOUNT * (1 - CFG.MAX_GUARD_PCT / 100))) skipWhy = 'nếu dính SL sẽ chạm ngưỡng lỗ';
    else if (A.phase <= 2 && A.bal >= target(A) + CFG.ACCOUNT * CFG.TARGET_BUFFER_PCT / 100) skipWhy = 'đã đạt mục tiêu, đang chờ đủ ngày giao dịch';
    const s = {
      id, no: (state.signals.at(-1)?.no || 0) + 1, mode: f.mode, dir: f.dir, barT: f.barT, entryT: f.entryT, createdAt: Date.now(),
      lateMin: Math.round((Date.now() / 1000 - f.entryT) / 60), entry: f.entry, R, sl: f.entry - f.dir * R,
      tp1: CFG.TP1_R > 0 ? f.entry + f.dir * R * CFG.TP1_R : null, tp2: CFG.TP2_R > 0 ? f.entry + f.dir * R * CFG.TP2_R : null,
      atr: f.atr, rsi2: f.rsi2, basis, lot: lot || 0.01, partial: 0, riskUSD, skipped: !!skipWhy, skipWhy, status: 'open',
    };
    if (s.tp1 != null) { s.partial = Math.floor(s.lot * CFG.PART_PCT / 100 / 0.01 + 1e-9) * 0.01; if (s.partial < 0.01 || s.partial >= s.lot) s.tp1 = null; s.partial = +s.partial.toFixed(2); }
    if (!s.skipped) { const dk = ceDay(f.entryT * 1000); if (!A.days.includes(dk)) A.days.push(dk); }
    state.signals.push(s);
    msgs.push(msgNew(s, cal, spot, A, open));
    const evs = []; track(s, M15, evs); closeAndApply(evs);
  }

  // 3) tổng kết tuần (Chủ nhật 9:00 giờ VN)
  const vnNow = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  if (vnNow.getDay() === CFG.WEEKLY_REPORT_DOW && vnNow.getHours() >= CFG.WEEKLY_REPORT_HOUR_VN && Date.now() - (state.lastWeekly || 0) > 5 * 864e5) {
    msgs.push(msgWeekly(state.signals, A)); state.lastWeekly = Date.now(); dirty = true;
  }
  // 4) lần chạy đầu
  if (!state.welcomed) {
    const last = ctx.Hc[ctx.Hc.length - 1];
    msgs.unshift(`✅ <b>SRADA đã chạy 24/7 trên GitHub</b> (không phụ thuộc máy tính ở nhà)\nMô phỏng tài khoản thi quỹ FTMO 2 bước 10.000$:\n• Rủi ro ${CFG.RISK_PCT.day}%/lệnh (~$${fmt(CFG.ACCOUNT * CFG.RISK_PCT.day / 100, 0)}), khối lượng tự tính theo khoảng SL\n• [NGÀY] ${ladderText('day').slice(3)}\n• [TUẦN] ${ladderText('week').slice(3)}\n• Tự dừng trong ngày khi lỗ ${CFG.DAY_GUARD_PCT}% (luật 5%), dừng hẳn ở ${CFG.MAX_GUARD_PCT}% (luật 10%)\n• Vòng 1 +10% → Vòng 2 +5%, tối thiểu 4 ngày giao dịch\n\nHiện tại: giá ${fmt(last.c + basis)}, xu hướng H4 ${ctx.st4Now > 0 ? 'TĂNG (chỉ tìm MUA)' : ctx.st4Now < 0 ? 'GIẢM (chỉ tìm BÁN)' : 'chưa rõ (đứng ngoài)'}. Tổng kết mỗi Chủ nhật 9:00.`);
    state.welcomed = true; dirty = true;
  }
  for (const m of msgs) if (m) await tg(m);

  state.stats = stats(state.signals); state.statsWeek = stats(state.signals, 'week'); state.statsDay = stats(state.signals, 'day');
  const lh = ctx.Hc[ctx.Hc.length - 1];
  state.last = { t: lh.t, price: +(M15[M15.length - 1].c + basis).toFixed(2), st4: ctx.st4Now };
  const changed = dirty || msgs.length || JSON.stringify(state.signals) !== before || state.aliveDay !== new Date().toISOString().slice(0, 10);
  state.aliveDay = new Date().toISOString().slice(0, 10);
  state.updatedAt = Date.now();
  if (changed) fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  console.log(`OK · H1 ${H.length} · M15 ${M15.length} · tín hiệu ${found.length} · tin nhắn ${msgs.length} · ghi file: ${!!changed}`);
}
export { main };
if (!process.env.SRADA_NO_AUTORUN) main().catch(e => { console.error(e); process.exitCode = 1; });
