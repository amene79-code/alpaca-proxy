/**
 * Pro Agent — GitHub Actions edition
 * Strategy: CATALYST GAP CONTINUATION
 *
 *   1. Universe = today's gainers + most-actives + saved pre-market watchlist.
 *   2. Keep only real catalysts: gap >= 4% vs prior close AND relVol >= 2.5x.
 *   3. Enter only those HOLDING the move: above VWAP and above the opening-range
 *      high (filters gap-and-fade fakeouts that would be instant losers).
 *   4. Fixed-DOLLAR risk per trade -> every loss is small and known.
 *   5. Structural ATR stop, then move stop to BREAKEVEN at +1R, then trail the
 *      profit. Most would-be losers become scratch trades instead of full losses.
 *   6. Strong closers are held overnight (catalyst continuation = the edge);
 *      weak/red positions are cut in the last 30 min (EOD review).
 *
 * Runs on a loop via GitHub Actions. State persists in state/state.json.
 */

import fetch from 'node-fetch';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', 'state', 'state.json');

// ─── Config ──────────────────────────────────────────────────────────────────
const CFG = {
  riskPerTrade: 50,    // $ risked per trade (FIXED — this is the loss cap per trade)
  maxPosValue:  1500,  // max $ deployed in a single position
  maxPos:       8,     // max concurrent positions
  maxDaily:     8,     // max NEW trades per day
  maxPerCycle:  4,     // max NEW trades per cycle

  // ─── HARD CIRCUIT BREAKER ────────────────────────────────────────────────
  // Absolute cap on TOTAL trades (long + short) per day, independent of the
  // per-side maxDaily/shortMaxDaily limits. This is the structural backstop
  // against a June-2-style churn day: even if a cooldown leaks or runs overlap,
  // the agent physically stops opening new positions once this many trades have
  // been placed today. Set comfortably above a normal day (~8-16) but far below
  // a runaway day (June 2 was 189).
  maxTotalDaily: 20,   // hard stop: no new entries after this many trades/day

  atrSL:        1.5,   // initial structural stop = entry − ATR × this
  atrTP:        4.0,   // take-profit ceiling = entry + ATR × this (let winners run)
  trail:        0.02,  // 2% trailing stop — applied ONLY after breakeven is reached
  beBufferPct:  0.001, // breakeven stop sits 0.1% above entry (covers fees/slippage)

  // Catalyst gates
  minGapPct:    4.0,   // min gap vs prior close (the catalyst signal)
  minRelVol:    2.5,   // min volume vs 20-day avg (institutional confirmation)
  minATRpct:    0.5,   // min ATR% (need real movement)
  minScore:     6,     // min composite score to take the trade
  minPrice:     20,    // price floor — sub-$20 names bled (penny/illiquid spread); data shows edge lives in $20+ liquid names
  rsiMax:       88,    // reject only truly parabolic chases

  // Time gates (ET)
  skipFirst15:  true,  // never enter in first 15 min (let opening range form)
  skipLast30:   true,  // no NEW entries in last 30 min (EOD review runs instead)
  eodReviewMin: 25,    // start cutting weak positions when <= this many mins to close

  // ─── SHORT SIDE (mirror of the long catalyst strategy) ───────────────────
  // DISABLED: over 38 trades the short side ran -$2.39/trade expectancy with a
  // 0.40× profit factor (won 58% but avg winner $2.77 vs avg loser $9.47 — an
  // inverted risk/reward that bleeds). No demonstrated edge. Re-enable only
  // after the geometry is fixed to let winners run / cut losers. Setting the
  // master switch off; the rest of the short config is kept for that future work.
  shortEnabled:    false,  // master switch for the short side (DISABLED — see note)
  shortRiskPerTrade: 30,   // $ risked per short (vs 50 long) — ~60%
  shortMaxPosValue:  1000,  // max $ per short (vs 1500 long)
  shortAtrSL:      2.0,    // wider stop than long (1.5) — fewer shares, less whipsaw
  shortAtrTP:      4.0,    // symmetric TP ceiling
  shortMaxDaily:   8,      // SEPARATE daily limit (8 long + 8 short)
  shortMinGapPct:  4.0,    // min gap DOWN (abs) vs prior close
  shortMinRelVol:  2.5,    // same volume confirmation as long
  shortRsiMin:     12,     // don't short something already washed-out/bouncing
  shortMinPrice:   20,     // raised from $5 — same liquidity floor as longs
};

// ─── Alpaca API ───────────────────────────────────────────────────────────────
const BASE = (process.env.ALPACA_URL || 'https://paper-api.alpaca.markets').replace(/\/$/, '');
const HEADERS = {
  'APCA-API-KEY-ID':     process.env.ALPACA_KEY,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET,
  'Content-Type':        'application/json',
};

async function alpaca(method, p, body) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { message: text }; }
  if (!r.ok) throw new Error(json.message || `HTTP ${r.status}: ${text.slice(0, 200)}`);
  return json;
}

// ─── Yahoo Finance candles ────────────────────────────────────────────────────
async function getCandles(ticker, range, interval) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const json = await r.json();
    const res = json?.chart?.result?.[0];
    if (!res) return null;
    const ts = res.timestamp || [];
    const q  = res.indicators?.quote?.[0] || {};
    return ts.map((t, i) => ({
      t, open: q.open?.[i], high: q.high?.[i],
      low: q.low?.[i], close: q.close?.[i], volume: q.volume?.[i],
    })).filter(c => c.close != null);
  } catch { return null; }
}

// ─── ET time helpers ──────────────────────────────────────────────────────────
function etPartsOf(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0; // midnight edge case
  return { dateStr: `${p.year}-${p.month}-${p.day}`, mins: hour * 60 + parseInt(p.minute, 10) };
}
function etOf(tsSeconds) { return etPartsOf(new Date(tsSeconds * 1000)); }
const todayET = () => etPartsOf(new Date()).dateStr;

// Candles belonging to today's regular session (9:30–16:00 ET)
function todaysRegularCandles(candles) {
  const today = todayET();
  return candles.filter(c => {
    const { dateStr, mins } = etOf(c.t);
    return dateStr === today && mins >= 570 && mins < 960;
  });
}

