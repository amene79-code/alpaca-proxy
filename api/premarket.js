export const config = { runtime: "edge" };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-finnhub-key",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ── Finnhub earnings calendar ─────────────────────────────────────
async function finnhubEarnings(apiKey, from, to) {
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${apiKey}`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`Finnhub earnings ${r.status}`);
  const d = await r.json();
  return (d.earningsCalendar || []).map(e => ({
    ticker:   e.symbol,
    date:     e.date,
    epsEst:   e.epsEstimate,
    epsAct:   e.epsActual,
    revEst:   e.revenueEstimate,
    revAct:   e.revenueActual,
    hour:     e.hour, // bmo = before market open, amc = after market close
    surprise: e.epsEstimate && e.epsActual
      ? +((e.epsActual - e.epsEstimate) / Math.abs(e.epsEstimate) * 100).toFixed(1)
      : null,
  }));
}

// ── Finnhub market news ───────────────────────────────────────────
async function finnhubNews(apiKey) {
  const url = `https://finnhub.io/api/v1/news?category=general&minId=0&token=${apiKey}`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) return [];
  const items = await r.json();
  return (items || []).slice(0, 20).map(n => ({
    headline: n.headline,
    summary:  n.summary?.slice(0, 200),
    url:      n.url,
    source:   n.source,
    datetime: n.datetime,
    related:  n.related, // ticker string e.g. "AAPL,MSFT"
  }));
}

// ── Finnhub insider transactions (unusual buying = bullish signal) ─
async function finnhubInsiders(apiKey) {
  const url = `https://finnhub.io/api/v1/stock/insider-transactions?symbol=&token=${apiKey}`;
  // Use market-wide insider endpoint to find recent buy signals
  const from = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const url2 = `https://finnhub.io/api/v1/stock/insider-transactions?from=${from}&token=${apiKey}`;
  try {
    const r = await fetch(url2, { headers: { "User-Agent": UA } });
    if (!r.ok) return [];
    const d = await r.json();
    // Filter for buys only
    return (d.data || [])
      .filter(t => t.transactionType === "P" || t.transactionType === "Buy")
      .slice(0, 10)
      .map(t => ({ ticker: t.symbol, name: t.name, shares: t.share, value: t.value, date: t.date }));
  } catch { return []; }
}

// ── Apewisdom — WSB/Reddit mention tracker (no auth needed) ──────
async function redditWSB() {
  try {
    // Apewisdom aggregates Reddit WSB, stocks, investing mentions
    const urls = [
      "https://apewisdom.io/api/v1.0/filter/wallstreetbets/page/1",
      "https://apewisdom.io/api/v1.0/filter/all-stocks/page/1",
    ];

    const blacklist = new Set([
      "THE","AND","FOR","ARE","BUT","NOT","YOU","ALL","CAN","WAS","ONE","OUR",
      "OUT","NOW","GOT","GET","PUT","CEO","IPO","SEC","FDA","EPS","ETF","NYSE",
      "WSB","DD","YOLO","IMO","LOL","OMG","GDP","ATH","ATL","USD","BTC","ETH",
      "EDIT","TLDR","DRS","SPY","QQQ","IWM","VIX","CALLS","PUTS","ITM","OTM",
      "AI","ML","US","UK","EU","AP","PM","AM","OP","RE","HOLD","BUY","SELL",
    ]);

    const mentions = {};
    let source = "Apewisdom";

    for (const url of urls) {
      try {
        const r = await fetch(url, {
          headers: { "User-Agent": UA, "Accept": "application/json" },
        });
        if (!r.ok) continue;
        const d = await r.json();
        const results = d?.results || [];
        for (const item of results) {
          const t = (item.ticker || "").toUpperCase();
          if (!t || blacklist.has(t) || t.length < 2 || t.length > 5) continue;
          const score = (item.mentions || 1) / 10 + (item.mentions_24h_ago ? (item.mentions - item.mentions_24h_ago) / 20 : 0);
          mentions[t] = (mentions[t] || 0) + Math.max(0.5, score);
        }
        if (results.length) break; // got data, stop trying
      } catch { continue; }
    }

    if (Object.keys(mentions).length) {
      const tickers = Object.entries(mentions)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([ticker, score]) => ({ ticker, score: Math.round(score * 10) / 10 }));
      return { tickers, posts: [], source: "Apewisdom (WSB)" };
    }

    // Final fallback: Yahoo trending, but label it clearly
    try {
      const r = await fetch("https://query1.finance.yahoo.com/v1/finance/trending/US?count=20", {
        headers: { "User-Agent": UA },
      });
      if (r.ok) {
        const d = await r.json();
        const quotes = d?.finance?.result?.[0]?.quotes || [];
        const tickers = quotes
          .map(q => ({ ticker: q.symbol, score: 1.0 }))
          .filter(t => /^[A-Z]{1,5}$/.test(t.ticker))
          .slice(0, 15);
        return { tickers, posts: [], source: "Yahoo Trending (Reddit unavailable)" };
      }
    } catch {}

    return { tickers: [], posts: [], source: "Unavailable" };
  } catch {
    return { tickers: [], posts: [], source: "Unavailable" };
  }
}


