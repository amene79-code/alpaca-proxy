export const config = { runtime: "edge" };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ── Finviz screener (US stocks) ───────────────────────────────────
async function finvizScreen(filters = "") {
  // Default filters: rel volume > 1.5x, price > $2, avg vol > 200k
  const f = filters || "sh_relvol_o1.5,sh_price_o2,sh_avgvol_o200";
  const url = `https://finviz.com/screener.ashx?v=111&f=${f}&ft=4`;

  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://finviz.com/",
    },
  });

  if (!resp.ok) throw new Error(`Finviz HTTP ${resp.status}`);
  const html = await resp.text();

  // Extract tickers from screener table
  const tickers = new Set();
  const regex = /quote\.ashx\?t=([A-Z.]+)[&"]/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    if (match[1] && match[1].length <= 5) tickers.add(match[1]);
  }
  return [...tickers].slice(0, 100);
}

// ── Yahoo Finance movers ──────────────────────────────────────────
async function yahooMovers(listId, region = "US") {
  const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${listId}&count=50&fields=symbol,regularMarketChangePercent,regularMarketVolume&region=${region}&lang=en-US`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json",
    },
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  const quotes = data?.finance?.result?.[0]?.quotes || [];
  return quotes.map(q => q.symbol).filter(Boolean);
}

// ── LSE most active via Yahoo ─────────────────────────────────────
async function lseMovers() {
  // Yahoo Finance LSE most active uses .L suffix
  const url = `https://query1.finance.yahoo.com/v1/finance/screener?crumb=&lang=en-GB&region=GB&scrIds=most_actives&count=40&fields=symbol`;
  try {
    const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!resp.ok) return [];
    const data = await resp.json();
    const quotes = data?.finance?.result?.[0]?.quotes || [];
    return quotes.map(q => q.symbol).filter(s => s.endsWith(".L"));
  } catch { return []; }
}

// ── Euronext most active via Yahoo ───────────────────────────────
async function euronextMovers() {
  const url = `https://query1.finance.yahoo.com/v1/finance/screener?lang=fr-FR&region=FR&scrIds=most_actives&count=40&fields=symbol`;
  try {
    const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!resp.ok) return [];
    const data = await resp.json();
    const quotes = data?.finance?.result?.[0]?.quotes || [];
    return quotes.map(q => q.symbol).filter(s => s.endsWith(".PA"));
  } catch { return []; }
}

// ── Finviz preset filter sets ─────────────────────────────────────
const FILTER_PRESETS = {
  // High volume movers — stocks with unusual activity today
  movers:     "sh_relvol_o2,sh_price_o2,sh_avgvol_o200,sh_curvol_o500",
  // Oversold bounces — RSI < 35, volume picking up
  oversold:   "ta_rsi_os35,sh_relvol_o1.5,sh_price_o5,sh_avgvol_o200",
  // Breakout candidates — near 52w high with volume
  breakout:   "ta_highlow52w_nh,sh_relvol_o2,sh_avgvol_o200,sh_price_o5",
  // Gap ups — opened significantly higher
  gap_up:     "ta_gap_u,sh_avgvol_o200,sh_price_o5",
  // Small cap movers — hidden gems under $2B market cap
  smallcap:   "cap_small,sh_relvol_o2,sh_price_o2,sh_avgvol_o100",
  // Momentum — strong price action last week
  momentum:   "ta_perf_1w10o,sh_relvol_o1.5,sh_avgvol_o200,sh_price_o5",
  // All combined — broad scan
  all:        "sh_relvol_o1.5,sh_price_o2,sh_avgvol_o100",
};

// ── Main handler ──────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url    = new URL(req.url);
  const market = url.searchParams.get("market") || "us";
  const preset = url.searchParams.get("preset") || "movers";
  const custom = url.searchParams.get("filters") || "";

  try {
    let tickers = [];

    if (market === "us") {
      // Finviz screener + Yahoo movers combined
      const [finviz, gainers, active, trending] = await Promise.allSettled([
        finvizScreen(custom || FILTER_PRESETS[preset] || FILTER_PRESETS.movers),
        yahooMovers("day_gainers"),
        yahooMovers("most_actives"),
        yahooMovers("trending_tickers"),
      ]);

      const all = [
        ...(finviz.status === "fulfilled" ? finviz.value : []),
        ...(gainers.status === "fulfilled" ? gainers.value : []),
        ...(active.status === "fulfilled" ? active.value : []),
        ...(trending.status === "fulfilled" ? trending.value : []),
      ];

      // Deduplicate, score by frequency (appears in multiple lists = higher priority)
      const freq = {};
      all.forEach(t => freq[t] = (freq[t] || 0) + 1);
      tickers = Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .map(([t]) => t)
        .filter(t => !t.includes(".") || t.endsWith(".")) // US tickers only
        .slice(0, 80);

    } else if (market === "uk") {
      const [lse, active] = await Promise.allSettled([
        lseMovers(),
        yahooMovers("most_actives", "GB"),
      ]);
      const all = [
        ...(lse.status === "fulfilled" ? lse.value : []),
        ...(active.status === "fulfilled" ? active.value : []),
      ];
      tickers = [...new Set(all)].slice(0, 50);

    } else if (market === "eu") {
      const moved = await euronextMovers();
      tickers = moved.slice(0, 50);

    } else if (market === "all") {
      // All markets combined
      const [us, uk, eu] = await Promise.allSettled([
        handler(new Request(req.url.replace("market=all", "market=us"))),
        handler(new Request(req.url.replace("market=all", "market=uk"))),
        handler(new Request(req.url.replace("market=all", "market=eu"))),
      ]);
      const parse = async r => r.status === "fulfilled" ? (await r.value.json()).tickers || [] : [];
      tickers = [
        ...(await parse(us)),
        ...(await parse(uk)),
        ...(await parse(eu)),
      ];
    }

    return json({
      tickers,
      count: tickers.length,
      market,
      preset,
      timestamp: new Date().toISOString(),
    });

  } catch (e) {
    return json({ error: e.message, tickers: [] }, 500);
  }
}