// ─── Catalyst screener: today's gainers + most actives ──────────────────────
async function fetchPredefined(scrId, count = 50) {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=${count}&scrIds=${scrId}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return [];
    const d = await r.json();
    return d?.finance?.result?.[0]?.quotes || [];
  } catch { return []; }
}

async function runScreener() {
  const scored = new Map(); // ticker -> prelim score
  let gainersRaw = 0, activesRaw = 0;

  // Day gainers — already gapping/running up today
  const gainers = await fetchPredefined('day_gainers', 50);
  gainersRaw = gainers.length;
  for (const q of gainers) {
    const sym = (q.symbol || '').toUpperCase();
    const chg = q.regularMarketChangePercent || 0;
    if (!/^[A-Z]{1,5}$/.test(sym)) continue;
    if (chg < CFG.minGapPct) continue;            // pre-filter by move size
    scored.set(sym, (scored.get(sym) || 0) + Math.min(3, chg / 5));
  }

  // Most actives — volume leaders (institutional flow)
  const actives = await fetchPredefined('most_actives', 50);
  activesRaw = actives.length;
  for (const q of actives) {
    const sym = (q.symbol || '').toUpperCase();
    if (!/^[A-Z]{1,5}$/.test(sym)) continue;
    const chg = q.regularMarketChangePercent || 0;
    if (chg <= 0) continue;                        // only up movers
    scored.set(sym, (scored.get(sym) || 0) + 1);
  }

  const list = [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([t]) => t);
  // DIAGNOSTIC: expose what Yahoo actually returned vs what survived filtering
  runScreener.lastDiag = { gainersRaw, activesRaw, kept: list.length, sample: list.slice(0, 10) };
  return list;
}

// ─── Short screener: day losers (gap-down catalysts) ─────────────────────────
async function runShortScreener() {
  const scored = new Map();
  let losersRaw = 0;
  const losers = await fetchPredefined('day_losers', 50);
  losersRaw = losers.length;
  for (const q of losers) {
    const sym = (q.symbol || '').toUpperCase();
    const chg = q.regularMarketChangePercent || 0;       // negative for losers
    if (!/^[A-Z]{1,5}$/.test(sym)) continue;
    if (chg > -CFG.shortMinGapPct) continue;             // pre-filter by down-move size
    scored.set(sym, (scored.get(sym) || 0) + Math.min(3, Math.abs(chg) / 5));
  }
  const list = [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([t]) => t);
  runShortScreener.lastDiag = { losersRaw, kept: list.length, sample: list.slice(0, 10) };
  return list;
}

// ─── Saved pre-market watchlist (committed by the dashboard) ─────────────────
async function fetchVercelWatchlist() {
  try {
    const r = await fetch('https://raw.githubusercontent.com/amene79-code/alpaca-proxy/main/state/watchlist.json?t=' + Date.now());
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.tickers?.length) return null;
    const today = new Date().toISOString().slice(0, 10);
    const savedDate = d.date ? d.date.split('/').reverse().join('-') : null;
    if (savedDate && savedDate !== today) {
      console.log(`Watchlist is from ${d.date} — not today, skipping`);
      return null;
    }
    return d.tickers.map(t => t.ticker || t).filter(Boolean);
  } catch (e) {
    console.log(`Could not fetch watchlist: ${e.message}`);
    return null;
  }
}

// ─── ICT positions (written by the ICT agent) — never manage these ───────────
// The ICT agent commits its open tickers to state/ict_positions.json. We read
// that file and add them to the exclusion list so the two agents never touch
// each other's trades. Separate file = single writer each = no clobbering.
async function fetchICTPositions() {
  try {
    const r = await fetch('https://raw.githubusercontent.com/amene79-code/alpaca-proxy/main/state/ict_positions.json?t=' + Date.now());
    if (!r.ok) return [];
    const d = await r.json();
    const arr = Array.isArray(d) ? d : (d.tickers || []);
    return arr.map(t => (t && t.ticker) ? t.ticker : t).filter(Boolean);
  } catch { return []; }
}

// ─── Indicators ───────────────────────────────────────────────────────────────
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = candles.slice(1).map((c, i) =>
    Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close)));
  return trs.slice(-period).reduce((s, v) => s + v, 0) / period;
}
function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  const closes = candles.map(c => c.close);
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  return 100 - 100 / (1 + gains / (losses || 0.001));
}
function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}
// VWAP over today's regular session only
function calcVWAP(candles) {
  let tpv = 0, vol = 0;
  for (const c of todaysRegularCandles(candles)) {
    const tp = (c.high + c.low + c.close) / 3;
    tpv += tp * (c.volume || 0);
    vol += c.volume || 0;
  }
  return vol > 0 ? tpv / vol : 0;
}

// ─── Pattern detection ────────────────────────────────────────────────────────
function detectPatterns(candles) {
  const patterns = [];
  const n = candles.length;
  if (n < 3) return patterns;
  for (let i = Math.max(1, n - 5); i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low || 0.001;
    const pbody = Math.abs(p.close - p.open);
    const bull = c.close > c.open;
    const lWick = Math.min(c.open, c.close) - c.low;
    const uWick = c.high - Math.max(c.open, c.close);
    if (lWick > body * 2 && uWick < body * 0.5 && body > 0)
      patterns.push({ name: 'Hammer', strength: 2, bullish: true });
    if (p.close < p.open && c.close > c.open && c.open < p.close && c.close > p.open && body > pbody)
      patterns.push({ name: 'Bullish Engulfing', strength: 3, bullish: true });
    const avgVol = candles.slice(Math.max(0, i - 10), i).reduce((s, x) => s + (x.volume || 0), 0) / 10;
    if ((c.volume || 0) > avgVol * 2.5 && bull)
      patterns.push({ name: 'Volume Breakout', strength: 3, bullish: true });
    if (i > 0 && c.open > candles[i - 1].high * 1.005)
      patterns.push({ name: 'Gap Up', strength: 2, bullish: true });
    if (i >= 4) {
      const impulse = candles[i - 4];
      const isImpulse = (impulse.close - impulse.open) / impulse.open > 0.02;
      const isConsolidation = candles.slice(i - 3, i + 1).every(fc => Math.abs(fc.close - fc.open) / fc.open < 0.01);
      if (isImpulse && isConsolidation) patterns.push({ name: 'Bull Flag', strength: 3, bullish: true });
    }
  }
  const seen = new Set();
  return patterns.filter(p => seen.has(p.name) ? false : seen.add(p.name));
}

