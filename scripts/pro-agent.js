/**
 * Pro Agent — GitHub Actions edition
 * Runs every 10 min via cron, manages trailing stops + places new orders
 * State persists between runs via state/state.json committed to repo
 */

import fetch from 'node-fetch';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', 'state', 'state.json');

// ─── Config ──────────────────────────────────────────────────────────────────
const CFG = {
  size:       500,    // $ per position
  maxPos:     20,     // max open positions
  maxDaily:   20,     // max trades per day
  atrSL:      1.5,    // ATR × SL multiplier
  atrTP:      3.0,    // ATR × TP multiplier
  trail:      0.02,   // 2% trailing stop
  minScore:   2,      // min pattern score
  maxATRpct:  0.1,    // min ATR%
  earningsBuf:3,      // days buffer around earnings
};

// ─── Alpaca API ───────────────────────────────────────────────────────────────
const BASE = (process.env.ALPACA_URL || 'https://paper-api.alpaca.markets').replace(/\/$/, '');
const HEADERS = {
  'APCA-API-KEY-ID':     process.env.ALPACA_KEY,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET,
  'Content-Type':        'application/json',
};

async function alpaca(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
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

// ─── Screener ─────────────────────────────────────────────────────────────────
async function runScreener() {
  const tickers = new Map(); // ticker -> score

  // Yahoo Finance trending
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v1/finance/trending/US?count=20', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (r.ok) {
      const d = await r.json();
      (d?.finance?.result?.[0]?.quotes || []).forEach(q => {
        if (/^[A-Z]{1,5}$/.test(q.symbol)) tickers.set(q.symbol, (tickers.get(q.symbol) || 0) + 0.5);
      });
    }
  } catch {}

  // Apewisdom (WSB mentions)
  try {
    const r = await fetch('https://apewisdom.io/api/v1.0/filter/wallstreetbets/page/1');
    if (r.ok) {
      const d = await r.json();
      (d?.results || []).slice(0, 20).forEach(item => {
        const t = (item.ticker || '').toUpperCase();
        if (/^[A-Z]{1,5}$/.test(t)) {
          const score = Math.min(3, (item.mentions || 1) / 50);
          tickers.set(t, (tickers.get(t) || 0) + score);
        }
      });
    }
  } catch {}

  // Stocktwits trending
  try {
    const r = await fetch('https://api.stocktwits.com/api/2/trending/symbols.json');
    if (r.ok) {
      const d = await r.json();
      (d?.symbols || []).slice(0, 20).forEach(s => {
        const t = (s.symbol || '').toUpperCase();
        if (/^[A-Z]{1,5}$/.test(t)) {
          const bonus = (s.watchlist_count || 0) > 50000 ? 2.0 : 1.5;
          tickers.set(t, (tickers.get(t) || 0) + bonus);
        }
      });
    }
  } catch {}

  // Sort by score, return top 40
  return [...tickers.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([ticker]) => ticker);
}

// ─── Technical indicators ─────────────────────────────────────────────────────
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = candles.slice(1).map((c, i) =>
    Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close))
  );
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
  const rs = gains / (losses || 0.001);
  return 100 - 100 / (1 + rs);
}

function calcVWAP(candles) {
  let cumTPV = 0, cumVol = 0;
  const today = new Date().toDateString();
  for (const c of candles) {
    const d = new Date(c.t * 1000).toDateString();
    if (d !== today) continue;
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * (c.volume || 0);
    cumVol += c.volume || 0;
  }
  return cumVol > 0 ? cumTPV / cumVol : 0;
}

