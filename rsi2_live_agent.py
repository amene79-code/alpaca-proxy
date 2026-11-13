#!/usr/bin/env python3
"""
RSI(2) LIVE COST-MEASUREMENT AGENT   (PAPER TRADING ONLY)
==========================================================
This agent is NOT here to make money. It has ONE job: measure what real fills
actually cost versus the price we decided on, for the RSI(2) + SPY-regime
mean-reversion strategy that passed out-of-sample backtesting.

WHY THIS EXISTS
---------------
The backtest showed a real but THIN edge:
    - survives out-of-sample (TEST profit factor ~1.25)
    - survives a bear market once the SPY regime filter is added
    - but DIES by ~20 bps/side slippage, and is only comfortable under ~10-15 bps.
A backtest cannot know real slippage on OVERSOLD names (they trade on down days,
often with wider spreads). That single unknown decides whether the edge is real
money or a mirage. So this agent logs, for every entry and exit:

        decision price  ->  actual fill price  ->  slippage in bps

Positive slippage_bps always means it COST us. After a few weeks, run the summary
and compare measured slippage to the backtest break-even line (~20 bps/side).
If real fills come in under ~10-15 bps/side -> the edge is real, go live for real.
If worse -> shelve it. Either answer is a win; we just need the number.

STRATEGY (identical to rsi2_backtest.py — do not "improve" it here)
-------------------------------------------------------------------
ENTRY (long only):  RSI(2) < 10  AND  price > 200-day MA  AND  SPY > its 200-day MA
EXIT (priority):    price > 5-day MA (ma_cross) -> RSI(2) > 70 (rsi_exit)
                    -> down >= 8% from fill (stop) -> held >= 10 trading days (time)
Evaluated once per trading day near the close, exactly like the backtest (which
never used intraday stops). Tiny $1000 notional per name so our own order never
moves the fill.

HOW TO RUN
----------
1.  pip3 install alpaca-py pandas numpy      (you already have these)
2.  Put your PAPER keys below (or set env vars ALPACA_API_KEY / ALPACA_SECRET_KEY).
    A DEDICATED paper account is cleanest so this experiment's equity curve is
    isolated from the other agents.
3.  FIRST run with DRY_RUN = True (the default). It prints what it WOULD do and
    places no orders:
        python3 rsi2_live_agent.py
4.  When the signals look sane, set DRY_RUN = False and run it ONCE PER TRADING
    DAY at ~15:45 US Eastern (about 20:45 UK in winter, 19:45 in summer). A cron
    line is given at the bottom of this file.
5.  Any time, see the measurement collected so far:
        python3 rsi2_live_agent.py --summary

SAFETY
------
* paper=True is hard-wired; the agent refuses to run against a live account.
* Market orders are used ON PURPOSE — they always fill, which is exactly how we
  measure true taker cost. Size is tiny so fills aren't distorted by us.
* The time-stop counter assumes ONE run per trading day (the intended usage).
"""

import os
import sys
import json
import time
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

# ----------------------------------------------------------------------------
# CONFIG
# ----------------------------------------------------------------------------
ALPACA_API_KEY    = os.getenv("ALPACA_API_KEY",    "PUT_YOUR_PAPER_KEY_HERE")
ALPACA_SECRET_KEY = os.getenv("ALPACA_SECRET_KEY", "PUT_YOUR_PAPER_SECRET_HERE")

# >>> SAFETY: dry run (no orders) UNLESS RSI2_DRY_RUN is explicitly "false". <<<
#   Local run: either edit this line to False, or export RSI2_DRY_RUN=false.
#   GitHub Actions: set env RSI2_DRY_RUN: "false" in the workflow when ready.
# Any unset/garbage value stays safe (dry). Only an explicit false trades.
DRY_RUN = os.getenv("RSI2_DRY_RUN", "true").strip().lower() not in ("false", "0", "no", "off")

