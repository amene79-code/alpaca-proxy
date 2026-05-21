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

// ── Finviz fetch + parse ──────────────────────────────────────────
async function finviz(filters, maxResults = 30) {
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
  return [...tickers].slice(0, maxResults);
}

// ── Tiered screener by market cap ─────────────────────────────────
// Each tier has a different relative volume threshold.
// Smaller caps need higher relative volume to signal genuine unusual activity.
//
// cap_ values in Finviz:
//   mega     = >$200B
//   large    = $10B-$200B
//   mid      = $2B-$10B
//   small    = $300M-$2B
//   micro    = $50M-$300M
//   nano     = <$50M (excluded — too illiquid)
//
// sh_relvol_oX = relative volume > X times average

const TIERS = [
  {
    name: "Mega cap",
    cap: "cap_mega",
    relvol: "sh_relvol_o3",    // 3x+ for mega cap is meaningful
    minPrice: "sh_price_o5",
    weight: 1,
  },
  {
    name: "Large cap",
    cap: "cap_large",
    relvol: "sh_relvol_o4",    // 4x+ for large cap
    minPrice: "sh_price_o5",
    weight: 1.2,
  },
  {
    name: "Mid cap",
    cap: "cap_mid",
    relvol: "sh_relvol_o5",    // 5x+ for mid cap
    minPrice: "sh_price_o2",
    weight: 1.5,
  },
  {
    name: "Small cap",
    cap: "cap_small",
    relvol: "sh_relvol_o7",    // 7x+ for small cap
    minPrice: "sh_price_o1",
    weight: 2,                 // small cap spikes are rarer and more significant
  },
  {
    name: "Micro cap",
    cap: "cap_micro",
    relvol: "sh_relvol_o10",   // 10x+ for micro cap
    minPrice: "sh_price_o0.5",
    weight: 2.5,               // micro cap 10x is a genuine event
  },
];

// ── Additional quality filters per preset ─────────────────────────
const PRESET_EXTRA = {
  movers:    "",                                        // just volume spike
  oversold:  "ta_rsi_os35",                            // RSI oversold
  breakout:  "ta_highlow52w_nh",                       // near 52w high
  gap_up:    "ta_gap_u",                               // gap up today
  momentum:  "ta_perf_1w10o",                          // up 10%+ this week
  catalyst:  "sh_relvol_o3",                           // broad catalyst (overridden per tier)
  all:       "",                                        // no extra filter
};

// ── Yahoo Finance trending (no auth needed) ───────────────────────
async function yahooTrending() {
  const url = "https://query1.finance.yahoo.com/v1/finance/trending/US?count=40&useQuotes=true";
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) return [];
    const d = await r.json();
    return (d?.finance?.result?.[0]?.quotes || []).map(q => q.symbol).filter(s => /^[A-Z]{1,5}$/.test(s));
  } catch { return []; }
}

// ── UK seed list ──────────────────────────────────────────────────
function ukList() {
  return ["SHEL.L","AZN.L","HSBA.L","BP.L","GSK.L","BARC.L","LLOY.L",
          "VOD.L","RIO.L","ULVR.L","STAN.L","BT-A.L","PRU.L","AAL.L",
          "IMB.L","NG.L","WPP.L","IAG.L","GLEN.L","LGEN.L","JD.L",
          "SPX.L","MNG.L","FRES.L","SGE.L","REL.L","DGE.L"];
}

// ── EU seed list ──────────────────────────────────────────────────
function euList() {
  return ["ASML.PA","TTE.PA","MC.PA","OR.PA","SAN.PA","AIR.PA","BNP.PA",
          "DG.PA","KER.PA","RI.PA","CS.PA","ORA.PA","LR.PA","DSY.PA",
          "ENGI.PA","PUB.PA","INGA.AS","PHIA.AS","AD.AS","HEIA.AS","NN.AS"];
}

// ── Main handler ──────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url    = new URL(req.url);
  const market = url.searchParams.get("market") || "us";
  const preset = url.searchParams.get("preset") || "movers";

  try {
    if (market === "uk")  return json({ tickers: ukList(),  count: ukList().length,  market, preset, weighted: false });
    if (market === "eu")  return json({ tickers: euList(),  count: euList().length,  market, preset, weighted: false });

    if (market !== "us" && market !== "all") {
      return json({ tickers: [], count: 0, error: "Unknown market" });
    }

    const extra = PRESET_EXTRA[preset] || "";

    // Run all tiers in parallel
    const tierResults = await Promise.allSettled(
      TIERS.map(async tier => {
        const filters = [tier.cap, tier.relvol, tier.minPrice, extra]
          .filter(Boolean).join(",");
        const tickers = await finviz(filters, 25);
        return { tier, tickers };
      })
    );

    // Also fetch Yahoo trending in parallel
    const trendingResult = await yahooTrending();

    // Score system:
    // Base score = tier.weight (higher for smaller cap — rarer event)
    // Bonus = +1 if appears in multiple tier results (unlikely but possible)
    // Bonus = +0.5 if in Yahoo trending
    const scores = {};
    const tierMap = {}; // ticker → tier name for logging

    for (const result of tierResults) {
      if (result.status !== "fulfilled") continue;
      const { tier, tickers } = result.value;
      for (const t of tickers) {
        scores[t] = (scores[t] || 0) + tier.weight;
        tierMap[t] = tier.name;
      }
    }

    // Yahoo trending bonus
    for (const t of trendingResult) {
      if (/^[A-Z]{1,5}$/.test(t)) {
        scores[t] = (scores[t] || 0) + 0.5;
      }
    }

    // Sort by score descending
    const ranked = Object.entries(scores)
      .sort((a, b) => b[1] - a[1])
      .map(([ticker, score]) => ({ ticker, score: Math.round(score * 10) / 10, tier: tierMap[ticker] || "trending" }));

    const tickers = ranked.map(r => r.ticker);

    // For "all" market, append UK and EU
    const finalTickers = market === "all"
      ? [...new Set([...tickers, ...ukList(), ...euList()])]
      : tickers;

    return json({
      tickers: finalTickers.slice(0, 100),
      count: finalTickers.length,
      market,
      preset,
      weighted: true,
      breakdown: ranked.slice(0, 20), // top 20 with scores for debugging
      ts: Date.now(),
    });

  } catch (e) {
    return json({ error: e.message, tickers: [], weighted: false }, 500);
  }
}