// ─── Pattern detection ────────────────────────────────────────────────────────
function detectPatterns(candles) {
  const patterns = [];
  const n = candles.length;
  if (n < 3) return patterns;

  for (let i = Math.max(1, n - 5); i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const body  = Math.abs(c.close - c.open);
    const range = c.high - c.low || 0.001;
    const pbody = Math.abs(p.close - p.open);
    const bull  = c.close > c.open;

    // Hammer
    const lWick = Math.min(c.open, c.close) - c.low;
    const uWick = c.high - Math.max(c.open, c.close);
    if (lWick > body * 2 && uWick < body * 0.5 && body > 0)
      patterns.push({ name: 'Hammer', strength: 2, bullish: true });

    // Bullish Engulfing
    if (p.close < p.open && c.close > c.open &&
        c.open < p.close && c.close > p.open && body > pbody)
      patterns.push({ name: 'Bullish Engulfing', strength: 3, bullish: true });

    // Doji
    if (body / range < 0.1 && range > 0)
      patterns.push({ name: 'Doji', strength: 1, bullish: null });

    // Volume Breakout
    const avgVol = candles.slice(Math.max(0, i - 10), i)
      .reduce((s, c) => s + (c.volume || 0), 0) / 10;
    if ((c.volume || 0) > avgVol * 2.5 && bull)
      patterns.push({ name: 'Volume Breakout', strength: 3, bullish: true });

    // Gap Up
    if (i > 0 && c.open > candles[i - 1].high * 1.005)
      patterns.push({ name: 'Gap Up', strength: 2, bullish: true });

    // Bull Flag (last 5 candles)
    if (i >= 4) {
      const impulse = candles[i - 4];
      const isImpulse = (impulse.close - impulse.open) / impulse.open > 0.02;
      const isConsolidation = candles.slice(i - 3, i + 1)
        .every(fc => Math.abs(fc.close - fc.open) / fc.open < 0.01);
      if (isImpulse && isConsolidation)
        patterns.push({ name: 'Bull Flag', strength: 3, bullish: true });
    }
  }

  // Deduplicate
  const seen = new Set();
  return patterns.filter(p => seen.has(p.name) ? false : seen.add(p.name));
}

// ─── Signal analysis ──────────────────────────────────────────────────────────
async function analyzeSignal(ticker) {
  const candles = await getCandles(ticker, '5d', '5m');
  if (!candles || candles.length < 30) return null;

  const price  = candles[candles.length - 1].close;
  const atr    = calcATR(candles, 14);
  const atrPct = atr / price * 100;
  if (atrPct < CFG.maxATRpct) return null;

  const rsi      = calcRSI(candles, 14);
  const vwap     = calcVWAP(candles);
  const patterns = detectPatterns(candles);
  const bullish  = patterns.filter(p => p.bullish === true);
  if (!bullish.length) return null;

  // Score
  let score = bullish.reduce((s, p) => s + p.strength, 0);
  if (rsi < 70) score += 1;
  if (price > vwap) score += 1;

  // Average volume check
  const recentVol = candles.slice(-5).reduce((s, c) => s + (c.volume || 0), 0) / 5;
  const avgVol    = candles.slice(-30).reduce((s, c) => s + (c.volume || 0), 0) / 30;
  if (recentVol > avgVol * 1.5) score += 1;

  return { ticker, price, atr, atrPct, rsi, vwap, patterns: bullish, score };
}

// ─── Dynamic SL/TP ────────────────────────────────────────────────────────────
function calcDynamicSL(signal) {
  const { atrPct, patterns } = signal;
  let mult = CFG.atrSL;
  if (atrPct > 4) mult = 2.8;
  else if (atrPct > 2.5) mult = 2.2;
  else if (atrPct > 1.5) mult = 1.8;
  else if (atrPct > 0.8) mult = 1.5;
  else if (atrPct > 0.4) mult = 1.2;
  const names = patterns.map(p => p.name);
  if (names.includes('Volume Breakout')) mult *= 0.85;
  if (names.includes('Hammer')) mult *= 1.15;
  // Time of day
  const h = new Date().getUTCHours();
  const etH = h - 4; // rough ET offset (EDT)
  if (etH >= 9 && etH < 10) mult *= 1.35;
  return Math.round(mult * 10) / 10;
}

function calcDynamicTP(signal, slMult) {
  const { atrPct, rsi } = signal;
  let mult = slMult * (CFG.atrTP / CFG.atrSL);
  if (atrPct > 4) mult *= 1.15;
  if (rsi > 80) mult *= 0.75;
  else if (rsi > 70) mult *= 0.90;
  else if (rsi < 40) mult *= 1.10;
  // Time of day (ET)
  const h = new Date().getUTCHours();
  const etMins = (h - 4) * 60 + new Date().getUTCMinutes();
  const minsAfterOpen = etMins - (9 * 60 + 30);
  const minsToClose   = (16 * 60) - etMins;
  if (minsAfterOpen < 15)     mult *= 1.25;
  else if (minsAfterOpen < 60) mult *= 1.1;
  else if (minsToClose < 30)  mult *= 0.55;
  else if (minsToClose < 60)  mult *= 0.75;
  else if (etMins > 11 * 60 && etMins < 14 * 60) mult *= 0.9;
  return Math.round(mult * 10) / 10;
}