# Only act in the final window before the close. This keeps entries near the
# backtest's at-the-close convention AND lets a DST-spanning cron fire twice a
# day safely: whichever run lands nearest the close acts, the other no-ops.
MINUTES_BEFORE_CLOSE_MAX = 45

# --- Strategy parameters (MUST match rsi2_backtest.py) ---
RSI_PERIOD      = 2
RSI_ENTRY       = 10      # buy when RSI(2) below this
RSI_EXIT        = 70      # exit when RSI(2) above this
EXIT_MA_LEN     = 5       # exit when price crosses back above this MA
TREND_MA_LEN    = 200     # only buy above this (oversold-in-uptrend)
MAX_HOLD_DAYS   = 10      # time stop, counted in daily runs
STOP_LOSS_PCT   = 0.08    # hard stop from actual fill price

# --- Market-regime filter (must match the backtest) ---
USE_REGIME_FILTER = True
REGIME_SYMBOL     = "SPY"
REGIME_MA_LEN     = 200

# --- Sizing & housekeeping ---
DOLLARS_PER_TRADE = 1000.0   # tiny, matches backtest notional for apples-to-apples
MAX_POSITIONS     = 20       # cap concurrent names
MAX_NEW_PER_DAY   = 10       # cap new entries in a single run

# Kept in state/ to match this repo's existing convention (the Pro Agent commits
# its state there too). Distinct filenames, so no collision with other agents.
STATE_FILE = "state/rsi2_live_state.json"   # our own record of open positions
FILLS_FILE = "state/rsi2_live_fills.csv"    # THE DELIVERABLE: every fill, decision vs actual

# S&P 100 (OEX) — identical universe to the backtest.
UNIVERSE = [
    "AAPL","MSFT","NVDA","AMZN","META","GOOGL","GOOG","BRK.B","AVGO","TSLA",
    "JPM","LLY","V","XOM","UNH","MA","COST","HD","PG","JNJ",
    "NFLX","BAC","ABBV","CRM","ORCL","CVX","KO","MRK","WMT","CSCO",
    "AMD","PEP","ACN","LIN","ADBE","MCD","ABT","TMO","PM","GE",
    "CAT","TXN","INTU","WFC","QCOM","IBM","DIS","CMCSA","AMGN","NOW",
    "ISRG","GS","MS","RTX","HON","UNP","AMAT","PFE","T","LOW",
    "BKNG","UBER","SPGI","COP","BLK","AXP","ELV","VZ","NEE","PLD",
    "C","BA","SBUX","GILD","MDT","DE","LMT","ADI","MMC","BMY",
    "CB","MDLZ","SCHW","TJX","SO","MO","DUK","CI","BX","PGR",
    "FI","ZTS","REGN","MU","PANW","CL","APH","BSX","TGT","USB",
]

FILLS_COLS = ["timestamp","action","symbol","leg","qty","decision_px",
              "fill_px","slippage_bps","reason","order_id","notional"]

# ----------------------------------------------------------------------------
# Indicators (identical maths to the backtest)
# ----------------------------------------------------------------------------
def wilder_rsi(close, period):
    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    avg_gain = gain.ewm(alpha=1/period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1/period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return rsi.fillna(50)

# ----------------------------------------------------------------------------
# State persistence
# ----------------------------------------------------------------------------
def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f:
                return json.load(f)
        except Exception as e:
            print(f"!! could not read {STATE_FILE} ({e}); starting fresh")
    return {"positions": {}}   # symbol -> {fill_px, qty, entry_date, runs_held}

def save_state(state):
    d = os.path.dirname(STATE_FILE)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)

def log_fill(row):
    d = os.path.dirname(FILLS_FILE)
    if d:
        os.makedirs(d, exist_ok=True)
    df = pd.DataFrame([row], columns=FILLS_COLS)
    header = not os.path.exists(FILLS_FILE)
    df.to_csv(FILLS_FILE, mode="a", header=header, index=False)