// ─── Signal analysis: Catalyst Gap Continuation ──────────────────────────────
async function analyzeSignal(ticker) {
  const rej = (r) => { (analyzeSignal.rejections = analyzeSignal.rejections || []).push(`${ticker}: ${r}`); return null; };

  const candles = await getCandles(ticker, '5d', '5m');
  if (!candles || candles.length < 30) return rej('no 5m candles');

  const price = candles[candles.length - 1].close;
  if (price < CFG.minPrice) return rej(`price $${price?.toFixed(2)} < $${CFG.minPrice}`);

  const daily = await getCandles(ticker, '1mo', '1d');
  if (!daily || daily.length < 5) return rej('no daily candles');

  // Liquidity
  const avgDailyVol = daily.slice(-20).reduce((s, c) => s + (c.volume || 0), 0) / Math.min(20, daily.length);
  if (avgDailyVol < 1_000_000) return rej(`avgVol ${(avgDailyVol/1e6).toFixed(1)}M < 1M`);

  // ── CATALYST GATE 1: gap vs prior close ─────────────────────────────────
  const priorClose = daily[daily.length - 2]?.close;
  if (!priorClose) return rej('no priorClose');
  const gapPct = (price - priorClose) / priorClose * 100;
  if (gapPct < CFG.minGapPct) return rej(`gap ${gapPct.toFixed(1)}% < ${CFG.minGapPct}% (price $${price.toFixed(2)} vs priorClose $${priorClose.toFixed(2)})`);

  // ── CATALYST GATE 2: relative volume ────────────────────────────────────
  const todayVol = daily[daily.length - 1]?.volume || 0;
  const relVol = avgDailyVol > 0 ? todayVol / avgDailyVol : 0;
  if (relVol < CFG.minRelVol) return rej(`relVol ${relVol.toFixed(1)}× < ${CFG.minRelVol}× (todayVol ${(todayVol/1e6).toFixed(1)}M)`);

  // ── HOLD GATE: still holding the move (no gap-and-fade) ──────────────────
  const vwap = calcVWAP(candles);
  if (vwap > 0 && price < vwap) return rej(`below VWAP (price $${price.toFixed(2)} < VWAP $${vwap.toFixed(2)})`);

  const todays = todaysRegularCandles(candles);
  const openRange = todays.slice(0, 3);                 // first 15 min (9:30–9:45)
  const orHigh = openRange.length ? Math.max(...openRange.map(c => c.high)) : 0;
  if (orHigh > 0 && price < orHigh * 0.995) return rej(`below opening-range high (price $${price.toFixed(2)} < ORH $${orHigh.toFixed(2)}, ${todays.length} today-candles)`);

  // Volatility / momentum
  const atr = calcATR(candles, 14);
  const atrPct = atr / price * 100;
  if (atrPct < CFG.minATRpct) return rej(`ATR ${atrPct.toFixed(2)}% < ${CFG.minATRpct}%`);

  const rsi = calcRSI(candles, 14);
  if (rsi > CFG.rsiMax) return rej(`RSI ${rsi.toFixed(0)} > ${CFG.rsiMax}`);

  const closes = candles.map(c => c.close);
  const ema9 = calcEMA(closes, 9), ema20 = calcEMA(closes, 20);

  const patterns = detectPatterns(candles).filter(p => p.bullish === true);

  // ── Composite score ──────────────────────────────────────────────────────
  let score = 0;
  score += gapPct >= 10 ? 3 : gapPct >= 6 ? 2 : 1;       // gap strength
  score += relVol >= 5 ? 3 : relVol >= 3.5 ? 2 : 1;      // volume strength
  if (orHigh > 0 && price >= orHigh) score += 2;         // breaking opening range high
  if (vwap > 0 && price > vwap) score += 1;              // above VWAP
  if (ema9 > ema20 && price > ema9) score += 1;          // intraday uptrend intact
  if (rsi < 75) score += 1;                              // not overextended
  score += patterns.reduce((s, p) => s + p.strength, 0); // candle patterns

  return { ticker, price, atr, atrPct, rsi, vwap, orHigh, gapPct, relVol, patterns, score };
}

