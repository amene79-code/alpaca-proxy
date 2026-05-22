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

// ── Reddit WSB — multiple fallback strategies ─────────────────────
async function redditWSB() {
  const blacklist = new Set([
    "THE","AND","FOR","ARE","BUT","NOT","YOU","ALL","CAN","WAS","ONE","OUR",
    "OUT","NOW","GOT","GET","PUT","CEO","IPO","SEC","FDA","EPS","ETF","NYSE",
    "WSB","DD","YOLO","IMO","LOL","OMG","GDP","ATH","ATL","USD","BTC","ETH",
    "EDIT","TLDR","DRS","SPY","QQQ","IWM","VIX","CALLS","PUTS","ITM","OTM",
    "ATM","DTE","IV","EV","AI","ML","US","UK","EU","AP","PM","AM","OP","RE",
    "HOLD","BUY","SELL","LONG","SHORT","THIS","THAT","WITH","FROM","HAVE",
    "BEEN","WILL","YOUR","THEY","WHEN","WHAT","SOME","MORE","ALSO","INTO",
  ]);

  function extractTickers(text, mentions) {
    const re = /\$([A-Z]{1,5})|(?<![A-Za-z])([A-Z]{2,5})(?![A-Za-z])/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const t = (m[1] || m[2]).toUpperCase();
      if (!t || blacklist.has(t) || t.length < 2 || t.length > 5) continue;
      mentions[t] = (mentions[t] || 0) + (m[1] ? 3 : 1);
    }
  }

  const mentions = {};
  let debugInfo = [];

  // Strategy 1: Reddit RSS
  try {
    const r = await fetch("https://www.reddit.com/r/wallstreetbets/hot/.rss?limit=50", {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/xml, application/xml, */*" },
    });
    debugInfo.push(`RSS: ${r.status}`);
    if (r.ok) {
      const xml = await r.text();
      const re = /<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/g;
      let m; let count = 0;
      while ((m = re.exec(xml)) !== null) {
        const t = (m[1] || m[2] || "").trim();
        if (t && !t.toLowerCase().includes("wallstreetbets")) { extractTickers(t, mentions); count++; }
      }
      debugInfo.push(`RSS titles: ${count}`);
    }
  } catch(e) { debugInfo.push(`RSS error: ${e.message}`); }

  // Strategy 2: Reddit JSON with different headers
  try {
    const r = await fetch("https://www.reddit.com/r/wallstreetbets/hot.json?limit=25", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
      },
    });
    debugInfo.push(`JSON: ${r.status}`);
    if (r.ok) {
      const d = await r.json();
      const posts = d?.data?.children || [];
      posts.forEach(p => extractTickers(p.data.title || "", mentions));
      debugInfo.push(`JSON posts: ${posts.length}`);
    }
  } catch(e) { debugInfo.push(`JSON error: ${e.message}`); }

  // Strategy 3: Yahoo Finance trending as Reddit fallback
  // If Reddit is blocked, use Yahoo trending tickers as social proxy
  try {
    const r = await fetch("https://query1.finance.yahoo.com/v1/finance/trending/US?count=20", {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (r.ok) {
      const d = await r.json();
      const quotes = d?.finance?.result?.[0]?.quotes || [];
      quotes.forEach(q => {
        if (q.symbol && /^[A-Z]{1,5}$/.test(q.symbol)) {
          mentions[q.symbol] = (mentions[q.symbol] || 0) + 1.5;
        }
      });
      debugInfo.push(`Yahoo trending: ${quotes.length}`);
    }
  } catch(e) { debugInfo.push(`Yahoo error: ${e.message}`); }

  const tickers = Object.entries(mentions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([ticker, score]) => ({ ticker, score: Math.round(score * 10) / 10 }));

  return { tickers, posts: [], debug: debugInfo.join(" | ") };
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

// ── Finviz pre-market movers ──────────────────────────────────────
async function finvizPremarket() {
  // sh_curvol_o10 = current pre-market volume > 10k
  const url = "https://finviz.com/screener.ashx?v=111&f=sh_curvol_o10,sh_price_o1&ft=4&o=-relativevolume";
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "text/html", "Referer": "https://finviz.com/" },
    });
    if (!r.ok) return [];
    const html = await r.text();
    const tickers = new Set();
    const re = /quote\.ashx\?t=([A-Z]{1,5})[&"]/g;
    let m;
    while ((m = re.exec(html)) !== null) tickers.add(m[1]);
    return [...tickers].slice(0, 30);
  } catch { return []; }
}

// ── Main handler ──────────────────────────────────────────────────
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
      results.reddit      = wsb.status      === "fulfilled" ? wsb.value      : { tickers: [], posts: [] };
      results.stocktwits  = stwits.status   === "fulfilled" ? stwits.value   : [];
      results.premarketMovers = premarket.status === "fulfilled" ? premarket.value : [];
    }

    // Build combined ticker scores for quick ranking
    const scores = {};
    const addScore = (ticker, pts, source) => {
      if (!/^[A-Z]{1,5}$/.test(ticker)) return;
      scores[ticker] = scores[ticker] || { score: 0, sources: [] };
      scores[ticker].score += pts;
      if (!scores[ticker].sources.includes(source)) scores[ticker].sources.push(source);
    };

    // Earnings today = highest priority
    (results.earningsToday || []).forEach(e => addScore(e.ticker, 5, "Earnings Today"));
    (results.earningsUpcoming || []).slice(0, 10).forEach(e => addScore(e.ticker, 2, "Earnings Soon"));
    // Pre-market movers = strong signal
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

    results.rankedTickers = Object.entries(scores)
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 30)
      .map(([ticker, data]) => ({ ticker, score: Math.round(data.score * 10) / 10, sources: data.sources }));

    return json(results);

  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
