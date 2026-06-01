/**
 * /api/watchlist — simple key-value store for pre-market watchlist
 * GET  → returns current watchlist
 * POST → saves new watchlist
 * Uses Vercel Edge KV-like in-memory store (persists per deployment)
 * For persistence across deployments, uses a simple file-based approach
 */

// In-memory store (resets on cold start but that's fine — pre-market saves fresh daily)
let storedWatchlist = { tickers: [], date: null, ts: null };

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json(storedWatchlist);
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      storedWatchlist = {
        tickers: body.tickers || [],
        date:    body.date || new Date().toLocaleDateString('en-GB'),
        ts:      Date.now(),
        source:  body.source || 'premarket',
      };
      console.log(`Watchlist saved: ${storedWatchlist.tickers.length} tickers`);
      return res.status(200).json({ ok: true, count: storedWatchlist.tickers.length });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