// ─── Signal analysis: SHORT (gap-down continuation, mirror of long) ──────────
async function analyzeShort(ticker) {
  const rej = (r) => { (analyzeShort.rejections = analyzeShort.rejections || []).push(`${ticker}: ${r}`); return null; };

  const candles = await getCandles(ticker, '5d', '5m');
  if (!candles || candles.length < 30) return rej('no 5m candles');

  const price = candles[candles.length - 1].close;
  if (price < CFG.shortMinPrice) return rej(`price $${price?.toFixed(2)} < $${CFG.shortMinPrice} (short floor)`);

  const daily = await getCandles(ticker, '1mo', '1d');
  if (!daily || daily.length < 5) return rej('no daily candles');

  const avgDailyVol = daily.slice(-20).reduce((s, c) => s + (c.volume || 0), 0) / Math.min(20, daily.length);
  if (avgDailyVol < 1_000_000) return rej(`avgVol ${(avgDailyVol/1e6).toFixed(1)}M < 1M`);

  // ── CATALYST GATE 1: gap DOWN vs prior close ────────────────────────────
  const priorClose = daily[daily.length - 2]?.close;
  if (!priorClose) return rej('no priorClose');
  const gapPct = (price - priorClose) / priorClose * 100;       // negative = down
  if (gapPct > -CFG.shortMinGapPct) return rej(`gap ${gapPct.toFixed(1)}% > -${CFG.shortMinGapPct}% (not gapping down enough)`);

  // ── ANTI-KNIFE GATE: don't short a name net-UP on the multi-day trend ───
  // (a one-day dip inside an uptrend is a falling knife to short)
  const wkAgo = daily[Math.max(0, daily.length - 6)]?.close;
  if (wkAgo && price > wkAgo) return rej(`net up over ~5d ($${wkAgo.toFixed(2)}→$${price.toFixed(2)}) — no short into uptrend`);

  // ── CATALYST GATE 2: relative volume ────────────────────────────────────
  const todayVol = daily[daily.length - 1]?.volume || 0;
  const relVol = avgDailyVol > 0 ? todayVol / avgDailyVol : 0;
  if (relVol < CFG.shortMinRelVol) return rej(`relVol ${relVol.toFixed(1)}× < ${CFG.shortMinRelVol}× (todayVol ${(todayVol/1e6).toFixed(1)}M)`);

  // ── HOLD GATE: still breaking DOWN (below VWAP, below opening-range low) ─
  const vwap = calcVWAP(candles);
  if (vwap > 0 && price > vwap) return rej(`above VWAP (price $${price.toFixed(2)} > VWAP $${vwap.toFixed(2)}) — not holding breakdown`);

  const todays = todaysRegularCandles(candles);
  const openRange = todays.slice(0, 3);
  const orLow = openRange.length ? Math.min(...openRange.map(c => c.low)) : 0;
  if (orLow > 0 && price > orLow * 1.005) return rej(`above opening-range low (price $${price.toFixed(2)} > ORL $${orLow.toFixed(2)})`);

  // Volatility / momentum
  const atr = calcATR(candles, 14);
  const atrPct = atr / price * 100;
  if (atrPct < CFG.minATRpct) return rej(`ATR ${atrPct.toFixed(2)}% < ${CFG.minATRpct}%`);

  const rsi = calcRSI(candles, 14);
  if (rsi < CFG.shortRsiMin) return rej(`RSI ${rsi.toFixed(0)} < ${CFG.shortRsiMin} (washed out — don't short the bottom)`);

  const closes = candles.map(c => c.close);
  const ema9 = calcEMA(closes, 9), ema20 = calcEMA(closes, 20);

  // ── Composite score (mirror) ─────────────────────────────────────────────
  let score = 0;
  const adg = Math.abs(gapPct);
  score += adg >= 10 ? 3 : adg >= 6 ? 2 : 1;            // down-gap strength
  score += relVol >= 5 ? 3 : relVol >= 3.5 ? 2 : 1;     // volume strength
  if (orLow > 0 && price <= orLow) score += 2;          // breaking opening-range low
  if (vwap > 0 && price < vwap) score += 1;             // below VWAP
  if (ema9 < ema20 && price < ema9) score += 1;         // intraday downtrend intact
  if (rsi > 25) score += 1;                             // not already washed out

  return { ticker, price, atr, atrPct, rsi, vwap, orLow, gapPct, relVol, score, side: 'short' };
}
async function moveStopLeg(orderId, newStop) {
  return alpaca('PATCH', `/v2/orders/${orderId}`, { stop_price: String(newStop) });
}