// ─── State management ─────────────────────────────────────────────────────────
function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { trailingStops: {}, dailyTrades: 0, dailyDate: '', openPositions: [], log: [] };
  }
}

function saveState(state) {
  // Keep only last 200 log entries
  if (state.log.length > 200) state.log = state.log.slice(-200);
  state.lastRun = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function addLog(state, type, msg, detail = '') {
  const entry = { time: new Date().toISOString(), type, msg, detail };
  state.log.push(entry);
  console.log(`[${type}] ${msg}${detail ? ' | ' + detail : ''}`);
}

// ─── Market hours check ───────────────────────────────────────────────────────
function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const h = now.getUTCHours(), m = now.getUTCMinutes();
  const utcMins = h * 60 + m;
  // NYSE: 9:30am-4pm ET = 13:30-20:00 UTC (EDT)
  return utcMins >= 13 * 60 + 30 && utcMins < 20 * 60;
}

// ─── Cancel bracket orders then sell ─────────────────────────────────────────
async function cancelAndSell(symbol, qty) {
  try {
    const orders = await alpaca('GET', `/v2/orders?status=open&limit=100&nested=true`);
    const symbolOrders = (Array.isArray(orders) ? orders : []).filter(o => o.symbol === symbol);
    for (const o of symbolOrders) {
      await alpaca('DELETE', `/v2/orders/${o.id}`).catch(() => {});
      if (o.legs) for (const leg of o.legs) await alpaca('DELETE', `/v2/orders/${leg.id}`).catch(() => {});
    }
    if (symbolOrders.length) await sleep(1200);
    await alpaca('POST', '/v2/orders', {
      symbol, qty: String(qty), side: 'sell', type: 'market', time_in_force: 'day',
    });
    return true;
  } catch (e) {
    console.error(`Failed to close ${symbol}: ${e.message}`);
    return false;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Main cycle ───────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Pro Agent — ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  const state = loadState();

  // Reset daily counter if new day
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyDate !== today) {
    state.dailyTrades = 0;
    state.dailyDate   = today;
    addLog(state, 'INFO', `New trading day — counter reset`);
  }

  if (!isMarketOpen()) {
    addLog(state, 'INFO', 'Market closed — trailing stops only');
    // Still manage trailing stops even outside hours
  }

  // ── 1. Fetch account + positions ──────────────────────────────────────────
  let account, positions;
  try {
    [account, positions] = await Promise.all([
      alpaca('GET', '/v2/account'),
      alpaca('GET', '/v2/positions'),
    ]);
    addLog(state, 'INFO',
      `Account: $${(+account.equity).toFixed(2)} | ${positions.length} positions open | ${state.dailyTrades} trades today`
    );
  } catch (e) {
    addLog(state, 'ERROR', `Account fetch failed: ${e.message}`);
    saveState(state);
    process.exit(1);
  }

  // ── 2. Manage trailing stops ──────────────────────────────────────────────
  const ictPositions = state.ictPositions || []; // don't touch ICT positions
  for (const p of positions) {
    if (ictPositions.includes(p.symbol)) continue; // ICT agent manages these

    const price = +p.current_price || 0;
    const entry = +p.avg_entry_price || 0;
    if (!price || !entry) continue;

    if (!state.trailingStops[p.symbol]) {
      state.trailingStops[p.symbol] = { high: Math.max(price, entry), entry, tp: null, sl: null };
    }

    const ts = state.trailingStops[p.symbol];
    // Update high if price moved up — but never set high to TP price
    if (price > ts.high && price !== ts.tp) ts.high = price;

    const stop = +(ts.high * (1 - CFG.trail)).toFixed(2);
    const pl   = +p.unrealized_pl || 0;

    if (price <= stop) {
      addLog(state, 'TRAIL',
        `Trailing stop: ${p.symbol} @ $${price} | High $${ts.high} → Stop $${stop} | P&L ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}`
      );
      const closed = await cancelAndSell(p.symbol, p.qty);
      if (closed) {
        addLog(state, 'SELL', `✓ Closed ${p.symbol}`, `P&L ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}`);
        delete state.trailingStops[p.symbol];
        state.openPositions = (state.openPositions || []).filter(t => t !== p.symbol);
      }
    }
  }

  // ── 3. Check if we should scan for new entries ────────────────────────────
  if (!isMarketOpen()) {
    addLog(state, 'INFO', 'Outside market hours — skipping new entries');
    saveState(state);
    return;
  }

  if (state.dailyTrades >= CFG.maxDaily) {
    addLog(state, 'INFO', `Daily limit reached (${CFG.maxDaily})`);
    saveState(state);
    return;
  }

  if (positions.length >= CFG.maxPos) {
    addLog(state, 'INFO', `Position limit reached (${positions.length}/${CFG.maxPos})`);
    saveState(state);
    return;
  }

  // ── 4. Run screener ───────────────────────────────────────────────────────
  addLog(state, 'INFO', 'Running screener...');
  const candidates = await runScreener();
  const existingSymbols = new Set(positions.map(p => p.symbol));
  const toScan = candidates.filter(t => !existingSymbols.has(t)).slice(0, 30);
  addLog(state, 'INFO', `Screener found ${candidates.length} candidates — scanning top ${toScan.length}`);

  // ── 5. Analyze signals ────────────────────────────────────────────────────
  const signals = [];
  for (const ticker of toScan) {
    try {
      const signal = await analyzeSignal(ticker);
      if (signal && signal.score >= CFG.minScore) {
        addLog(state, 'SIGNAL',
          `${ticker} — score ${signal.score} | ATR ${signal.atrPct.toFixed(2)}% | RSI ${signal.rsi.toFixed(0)}`,
          signal.patterns.map(p => p.name).join(', ')
        );
        signals.push(signal);
      }
    } catch (e) {
      console.warn(`Analysis failed for ${ticker}: ${e.message}`);
    }
    await sleep(200); // rate limit
  }

  if (!signals.length) {
    addLog(state, 'INFO', 'No signals meeting criteria');
    saveState(state);
    return;
  }

  // Sort by score
  signals.sort((a, b) => b.score - a.score);
  addLog(state, 'INFO', `Top signal: ${signals[0].ticker} (score ${signals[0].score})`);

  // ── 6. Execute top signals (max 5 per cycle) ──────────────────────────────
  const slotsAvailable = Math.min(
    CFG.maxPos - positions.length,
    CFG.maxDaily - state.dailyTrades,
    5 // max per cycle
  );

  for (const signal of signals.slice(0, slotsAvailable)) {
    if (existingSymbols.has(signal.ticker)) continue;

    const { ticker, price, atr, atrPct, patterns } = signal;
    const slMult = calcDynamicSL(signal);
    const tpMult = calcDynamicTP(signal, slMult);
    const sl     = +(price - atr * slMult).toFixed(2);
    const tp     = +(price + atr * tpMult).toFixed(2);
    const slF    = +Math.min(sl, price - 0.05).toFixed(2);
    const tpF    = +Math.max(tp, price + 0.05).toFixed(2);
    const riskPS = price - slF;
    const qty    = Math.max(1, Math.min(
      Math.floor((CFG.size * 0.02) / riskPS),
      Math.floor(CFG.size / price)
    ));
    const rr     = ((tpF - price) / (price - slF)).toFixed(1);

    addLog(state, 'BUY',
      `Placing: ${qty}x ${ticker} @ ~$${price.toFixed(2)}`,
      `Patterns: ${patterns.map(p => p.name).join(', ')} | SL ${slMult}× $${slF} | TP ${tpMult}× $${tpF} | R:R ${rr}`
    );

    try {
      const order = await alpaca('POST', '/v2/orders', {
        symbol:       ticker,
        qty:          String(qty),
        side:         'buy',
        type:         'market',
        time_in_force:'gtc',
        order_class:  'bracket',
        take_profit:  { limit_price: String(tpF) },
        stop_loss:    { stop_price: String(slF) },
      });

      if (order.id) {
        addLog(state, 'BUY', `✓ ORDER PLACED: ${qty}x ${ticker}`, `ID: ${order.id} | R:R ${rr}:1`);
        state.trailingStops[ticker] = { high: price, entry: price, tp: tpF, sl: slF };
        state.openPositions = [...(state.openPositions || []), ticker];
        existingSymbols.add(ticker);
        state.dailyTrades++;
      }
    } catch (e) {
      addLog(state, 'ERROR', `Order failed ${ticker}: ${e.message}`);
    }

    await sleep(500);
  }

  // ── 7. Save state ─────────────────────────────────────────────────────────
  saveState(state);
  console.log('\n✓ Cycle complete');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
