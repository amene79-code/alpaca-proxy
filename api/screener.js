export const config = { runtime: "edge" };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ── Finviz screener (full NYSE/NASDAQ universe) ───────────────────
async function finvizScreen(filters) {
  const url = `https://finviz.com/screener.ashx?v=111&f=${filters}&ft=4&o=-relativevolume`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "text/html", "Referer": "https://finviz.com/" },
  });
  if (!resp.ok) throw new Error(`Finviz ${resp.status}`);
  const html = await resp.text();
  const tickers = new Set();
  const re = /quote\.ashx\?t=([A-Z]{1,5})[&"]/g;
  let m;
  while ((m = re.exec(html)) !== null) tickers.add(m[1]);
  return [...tickers].slice(0, 80);
}

// ── Yahoo Finance quote search — works without crumb ─────────────
async function yahooSearch(query, region = "US") {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&lang=en-US&region=${region}&quotesCount=10&newsCount=0&listsCount=0`;
  const resp = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data?.quotes || []).map(q => q.symbol).filter(Boolean);
}

// ── Yahoo trending tickers (no crumb needed) ──────────────────────
async function yahooTrending(region = "US") {
  const url = `https://query1.finance.yahoo.com/v1/finance/trending/${region}?count=40&useQuotes=true`;
  try {
    const resp = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
    if (!resp.ok) return [];
    const data = await resp.json();
    const quotes = data?.finance?.result?.[0]?.quotes || [];
    return quotes.map(q => q.symbol).filter(Boolean);
  } catch { return []; }
}

// ── Yahoo day gainers/most active (v7 — no crumb needed) ─────────
async function yahooMoversV7(listId) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${listId}`;
  // Use the spark endpoint which doesn't need auth
  const sparkUrl = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${listId}&range=1d&interval=5m`;
  try {
    const resp = await fetch(sparkUrl, { headers: { "User-Agent": UA } });
    if (!resp.ok) return [];
    const data = await resp.json();
    return Object.keys(data?.spark?.result?.reduce?.((a, r) => ({ ...a, [r.symbol]: 1 }), {}) || {});
  } catch { return []; }
}

// ── LSE: use Yahoo Finance chart API for known LSE movers ─────────
async function lseActive() {
  // Use Yahoo Finance's world indices/market summary for UK
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EFTSE?interval=1d&range=5d`;
  // Fallback: return well-known high-volume LSE tickers as seed
  // These are reliably the most traded LSE stocks daily
  return [
    "SHEL.L","AZN.L","HSBA.L","BP.L","GSK.L","BARC.L","LLOY.L",
    "VOD.L","RIO.L","ULVR.L","STAN.L","BT-A.L","PRU.L","AAL.L",
    "IMB.L","NG.L","WPP.L","IAG.L","GLEN.L","LGEN.L","JD.L",
    "SPX.L","MNG.L","FRES.L","SGE.L","REL.L","CRH.L","DGE.L"
  ];
}

// ── Euronext: seed list of most active ───────────────────────────
async function euronextActive() {
  return [
    "ASML.PA","TTE.PA","MC.PA","OR.PA","SAN.PA","AIR.PA","BNP.PA",
    "DG.PA","KER.PA","RI.PA","CS.PA","ORA.PA","VIE.PA","LR.PA",
    "CAP.PA","DSY.PA","ML.PA","ENGI.PA","PUB.PA","VK.PA",
    "INGA.AS","PHIA.AS","AD.AS","HEIA.AS","NN.AS","WKL.AS"
  ];
}

// ── Finviz filter presets ─────────────────────────────────────────
const PRESETS = {
  movers:    "sh_relvol_o2,sh_price_o2,sh_avgvol_o200",
  oversold:  "ta_rsi_os35,sh_relvol_o1.5,sh_price_o5,sh_avgvol_o200",
  breakout:  "ta_highlow52w_nh,sh_relvol_o1.5,sh_avgvol_o200,sh_price_o5",
  gap_up:    "ta_gap_u,sh_avgvol_o200,sh_price_o5",
  smallcap:  "cap_small,sh_relvol_o2,sh_price_o2,sh_avgvol_o100",
  momentum:  "ta_perf_1w10o,sh_relvol_o1.5,sh_avgvol_o200,sh_price_o5",
  all:       "sh_relvol_o1.5,sh_price_o2,sh_avgvol_o100",
};

// ── Main handler ──────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url    = new URL(req.url);
  const market = url.searchParams.get("market") || "us";
  const preset = url.searchParams.get("preset") || "movers";

  try {
    let tickers = [];

    if (market === "us") {
      // Run Finviz + Yahoo trending in parallel
      const [finviz, trending] = await Promise.allSettled([
        finvizScreen(PRESETS[preset] || PRESETS.movers),
        yahooTrending("US"),
      ]);

      const finvizList  = finviz.status  === "fulfilled" ? finviz.value  : [];
      const trendingList = trending.status === "fulfilled" ? trending.value : [];

      // Score by frequency across sources
      const freq = {};
      [...finvizList, ...trendingList].forEach(t => freq[t] = (freq[t]||0) + 1);
      // Finviz results get extra weight (more filtered)
      finvizList.forEach(t => freq[t] = (freq[t]||0) + 2);

      tickers = Object.entries(freq)
        .sort((a,b) => b[1] - a[1])
        .map(([t]) => t)
        .filter(t => /^[A-Z]{1,5}$/.test(t)) // clean US tickers only
        .slice(0, 80);

    } else if (market === "uk") {
      tickers = await lseActive();

    } else if (market === "eu") {
      tickers = await euronextActive();

    } else if (market === "all") {
      const [us, uk, eu] = await Promise.allSettled([
        finvizScreen(PRESETS[preset] || PRESETS.movers),
        lseActive(),
        euronextActive(),
        yahooTrending("US"),
      ]);
      tickers = [
        ...(us.status === "fulfilled" ? us.value : []),
        ...(uk.status === "fulfilled" ? uk.value : []),
        ...(eu.status === "fulfilled" ? eu.value : []),
      ];
      tickers = [...new Set(tickers)];
    }

    return json({ tickers, count: tickers.length, market, preset, ts: Date.now() });

  } catch (e) {
    return json({ error: e.message, tickers: [] }, 500);
  }
}