# ----------------------------------------------------------------------------
# Data helpers
# ----------------------------------------------------------------------------
def get_daily_frames(data_client, symbols):
    """Completed daily bars (split-adjusted) up to yesterday, per symbol."""
    from alpaca.data.requests import StockBarsRequest
    from alpaca.data.timeframe import TimeFrame
    start = (datetime.now(timezone.utc) - timedelta(days=420)).date()
    end   = (datetime.now(timezone.utc) - timedelta(days=1)).date()   # exclude today
    frames = {}
    for sym in symbols:
        try:
            req = StockBarsRequest(symbol_or_symbols=sym, timeframe=TimeFrame.Day,
                                   start=start, end=end, adjustment="split")
            bars = data_client.get_stock_bars(req).df
            if bars is None or len(bars) == 0:
                continue
            bars = bars.reset_index()
            if "symbol" in bars.columns:
                bars = bars[bars["symbol"] == sym]
            bars = bars.set_index("timestamp").sort_index()
            frames[sym] = bars[["close"]].astype(float)
        except Exception as e:
            print(f"   {sym}: bar fetch error {e}")
    return frames

def get_latest_prices(data_client, symbols):
    """Latest trade price per symbol = our 'decision price' at this moment."""
    from alpaca.data.requests import StockLatestTradeRequest
    out = {}
    CHUNK = 50
    for i in range(0, len(symbols), CHUNK):
        chunk = symbols[i:i+CHUNK]
        try:
            req = StockLatestTradeRequest(symbol_or_symbols=chunk)
            res = data_client.get_stock_latest_trade(req)
            for sym, tr in res.items():
                out[sym] = float(tr.price)
        except Exception as e:
            print(f"   latest-trade error for {chunk[:3]}...: {e}")
    return out

def provisional_close_series(daily_close, today_px):
    """Append today's live price as the provisional close so signals match
    the backtest's 'evaluate at today's close' convention."""
    s = daily_close.copy()
    today = pd.Timestamp(datetime.now(timezone.utc).date(), tz="UTC")
    s.loc[today] = today_px
    return s.sort_index()

# ----------------------------------------------------------------------------
# Order placement + fill measurement
# ----------------------------------------------------------------------------
def market_order_and_measure(trading_client, sym, qty, side, decision_px):
    """Submit a market order, wait for the fill, return (fill_px, order_id, filled_qty)."""
    from alpaca.trading.requests import MarketOrderRequest
    from alpaca.trading.enums import OrderSide, TimeInForce, OrderStatus
    req = MarketOrderRequest(
        symbol=sym, qty=qty,
        side=OrderSide.BUY if side == "buy" else OrderSide.SELL,
        time_in_force=TimeInForce.DAY,
    )
    order = trading_client.submit_order(req)
    oid = str(order.id)
    # poll for the fill
    for _ in range(20):
        o = trading_client.get_order_by_id(oid)
        st = o.status
        if st in (OrderStatus.FILLED,):
            fill_px = float(o.filled_avg_price)
            fqty = float(o.filled_qty)
            return fill_px, oid, fqty
        if st in (OrderStatus.CANCELED, OrderStatus.REJECTED, OrderStatus.EXPIRED):
            print(f"   !! {sym} order {st}")
            return None, oid, 0.0
        time.sleep(0.75)
    print(f"   !! {sym} order still not filled after wait; will reconcile next run")
    return None, oid, 0.0

def slippage_bps(decision_px, fill_px, side):
    if not decision_px or not fill_px:
        return None
    if side == "buy":
        return (fill_px - decision_px) / decision_px * 1e4   # paid more = +cost
    else:
        return (decision_px - fill_px) / decision_px * 1e4   # got less  = +cost