// ─── State ────────────────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { trailingStops: {}, dailyTrades: 0, dailyDate: '', openPositions: [], log: [] }; }
}
function saveState(state) {
  if (state.log.length > 200) state.log = state.log.slice(-200);
  state.lastRun = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function addLog(state, type, msg, detail = '') {
  state.log.push({ time: new Date().toISOString(), type, msg, detail });
  console.log(`[${type}] ${msg}${detail ? ' | ' + detail : ''}`);
}

// ─── Market hours ───────────────────────────────────────────────────────────
function isRegularHours() {
  const { mins } = etPartsOf(new Date());
  return mins >= 570 && mins < 960;
}
function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  return isRegularHours();
}
// Holiday-aware market check via Alpaca's own clock (knows the real NYSE
// calendar incl. Juneteenth, July 4, Thanksgiving, half-days). Falls back to
// the naive weekday+time check only if the API call fails, so a network blip
// can't accidentally green-light trading — it degrades to the old behaviour.
async function alpacaMarketOpen() {
  try {
    const clock = await alpaca('GET', '/v2/clock');
    return !!clock.is_open;
  } catch {
    return isMarketOpen(); // fallback: weekday + RTH only (no holiday awareness)
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Close a position (used for ext-hours exits + EOD review) ────────────────
async function cancelAndSell(symbol, qty, side = 'long') {
  const closeSide = side === 'short' ? 'buy' : 'sell';
  const regular = isRegularHours();
  try {
    const positions = await alpaca('GET', '/v2/positions').catch(() => []);
    const position = (Array.isArray(positions) ? positions : []).find(p => p.symbol === symbol);
    const actualQty = position ? Math.abs(+position.qty) : qty;
    if (!actualQty) { console.warn(`${symbol} — no position found`); return false; }
    const currentPrice = +position?.current_price || 0;

    const buildOrder = (pr) => {
      if (regular || !pr) return { symbol, qty: String(actualQty), side: closeSide, type: 'market', time_in_force: 'day' };
      const limitPrice = closeSide === 'sell' ? +(pr * 0.999).toFixed(2) : +(pr * 1.001).toFixed(2);
      return { symbol, qty: String(actualQty), side: closeSide, type: 'limit', limit_price: String(limitPrice), time_in_force: 'day', extended_hours: true };
    };

    let order;
    try {
      order = await alpaca('POST', '/v2/orders', buildOrder(currentPrice));
    } catch (e) {
      if (/insufficient|conflict|open order/i.test(e.message || '')) {
        const orders = await alpaca('GET', `/v2/orders?status=open&limit=100&nested=true`).catch(() => []);
        for (const o of (Array.isArray(orders) ? orders : []).filter(o => o.symbol === symbol)) {
          await alpaca('DELETE', `/v2/orders/${o.id}`).catch(() => {});
          if (o.legs) for (const leg of o.legs) await alpaca('DELETE', `/v2/orders/${leg.id}`).catch(() => {});
        }
        await sleep(1200);
        order = await alpaca('POST', '/v2/orders', buildOrder(currentPrice));
      } else throw e;
    }

    if (order?.id) {
      const orders = await alpaca('GET', `/v2/orders?status=open&limit=100&nested=true`).catch(() => []);
      for (const o of (Array.isArray(orders) ? orders : []).filter(o => o.symbol === symbol && o.id !== order.id)) {
        await alpaca('DELETE', `/v2/orders/${o.id}`).catch(() => {});
        if (o.legs) for (const leg of o.legs) await alpaca('DELETE', `/v2/orders/${leg.id}`).catch(() => {});
      }
      return true;
    }
    return false;
  } catch (e) {
    console.error(`Failed to close ${symbol}: ${e.message} — orders preserved`);
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Pro Agent (Catalyst Gap Continuation) — ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  const state = loadState();
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyDate !== today) {
    state.dailyTrades = 0;
    state.dailyDate = today;
    state.tradedToday = [];   // one round-trip per ticker per day — reset each day
    state.shortDailyTrades = 0;
    state.shortTradedToday = [];   // short side: separate daily limit, reset each day
    addLog(state, 'INFO', 'New trading day — counter reset');
  }
  if (!Array.isArray(state.tradedToday)) state.tradedToday = [];
  if (!Array.isArray(state.shortTradedToday)) state.shortTradedToday = [];
  if (typeof state.shortDailyTrades !== 'number') state.shortDailyTrades = 0;

  // 1. Account + positions
  let account, positions;
  try {
    [account, positions] = await Promise.all([
      alpaca('GET', '/v2/account'),
      alpaca('GET', '/v2/positions'),
    ]);
    addLog(state, 'INFO', `Account: $${(+account.equity).toFixed(2)} | ${positions.length} positions | ${state.dailyTrades} trades today`);
  } catch (e) {
    addLog(state, 'ERROR', `Account fetch failed: ${e.message}`);
    saveState(state); process.exit(1);
  }

  // ─── HOLIDAY / CLOSED-MARKET AWARENESS ─────────────────────────────────────
  // Ask Alpaca's calendar-aware clock whether the market is actually open today.
  // On a holiday (e.g. Juneteenth) or weekend the naive weekday+time check would
  // wrongly think we're in-session. We compute this ONCE here and use it at the
  // new-entry gate below, so position management still runs (keeping state.json
  // consistent and honouring real bracket stops) but no scanning/entries happen
  // on a closed day.
  const clockOpen = await alpacaMarketOpen();
  if (!clockOpen) {
    addLog(state, 'INFO', '🛌 Market closed today (holiday/weekend per Alpaca clock) — will manage positions only, no scan or new entries.');
  }

  // ICT positions are managed by the ICT agent — exclude them from everything here.
  // Merge the persisted state field with the live file the ICT agent commits.
  const ictFromFile = await fetchICTPositions();
  const ictPositions = [...new Set([...(state.ictPositions || []), ...ictFromFile])];
  if (ictPositions.length) addLog(state, 'INFO', `Excluding ${ictPositions.length} ICT position(s) from management`, ictPositions.join(', '));
  const managed = positions.filter(p => !ictPositions.includes(p.symbol));

  // 2. Seed trailing-stop state for any managed position not yet tracked
  for (const p of managed) {
    if (!state.trailingStops[p.symbol]) {
      const price = +p.current_price || 0;
      const entry = +p.avg_entry_price || 0;
      const isShort = +p.qty < 0;
      state.trailingStops[p.symbol] = {
        side: isShort ? 'short' : 'long',
        entry, high: Math.max(price, entry), low: Math.min(price, entry),
        initialSl: null, sl: null, tp: null, slOrderId: null, tpOrderId: null,
        movedToBreakeven: false,
      };
    }
  }

  // 3. Restore bracket leg IDs + prices from Alpaca
  try {
    const open = await alpaca('GET', '/v2/orders?status=open&limit=200&nested=true');
    if (Array.isArray(open)) {
      for (const o of open) {
        const ts = state.trailingStops[o.symbol];
        if (!ts) continue;
        for (const leg of (o.legs || [])) {
          const ts2 = state.trailingStops[o.symbol];
          const isShort = ts2 && ts2.side === 'short';
          // Long bracket legs are SELL; short bracket legs are BUY.
          const legSideMatch = isShort ? 'buy' : 'sell';
          if (leg.type === 'limit' && leg.side === legSideMatch) { ts.tp = +leg.limit_price; ts.tpOrderId = leg.id; }
          if (leg.type === 'stop'  && leg.side === legSideMatch) {
            ts.sl = +leg.stop_price; ts.slOrderId = leg.id;
            if (ts.initialSl == null) ts.initialSl = +leg.stop_price;
          }
        }
      }
    }
  } catch (e) { addLog(state, 'INFO', `Bracket restore failed: ${e.message}`); }

  // 4. Clean trailing state for positions that no longer exist
  const active = new Set(positions.map(p => p.symbol));
  for (const sym of Object.keys(state.trailingStops)) if (!active.has(sym)) delete state.trailingStops[sym];

  // 5. Manage stops: breakeven at +1R, then trail the profit
  const regular = isRegularHours();
  for (const p of managed) {
    const price = +p.current_price || 0;
    const entry = +p.avg_entry_price || 0;
    const qty = Math.abs(+p.qty) || 0;
    const pl = +p.unrealized_pl || 0;
    if (!price || !entry || !qty) continue;
    const ts = state.trailingStops[p.symbol];
    if (!ts) continue;

    // ── SHORT — manage as mirror of long (real bracket stop is at Alpaca; this
    //    is the secondary trail + breakeven ratchet). Profit = price falling. ──
    if (ts.side === 'short') {
      if (price < (ts.low ?? entry)) ts.low = price;
      const initialSl = ts.initialSl ?? ts.sl;
      const R = initialSl ? (initialSl - entry) : 0;       // dollar risk per share (up move)

      // (a) Move to breakeven once unrealised gain >= 1R (price fell entry - R)
      if (!ts.movedToBreakeven && R > 0 && price <= entry - R) {
        const beStop = +(entry * (1 - CFG.beBufferPct)).toFixed(2);  // just below entry
        if (ts.slOrderId && beStop < (ts.sl || Infinity)) {
          try {
            await moveStopLeg(ts.slOrderId, beStop);
            ts.sl = beStop; ts.movedToBreakeven = true;
            addLog(state, 'TRAIL', `${p.symbol} (SHORT) → BREAKEVEN`, `Entry $${entry.toFixed(2)} | +1R reached @ $${price.toFixed(2)} | Stop → $${beStop}`);
          } catch (e) { addLog(state, 'INFO', `${p.symbol} short breakeven move failed: ${e.message}`); }
        } else if (!ts.slOrderId) {
          ts.movedToBreakeven = true; ts.sl = beStop;
        }
      }

      // (b) After breakeven, trail the profit downward (never above breakeven)
      if (ts.movedToBreakeven) {
        const trailStop = +((ts.low ?? entry) * (1 + CFG.trail)).toFixed(2);
        const newStop = Math.min(trailStop, ts.sl || Infinity);
        if (ts.slOrderId && newStop < (ts.sl || Infinity) - 0.01) {
          try {
            await moveStopLeg(ts.slOrderId, newStop);
            addLog(state, 'TRAIL', `${p.symbol} (SHORT) stop lowered → $${newStop}`, `Low $${(ts.low ?? entry).toFixed(2)} | P&L +$${pl.toFixed(2)}`);
            ts.sl = newStop;
          } catch (e) { addLog(state, 'INFO', `${p.symbol} short trail patch failed: ${e.message}`); }
        }
      }

      // (c) Backstop: if the real bracket somehow isn't there, force-close on breach
      const hardStop = +((ts.low ?? entry) * (1 + CFG.trail)).toFixed(2);
      if (!ts.slOrderId && price >= hardStop) {
        const closed = await cancelAndSell(p.symbol, qty, 'short');
        if (closed) { addLog(state, 'SELL', `✓ Closed SHORT ${p.symbol}`, `P&L ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}`); delete state.trailingStops[p.symbol]; }
      }
      continue;
    }

    // ── LONG ───────────────────────────────────────────────────────────────
    if (price > ts.high) ts.high = price;
    const initialSl = ts.initialSl ?? ts.sl;
    const R = initialSl ? (entry - initialSl) : 0; // dollar risk per share

    // (a) Move to breakeven once unrealised gain >= 1R
    if (!ts.movedToBreakeven && R > 0 && price >= entry + R) {
      const beStop = +(entry * (1 + CFG.beBufferPct)).toFixed(2);
      if (ts.slOrderId && beStop > (ts.sl || 0)) {
        try {
          await moveStopLeg(ts.slOrderId, beStop);
          ts.sl = beStop; ts.movedToBreakeven = true;
          addLog(state, 'TRAIL', `${p.symbol} → BREAKEVEN`, `Entry $${entry.toFixed(2)} | +1R reached @ $${price.toFixed(2)} | Stop → $${beStop}`);
        } catch (e) { addLog(state, 'INFO', `${p.symbol} breakeven move failed: ${e.message}`); }
      } else if (!ts.slOrderId) {
        ts.movedToBreakeven = true; ts.sl = beStop; // no leg to patch; tracked logically
      }
    }

    // (b) After breakeven, trail the profit (never below breakeven)
    if (ts.movedToBreakeven) {
      const trailStop = +(ts.high * (1 - CFG.trail)).toFixed(2);
      const newStop = Math.max(trailStop, ts.sl || 0);
      if (ts.slOrderId && newStop > (ts.sl || 0) + 0.01) {
        try {
          await moveStopLeg(ts.slOrderId, newStop);
          addLog(state, 'TRAIL', `${p.symbol} stop raised → $${newStop}`, `High $${ts.high.toFixed(2)} | P&L +$${pl.toFixed(2)}`);
          ts.sl = newStop;
        } catch (e) { addLog(state, 'INFO', `${p.symbol} trail patch failed: ${e.message}`); }
      }
    }

    // (c) Extended hours: bracket stops don't fire — close manually if breached
    if (!regular && ts.sl && price <= ts.sl) {
      const closed = await cancelAndSell(p.symbol, qty, 'long');
      if (closed) { addLog(state, 'SELL', `✓ Closed ${p.symbol} (ext-hours stop)`, `P&L ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}`); delete state.trailingStops[p.symbol]; }
    } else if (!regular && ts.tp && price >= ts.tp) {
      const closed = await cancelAndSell(p.symbol, qty, 'long');
      if (closed) { addLog(state, 'SELL', `✓ Closed ${p.symbol} (ext-hours TP)`, `P&L +$${pl.toFixed(2)}`); delete state.trailingStops[p.symbol]; }
    }
    await sleep(150);
  }

  // 6. EOD review — cut weak positions, hold strong closers overnight
  if (isMarketOpen()) {
    const { mins } = etPartsOf(new Date());
    const minsToClose = 960 - mins;
    if (minsToClose <= CFG.eodReviewMin && minsToClose > 2) {
      addLog(state, 'INFO', `EOD review (${minsToClose} min to close) — cutting weak positions`);
      for (const p of managed) {
        const pl = +p.unrealized_pl || 0;
        const price = +p.current_price || 0;
        const candles = await getCandles(p.symbol, '5d', '5m');
        const vwap = candles ? calcVWAP(candles) : 0;
        const weak = pl <= 0 || (vwap > 0 && price < vwap); // red OR lost VWAP = don't hold overnight
        if (weak) {
          const closed = await cancelAndSell(p.symbol, Math.abs(+p.qty), p.qty < 0 ? 'short' : 'long');
          if (closed) { addLog(state, 'SELL', `✓ EOD cut ${p.symbol}`, `Weak into close | P&L ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}`); delete state.trailingStops[p.symbol]; }
        } else {
          addLog(state, 'INFO', `${p.symbol} held overnight`, `Strong close | P&L +$${pl.toFixed(2)} | above VWAP`);
        }
        await sleep(200);
      }
    }
  }

  // 7. Should we look for NEW entries?
  // Use the holiday-aware clock (clockOpen) AND the in-session time check. The
  // clock catches holidays the naive check misses; isMarketOpen() keeps the
  // regular-trading-hours window so we don't enter pre/post market.
  if (!clockOpen || !isMarketOpen()) { addLog(state, 'INFO', 'Market closed or outside hours — no new entries'); saveState(state); return; }

  const { mins } = etPartsOf(new Date());
  const minsAfterOpen = mins - 570;
  const minsToClose = 960 - mins;
  // Time gates apply to BOTH sides — hard stop here.
  if (CFG.skipFirst15 && minsAfterOpen < 15) { addLog(state, 'INFO', `Skip — first 15 min (${minsAfterOpen} min in)`); saveState(state); return; }
  if (CFG.skipLast30 && minsToClose < 30) { addLog(state, 'INFO', `Skip new entries — last 30 min`); saveState(state); return; }

  // ─── HARD CIRCUIT BREAKER ──────────────────────────────────────────────────
  // Absolute cap on total (long + short) trades per day. Structural backstop
  // against a churn day: once hit, NO new entries of any kind for the rest of
  // the day. This is independent of (and stricter than) the per-side limits, and
  // it holds even if a per-ticker cooldown leaks or runs briefly overlap.
  const totalTradesToday = (state.dailyTrades || 0) + (state.shortDailyTrades || 0);
  if (totalTradesToday >= CFG.maxTotalDaily) {
    addLog(state, 'INFO', `⛔ CIRCUIT BREAKER — ${totalTradesToday}/${CFG.maxTotalDaily} total trades today. No more new entries.`);
    saveState(state);
    return;
  }

  // Long-side limits: skip LONG entry only — the short side runs regardless
  // (it has its own separate daily limit). Don't return out of main() here.
  const longBlocked =
    (state.dailyTrades >= CFG.maxDaily) ? `Daily limit reached (${CFG.maxDaily})` :
    (managed.length >= CFG.maxPos)      ? `Position limit reached (${managed.length}/${CFG.maxPos})` : null;
  if (longBlocked) addLog(state, 'INFO', `${longBlocked} — skipping long entries`);

  let signals = [];
  if (!longBlocked) {
  const savedWatchlist = await fetchVercelWatchlist();
  if (savedWatchlist?.length) addLog(state, 'INFO', `Watchlist: ${savedWatchlist.length} tickers`, savedWatchlist.slice(0, 8).join(', '));
  const screener = await runScreener();
  const diag = runScreener.lastDiag || {};
  addLog(state, 'INFO', `Screener raw — gainers ${diag.gainersRaw ?? '?'}, actives ${diag.activesRaw ?? '?'}, kept ${diag.kept ?? '?'}`,
    (diag.sample && diag.sample.length) ? diag.sample.join(', ') : '(none returned)');
  // Screener (real gappers) goes FIRST so the watchlist can never starve it;
  // watchlist supplements. Cap raised to 60 so a full screener + watchlist both fit.
  const candidates = [...new Set([...screener, ...(savedWatchlist || [])])];
  const existing = new Set(positions.map(p => p.symbol));
  const toScan = candidates.filter(t => !existing.has(t)).slice(0, 60);
  addLog(state, 'INFO', `Scanning ${toScan.length} candidates`, `${screener.length} screener + ${savedWatchlist?.length || 0} watchlist`);

  // 9. Analyze
  analyzeSignal.rejections = [];
  for (const ticker of toScan) {
    try {
      const s = await analyzeSignal(ticker);
      if (s && s.score >= CFG.minScore) {
        addLog(state, 'SIGNAL', `${ticker} — score ${s.score} | gap ${s.gapPct.toFixed(1)}% | relVol ${s.relVol.toFixed(1)}× | RSI ${s.rsi.toFixed(0)}`, s.patterns.map(p => p.name).join(', '));
        signals.push(s);
      }
    } catch (e) { console.warn(`Analysis failed for ${ticker}: ${e.message}`); }
    await sleep(200);
  }
  // DIAGNOSTIC: show why candidates were rejected (first 12)
  if (analyzeSignal.rejections.length) {
    addLog(state, 'INFO', `Rejections (${analyzeSignal.rejections.length})`, analyzeSignal.rejections.slice(0, 12).join('  •  '));
  }
  if (!signals.length) {
    addLog(state, 'INFO', 'No signals meeting criteria');   // fall through to short side
  } else {
    signals.sort((a, b) => b.score - a.score);
    addLog(state, 'INFO', `Top signal: ${signals[0].ticker} (score ${signals[0].score})`);
  }

  // 10. Execute (fixed-$ risk sizing)
  const slots = Math.min(CFG.maxPos - managed.length, CFG.maxDaily - state.dailyTrades, CFG.maxPerCycle);
  const tradedThisCycle = new Set();
  for (const sig of signals.slice(0, slots)) {
    if (existing.has(sig.ticker) || tradedThisCycle.has(sig.ticker)) continue;
    if (state.tradedToday.includes(sig.ticker)) {        // one round-trip per ticker per day — no re-entry churn
      addLog(state, 'INFO', `SKIP ${sig.ticker} — already traded today`);
      continue;
    }
    const { ticker, price, atr, patterns } = sig;

    const slRaw = price - atr * CFG.atrSL;
    const slF = +Math.min(slRaw, price - 0.05).toFixed(2);   // structural stop
    const tpF = +(price + atr * CFG.atrTP).toFixed(2);       // TP ceiling
    const riskPS = Math.max(0.01, price - slF);              // $ risk per share
    const qtyByRisk = Math.floor(CFG.riskPerTrade / riskPS); // FIXED-$ risk sizing
    const qtyByValue = Math.floor(CFG.maxPosValue / price);  // value cap
    const qty = Math.max(1, Math.min(qtyByRisk, qtyByValue));
    const rr = ((tpF - price) / riskPS).toFixed(1);
    const dollarRisk = (riskPS * qty).toFixed(2);

    addLog(state, 'BUY', `Placing ${qty}× ${ticker} @ ~$${price.toFixed(2)}`,
      `gap ${sig.gapPct.toFixed(1)}% | risk $${dollarRisk} | SL $${slF} | TP $${tpF} | R:R ${rr} | ${patterns.map(p => p.name).join(', ')}`);

    try {
      const order = await alpaca('POST', '/v2/orders', {
        symbol: ticker, qty: String(qty), side: 'buy', type: 'market', time_in_force: 'gtc',
        order_class: 'bracket', take_profit: { limit_price: String(tpF) }, stop_loss: { stop_price: String(slF) },
      });
      if (order.id) {
        addLog(state, 'BUY', `✓ ORDER PLACED: ${qty}× ${ticker}`, `ID ${order.id} | R:R ${rr}:1 | risk $${dollarRisk}`);
        state.trailingStops[ticker] = {
          side: 'long', entry: price, high: price, low: price,
          initialSl: slF, sl: slF, tp: tpF, slOrderId: null, tpOrderId: null, movedToBreakeven: false,
        };
        existing.add(ticker); tradedThisCycle.add(ticker); state.dailyTrades++;
        state.tradedToday.push(ticker);   // block re-entry for the rest of the day
      }
    } catch (e) { addLog(state, 'ERROR', `Order failed ${ticker}: ${e.message}`); }
    await sleep(500);
  }
  } // end if(!longBlocked) — long entry section

  // ─── 11. SHORT SIDE ────────────────────────────────────────────────────────
  // Runs after longs, with its own SEPARATE daily limit (8 long + 8 short).
  // INVARIANT: every short is placed as a BRACKET so Alpaca attaches a REAL
  // stop. If Alpaca rejects the bracket (can't borrow / locate), the trade is
  // SKIPPED — a short is NEVER placed without a broker-side stop.
  if (CFG.shortEnabled) {
    const shortSlotsLeft = CFG.shortMaxDaily - (state.shortDailyTrades || 0);
    if (shortSlotsLeft > 0 && managed.length < CFG.maxPos) {
      const shortScreener = await runShortScreener();
      const sdiag = runShortScreener.lastDiag || {};
      addLog(state, 'INFO', `Short screener — losers ${sdiag.losersRaw ?? '?'}, kept ${sdiag.kept ?? '?'}`,
        (sdiag.sample && sdiag.sample.length) ? sdiag.sample.join(', ') : '(none returned)');

      const sExisting = new Set((await alpaca('GET', '/v2/positions').catch(() => positions)).map(p => p.symbol));
      const toScanS = shortScreener.filter(t => !sExisting.has(t)).slice(0, 40);

      analyzeShort.rejections = [];
      const shorts = [];
      for (const ticker of toScanS) {
        try {
          const s = await analyzeShort(ticker);
          if (s && s.score >= CFG.minScore) {
            addLog(state, 'SIGNAL', `${ticker} — SHORT score ${s.score} | gap ${s.gapPct.toFixed(1)}% | relVol ${s.relVol.toFixed(1)}× | RSI ${s.rsi.toFixed(0)}`);
            shorts.push(s);
          }
        } catch (e) { console.warn(`Short analysis failed for ${ticker}: ${e.message}`); }
        await sleep(200);
      }
      if (analyzeShort.rejections.length) {
        addLog(state, 'INFO', `Short rejections (${analyzeShort.rejections.length})`, analyzeShort.rejections.slice(0, 12).join('  •  '));
      }

      if (shorts.length) {
        shorts.sort((a, b) => b.score - a.score);
        addLog(state, 'INFO', `Top short: ${shorts[0].ticker} (score ${shorts[0].score})`);

        const sSlots = Math.min(CFG.maxPos - managed.length, shortSlotsLeft, CFG.maxPerCycle);
        const shortedThisCycle = new Set();
        for (const sig of shorts.slice(0, sSlots)) {
          if (sExisting.has(sig.ticker) || shortedThisCycle.has(sig.ticker)) continue;
          if (state.shortTradedToday.includes(sig.ticker) || state.tradedToday.includes(sig.ticker)) {
            addLog(state, 'INFO', `SKIP ${sig.ticker} — already traded today`);
            continue;
          }
          const { ticker, price, atr } = sig;

          // SHORT geometry: stop ABOVE entry, target BELOW. Wider stop (shortAtrSL).
          const slRaw = price + atr * CFG.shortAtrSL;
          const slF = +Math.max(slRaw, price + 0.05).toFixed(2);   // stop above entry
          const tpF = +Math.max(0.01, price - atr * CFG.shortAtrTP).toFixed(2); // target below
          const riskPS = Math.max(0.01, slF - price);              // $ risk per share (up move)
          const qtyByRisk = Math.floor(CFG.shortRiskPerTrade / riskPS);
          const qtyByValue = Math.floor(CFG.shortMaxPosValue / price);
          const qty = Math.max(1, Math.min(qtyByRisk, qtyByValue));
          const rr = ((price - tpF) / riskPS).toFixed(1);
          const dollarRisk = (riskPS * qty).toFixed(2);

          addLog(state, 'SHORT', `Placing SHORT ${qty}× ${ticker} @ ~$${price.toFixed(2)}`,
            `gap ${sig.gapPct.toFixed(1)}% | risk $${dollarRisk} | SL $${slF} | TP $${tpF} | R:R ${rr}`);

          try {
            // BRACKET = real broker-side stop. If Alpaca can't borrow/locate, this
            // throws and we SKIP — never a naked short.
            const order = await alpaca('POST', '/v2/orders', {
              symbol: ticker, qty: String(qty), side: 'sell', type: 'market', time_in_force: 'gtc',
              order_class: 'bracket', take_profit: { limit_price: String(tpF) }, stop_loss: { stop_price: String(slF) },
            });
            if (order.id) {
              addLog(state, 'SHORT', `✓ SHORT PLACED: ${qty}× ${ticker}`, `ID ${order.id} | R:R ${rr}:1 | risk $${dollarRisk} | real bracket stop @ $${slF}`);
              state.trailingStops[ticker] = {
                side: 'short', entry: price, high: price, low: price,
                initialSl: slF, sl: slF, tp: tpF, slOrderId: null, tpOrderId: null, movedToBreakeven: false,
              };
              sExisting.add(ticker); shortedThisCycle.add(ticker);
              state.shortDailyTrades = (state.shortDailyTrades || 0) + 1;
              state.shortTradedToday.push(ticker);
              managed.push({ symbol: ticker });   // count toward concurrent position cap
            }
          } catch (e) {
            // Most common: not shortable / hard-to-borrow / no locate → SKIP, not naked.
            addLog(state, 'INFO', `SKIP SHORT ${ticker} — ${e.message.slice(0, 80)}`);
          }
          await sleep(500);
        }
      } else {
        addLog(state, 'INFO', 'No short signals meeting criteria');
      }
    }
  }

  saveState(state);
  console.log('\n✓ Cycle complete');
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