// ── Stocktwits trending ───────────────────────────────────────────
async function stocktwitsTrending() {
  try {
    const r = await fetch("https://api.stocktwits.com/api/2/trending/symbols/equities.json", {
      headers: { "User-Agent": UA },
    });
    if (!r.ok) return [];
    const d = await r.json();
    return (d?.symbols || [])
      .map(s => ({ ticker: s.symbol, watchlist: s.watchlist_count, title: s.title }))
      .filter(s => /^[A-Z]{1,5}$/.test(s.ticker))
      .slice(0, 20);
  } catch { return []; }
}

// ── Pre-market movers via Yahoo Finance ──────────────────────────
async function finvizPremarket() {
  const tickers = new Set();

  // Yahoo Finance pre-market gainers
  const sources = [
    "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=25&fields=symbol,preMarketChangePercent,preMarketVolume",
    "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=most_actives&count=25&fields=symbol,preMarketChangePercent",
    "https://query1.finance.yahoo.com/v1/finance/trending/US?count=30&useQuotes=true",
  ];

  for (const url of sources) {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, "Accept": "application/json" },
      });
      if (!r.ok) continue;
      const d = await r.json();
      // Handle trending endpoint
      const quotes = d?.finance?.result?.[0]?.quotes || [];
      quotes.forEach(q => {
        if (q.symbol && /^[A-Z]{1,5}$/.test(q.symbol)) tickers.add(q.symbol);
      });
    } catch { continue; }
  }

  // Also try Yahoo's spark endpoint for pre-market movers
  try {
    const preMarketSymbols = ["SPY","QQQ","AAPL","MSFT","NVDA","TSLA","AMD","META","AMZN","GOOGL"];
    const sparkUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${preMarketSymbols.join(",")}&fields=symbol,preMarketPrice,preMarketChangePercent,preMarketVolume`;
    const r = await fetch(sparkUrl, { headers: { "User-Agent": UA } });
    if (r.ok) {
      const d = await r.json();
      const quotes = d?.quoteResponse?.result || [];
      // Add stocks with significant pre-market moves (>1%)
      quotes
        .filter(q => Math.abs(q.preMarketChangePercent || 0) > 1)
        .forEach(q => tickers.add(q.symbol));
    }
  } catch {}

  return [...tickers].slice(0, 30);
}

// ── Pre-market volume spike via Finnhub candles ───────────────────
// Compares today's pre-market volume to 20-day average pre-market volume
// Returns scored list: {ticker, pmVolume, avgPmVolume, spike, score}
async function premarketVolumeSpikes(apiKey, tickers) {
  if (!apiKey || !tickers.length) return [];

  const now     = Math.floor(Date.now() / 1000);
  const today4am = (() => {
    const d = new Date();
    d.setHours(4, 0, 0, 0); // 4am local — approximate pre-market start
    return Math.floor(d.getTime() / 1000);
  })();
  // 20 trading days ago for historical average
  const hist = now - 20 * 86400;

  // Process up to 10 tickers (Finnhub free = 60 calls/min)
  const topTickers = tickers.slice(0, 10);
  const results = [];

  await Promise.allSettled(topTickers.map(async ticker => {
    try {
      // Today's pre-market candles (1-min resolution, 4am–9:30am ET)
      const todayUrl = `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=60&from=${today4am}&to=${now}&token=${apiKey}`;
      const r1 = await fetch(todayUrl, { headers: { "User-Agent": UA } });
      if (!r1.ok) return;
      const d1 = await r1.json();
      if (d1.s !== "ok" || !d1.v?.length) return;
      const pmVolToday = d1.v.reduce((s, v) => s + v, 0);

      // Historical daily candles for average volume baseline
      const histUrl = `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=D&from=${hist}&to=${now}&token=${apiKey}`;
      const r2 = await fetch(histUrl, { headers: { "User-Agent": UA } });
      if (!r2.ok) return;
      const d2 = await r2.json();
      if (d2.s !== "ok" || !d2.v?.length) return;

      // Average daily volume (rough proxy for expected pre-market volume)
      // Pre-market is typically ~5-15% of daily volume
      const avgDailyVol = d2.v.reduce((s, v) => s + v, 0) / d2.v.length;
      const expectedPmVol = avgDailyVol * 0.08; // ~8% of daily vol in pre-market

      if (expectedPmVol <= 0) return;
      const spike = pmVolToday / expectedPmVol;

      if (spike >= 1.5) { // only report meaningful spikes
        results.push({
          ticker,
          pmVolume:    Math.round(pmVolToday),
          avgPmVolume: Math.round(expectedPmVol),
          spike:       Math.round(spike * 10) / 10,
          // Score: higher weight for bigger spikes, capped at 5
          score: Math.min(5, spike >= 10 ? 5 : spike >= 5 ? 3.5 : spike >= 3 ? 2.5 : 1.5),
        });
      }
    } catch { /* skip ticker on error */ }
  }));

  return results.sort((a, b) => b.spike - a.spike);
}
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url      = new URL(req.url);
  const finnhubKey = req.headers.get("x-finnhub-key") || url.searchParams.get("fk") || "";
  const source   = url.searchParams.get("source") || "all";

  try {
    const today    = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

    const results = {};

    if (source === "all" || source === "earnings") {
      if (finnhubKey) {
        const [todayEarnings, upcomingEarnings] = await Promise.allSettled([
          finnhubEarnings(finnhubKey, today, tomorrow),
          finnhubEarnings(finnhubKey, today, nextWeek),
        ]);
        results.earningsToday    = todayEarnings.status    === "fulfilled" ? todayEarnings.value    : [];
        results.earningsUpcoming = upcomingEarnings.status === "fulfilled" ? upcomingEarnings.value : [];
      } else {
        results.earningsToday    = [];
        results.earningsUpcoming = [];
        results.earningsNote     = "Add Finnhub API key for earnings data";
      }
    }

    if (source === "all" || source === "news") {
      if (finnhubKey) {
        const [news, insiders] = await Promise.allSettled([
          finnhubNews(finnhubKey),
          finnhubInsiders(finnhubKey),
        ]);
        results.news     = news.status     === "fulfilled" ? news.value     : [];
        results.insiders = insiders.status === "fulfilled" ? insiders.value : [];
      } else {
        results.news = []; results.insiders = [];
      }
    }

    if (source === "all" || source === "social") {
      const [wsb, stwits, premarket] = await Promise.allSettled([
        redditWSB(),
        stocktwitsTrending(),
        finvizPremarket(),
      ]);
      results.reddit          = wsb.status      === "fulfilled" ? wsb.value      : { tickers: [], posts: [] };
      results.stocktwits      = stwits.status   === "fulfilled" ? stwits.value   : [];
      results.premarketMovers = premarket.status === "fulfilled" ? premarket.value : [];
    }

    // Pre-market volume spikes — run after we have ranked candidates
    // Get initial ranked list first, then check volume on top candidates
    const initialRanked = Object.entries(
      (() => {
        const s = {};
        const add = (t, pts) => { if (/^[A-Z]{1,5}$/.test(t)) { s[t] = s[t] || 0; s[t] += pts; } };
        (results.earningsToday || []).forEach(e => add(e.ticker, 5));
        (results.premarketMovers || []).forEach((t, i) => add(t, 3 - i * 0.1));
        (results.reddit?.tickers || []).forEach(t => add(t.ticker, t.score * 0.5));
        (results.stocktwits || []).forEach((t, i) => add(t.ticker, 1.5 - i * 0.05));
        return s;
      })()
    ).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t]) => t);

    // Fetch pre-market volume spikes for top 10 candidates
    if (finnhubKey && initialRanked.length) {
      const volSpikes = await premarketVolumeSpikes(finnhubKey, initialRanked);
      results.volumeSpikes = volSpikes;
    } else {
      results.volumeSpikes = [];
    }

    // Build combined ticker scores for quick ranking
    const scores = {};
    const addScore = (ticker, pts, src) => {
      if (!/^[A-Z]{1,5}$/.test(ticker)) return;
      scores[ticker] = scores[ticker] || { score: 0, sources: [] };
      scores[ticker].score += pts;
      if (!scores[ticker].sources.includes(src)) scores[ticker].sources.push(src);
    };

    // Earnings today = highest priority
    (results.earningsToday || []).forEach(e => addScore(e.ticker, 5, "Earnings Today"));
    (results.earningsUpcoming || []).slice(0, 10).forEach(e => addScore(e.ticker, 2, "Earnings Soon"));
    // Pre-market movers
    (results.premarketMovers || []).forEach((t, i) => addScore(t, 3 - i * 0.1, "Pre-market"));
    // Reddit WSB
    (results.reddit?.tickers || []).forEach(t => addScore(t.ticker, t.score * 0.5, "Reddit WSB"));
    // Stocktwits
    (results.stocktwits || []).forEach((t, i) => addScore(t.ticker, 1.5 - i * 0.05, "Stocktwits"));
    // News mentions
    (results.news || []).forEach(n => {
      if (n.related) n.related.split(",").forEach(t => addScore(t.trim(), 0.5, "News"));
    });
    // Insider buys
    (results.insiders || []).forEach(t => addScore(t.ticker, 1, "Insider Buy"));
    // Pre-market volume spikes — highest scoring addition
    (results.volumeSpikes || []).forEach(v => {
      addScore(v.ticker, v.score, `PM Vol ${v.spike}x`);
    });

    results.rankedTickers = Object.entries(scores)
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 30)
      .map(([ticker, data]) => ({ ticker, score: Math.round(data.score * 10) / 10, sources: data.sources }));

    return json(results);

  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