# ----------------------------------------------------------------------------
# The daily run
# ----------------------------------------------------------------------------
def run():
    if ALPACA_API_KEY.startswith("PUT_YOUR"):
        print("!! Set your PAPER API keys at the top of the file (or env vars). Aborting.")
        sys.exit(1)

    from alpaca.trading.client import TradingClient
    from alpaca.data.historical import StockHistoricalDataClient

    trading = TradingClient(ALPACA_API_KEY, ALPACA_SECRET_KEY, paper=True)  # PAPER hard-wired
    data    = StockHistoricalDataClient(ALPACA_API_KEY, ALPACA_SECRET_KEY)

    acct = trading.get_account()
    print("="*70)
    print(f"RSI(2) LIVE COST AGENT   {'[DRY RUN - no orders]' if DRY_RUN else '[LIVE PAPER]'}")
    print(f"Account {acct.account_number} | status {acct.status} | "
          f"equity ${float(acct.equity):,.0f} | cash ${float(acct.cash):,.0f}")
    print("="*70)

    # Market-open guard
    clock = trading.get_clock()
    if not clock.is_open:
        print(f"Market is CLOSED. Next open: {clock.next_open}. Nothing to do.")
        print("(Scheduled for ~15:45 ET on trading days.)")
        return

    # Only act in the final window before the close (see MINUTES_BEFORE_CLOSE_MAX).
    # Early-return BEFORE any state change so a too-early run is a true no-op.
    mins_to_close = (clock.next_close - datetime.now(timezone.utc)).total_seconds() / 60.0
    if mins_to_close > MINUTES_BEFORE_CLOSE_MAX:
        print(f"Market open but {mins_to_close:.0f} min to close "
              f"(> {MINUTES_BEFORE_CLOSE_MAX}). Not the near-close run — no action.")
        return

    state = load_state()
    positions = state["positions"]

    # Hard guard: act at most once per calendar day. Belt-and-braces against the
    # two cron slots ever overlapping (e.g. GitHub running a job late).
    today = datetime.now(timezone.utc).date().isoformat()
    if not DRY_RUN and state.get("last_action_date") == today:
        print(f"Already acted today ({today}) — skipping to avoid a double run.")
        return

    # Reconcile our record against what Alpaca actually holds
    broker_pos = {p.symbol: p for p in trading.get_all_positions()}
    for sym in list(positions.keys()):
        if sym not in broker_pos:
            print(f"   note: {sym} in our state but not at broker — dropping (closed elsewhere)")
            positions.pop(sym)

    # --- Data ---
    need = list(UNIVERSE)
    if USE_REGIME_FILTER and REGIME_SYMBOL not in need:
        need = [REGIME_SYMBOL] + need
    print(f"Fetching daily bars for {len(need)} symbols ...")
    frames = get_daily_frames(data, need)
    print(f"Fetching latest prices ...")
    last = get_latest_prices(data, need)

    # Regime check
    regime_ok = True
    if USE_REGIME_FILTER:
        spy = frames.get(REGIME_SYMBOL)
        spy_px = last.get(REGIME_SYMBOL)
        if spy is None or spy_px is None:
            print("   !! SPY data missing — holding off on NEW entries this run (safety).")
            regime_ok = False
        else:
            spy_s = provisional_close_series(spy["close"], spy_px)
            spy_ma = spy_s.rolling(REGIME_MA_LEN).mean().iloc[-1]
            regime_ok = spy_px > spy_ma
            print(f"Regime: SPY {spy_px:.2f} vs 200MA {spy_ma:.2f} -> "
                  f"{'HEALTHY (entries allowed)' if regime_ok else 'UNHEALTHY (no new entries)'}")

    # --- EXITS first (free up slots, mirror backtest close-based checks) ---
    print("\n--- EXITS ---")
    exited_today = []
    for sym in list(positions.keys()):
        pos = positions[sym]
        df = frames.get(sym)
        px = last.get(sym)
        if df is None or px is None:
            print(f"   {sym}: no data, skipping exit check")
            continue
        s = provisional_close_series(df["close"], px)
        rsi = wilder_rsi(s, RSI_PERIOD).iloc[-1]
        ma_exit = s.rolling(EXIT_MA_LEN).mean().iloc[-1]
        fill_px = pos["fill_px"]
        pos["runs_held"] = pos.get("runs_held", 0) + 1
        held = pos["runs_held"]

        reason = ""
        if px > ma_exit:                         reason = "ma_cross"
        elif rsi > RSI_EXIT:                     reason = "rsi_exit"
        elif px <= fill_px * (1 - STOP_LOSS_PCT): reason = "stop"
        elif held >= MAX_HOLD_DAYS:              reason = "time"

        if not reason:
            print(f"   {sym}: hold (px {px:.2f}, 5MA {ma_exit:.2f}, RSI {rsi:.0f}, "
                  f"held {held}d, stop {fill_px*(1-STOP_LOSS_PCT):.2f})")
            continue

        qty = pos["qty"]
        print(f"   {sym}: EXIT ({reason}) qty {qty} @ decision {px:.2f}")
        if DRY_RUN:
            exited_today.append(sym)
            continue
        fpx, oid, fqty = market_order_and_measure(trading, sym, qty, "sell", px)
        slip = slippage_bps(px, fpx, "sell")
        log_fill({"timestamp": datetime.now(timezone.utc).isoformat(), "action": "SELL",
                  "symbol": sym, "leg": "exit", "qty": fqty or qty, "decision_px": round(px,4),
                  "fill_px": round(fpx,4) if fpx else "", "slippage_bps": round(slip,2) if slip is not None else "",
                  "reason": reason, "order_id": oid, "notional": round((fpx or px)*(fqty or qty),2)})
        if fpx:
            print(f"      filled {fpx:.4f}  slippage {slip:+.1f} bps")
            exited_today.append(sym)
    for sym in exited_today:
        positions.pop(sym, None)

    # --- ENTRIES ---
    print("\n--- ENTRIES ---")
    if not regime_ok:
        print("   Regime unhealthy — no new entries (by design).")
    else:
        slots = MAX_POSITIONS - len(positions)
        new_count = 0
        candidates = []
        for sym in UNIVERSE:
            if sym in positions:        continue
            df = frames.get(sym)
            px = last.get(sym)
            if df is None or px is None: continue
            s = provisional_close_series(df["close"], px)
            if len(s) < TREND_MA_LEN + 2: continue
            rsi = wilder_rsi(s, RSI_PERIOD).iloc[-1]
            ma_trend = s.rolling(TREND_MA_LEN).mean().iloc[-1]
            if rsi < RSI_ENTRY and px > ma_trend:
                candidates.append((rsi, sym, px))   # most oversold first
        candidates.sort()

        if not candidates:
            print("   No oversold-in-uptrend signals today.")
        for rsi, sym, px in candidates:
            if new_count >= MAX_NEW_PER_DAY or slots <= 0:
                print(f"   (cap reached; {len(candidates)-new_count} more signals skipped)")
                break
            qty = int(DOLLARS_PER_TRADE / px)
            if qty < 1:
                print(f"   {sym}: price {px:.2f} > ${DOLLARS_PER_TRADE:.0f}, too big for size, skip")
                continue
            print(f"   {sym}: ENTRY signal RSI {rsi:.0f}, qty {qty} @ decision {px:.2f}")
            if DRY_RUN:
                new_count += 1; slots -= 1
                continue
            fpx, oid, fqty = market_order_and_measure(trading, sym, qty, "buy", px)
            slip = slippage_bps(px, fpx, "buy")
            log_fill({"timestamp": datetime.now(timezone.utc).isoformat(), "action": "BUY",
                      "symbol": sym, "leg": "entry", "qty": fqty or qty, "decision_px": round(px,4),
                      "fill_px": round(fpx,4) if fpx else "", "slippage_bps": round(slip,2) if slip is not None else "",
                      "reason": "signal", "order_id": oid, "notional": round((fpx or px)*(fqty or qty),2)})
            if fpx:
                print(f"      filled {fpx:.4f}  slippage {slip:+.1f} bps")
                positions[sym] = {"fill_px": fpx, "qty": fqty or qty,
                                  "entry_date": datetime.now(timezone.utc).date().isoformat(),
                                  "runs_held": 0}
                new_count += 1; slots -= 1

    state["positions"] = positions
    state["last_action_date"] = today   # mark that this calendar day's run completed
    if not DRY_RUN:
        save_state(state)
    print(f"\nOpen positions now: {len(positions)}  {list(positions.keys())}")
    if DRY_RUN:
        print("\n[DRY RUN] No orders placed, no state saved. Set DRY_RUN=False to trade.")
    else:
        print(f"\nFills logged to {FILLS_FILE}. Run  python3 {os.path.basename(__file__)} --summary  anytime.")

# ----------------------------------------------------------------------------
# The payoff: what did fills actually cost?
# ----------------------------------------------------------------------------
def summary():
    if not os.path.exists(FILLS_FILE):
        print(f"No fills yet ({FILLS_FILE} not found). Let the agent trade a few sessions first.")
        return
    df = pd.read_csv(FILLS_FILE)
    df = df[pd.to_numeric(df["slippage_bps"], errors="coerce").notna()].copy()
    df["slippage_bps"] = df["slippage_bps"].astype(float)
    if df.empty:
        print("No filled orders with measurable slippage yet.")
        return

    entries = df[df["leg"] == "entry"]["slippage_bps"]
    exits   = df[df["leg"] == "exit"]["slippage_bps"]

    print("="*70)
    print("REAL FILL COST — measured vs the backtest's break-even line")
    print("="*70)
    print(f"Fills logged:        {len(df)}  ({len(entries)} entries, {len(exits)} exits)")
    if len(entries):
        print(f"\nENTRY slippage (bps, + = cost):  mean {entries.mean():+.1f} | "
              f"median {entries.median():+.1f} | worst {entries.max():+.1f}")
    if len(exits):
        print(f"EXIT  slippage (bps, + = cost):  mean {exits.mean():+.1f} | "
              f"median {exits.median():+.1f} | worst {exits.max():+.1f}")

    per_side = df["slippage_bps"].mean()
    round_trip = (entries.mean() if len(entries) else 0) + (exits.mean() if len(exits) else 0)
    print(f"\nAverage cost PER SIDE:     {per_side:+.1f} bps")
    print(f"Average ROUND-TRIP cost:   {round_trip:+.1f} bps  (entry + exit)")

    print("\n--- VERDICT GUIDE (from the backtest cost-sensitivity table) ---")
    print("  Backtest TEST profit factor by assumed slippage/side:")
    print("     5 bps -> PF 1.25   |  10 bps -> PF 1.15")
    print("    15 bps -> PF 1.06   |  20 bps -> PF 0.98 (break-even)")
    ps = df["slippage_bps"].mean()
    if ps <= 10:
        print(f"\n  Measured ~{ps:.0f} bps/side  ->  COMFORTABLY inside the edge. Promising.")
    elif ps <= 15:
        print(f"\n  Measured ~{ps:.0f} bps/side  ->  MARGINAL. Edge survives but thin; need a big sample.")
    else:
        print(f"\n  Measured ~{ps:.0f} bps/side  ->  AT/PAST break-even. Real costs likely eat the edge.")
    print("\n  Caveat: paper fills can be OPTIMISTIC vs real money. Treat a marginal")
    print("  paper result as a fail, not a pass. Sample size matters — wait for 30+ fills.")
    print("="*70)

# ----------------------------------------------------------------------------
if __name__ == "__main__":
    if "--summary" in sys.argv:
        summary()
    else:
        run()

# ----------------------------------------------------------------------------
# CRON (once per trading day, ~15:45 US Eastern). Edit the path, then `crontab -e`:
#   # 15:45 ET = 20:45 UTC (Nov-Mar) / 19:45 UTC (Mar-Nov). Use 20:45 and it runs
#   # 15:45 or 14:45 ET depending on DST; both are safely before the close.
#   45 20 * * 1-5  cd /path/to/folder && /usr/bin/python3 rsi2_live_agent.py >> rsi2_live.log 2>&1
# The market-open guard means weekend/holiday runs harmlessly no-op.
# ----------------------------------------------------------------------------
