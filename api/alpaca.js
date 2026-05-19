export default async function handler(req, res) {
  // Allow requests from anywhere (your Claude app)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-alpaca-key, x-alpaca-secret, x-alpaca-mode");

  if (req.method === "OPTIONS") return res.status(200).end();

  const key    = req.headers["x-alpaca-key"];
  const secret = req.headers["x-alpaca-secret"];
  const mode   = req.headers["x-alpaca-mode"] || "paper";
  const path   = req.query.path || "/v2/account";

  if (!key || !secret) {
    return res.status(400).json({ error: "Missing API credentials" });
  }

  const base = mode === "live"
    ? "https://api.alpaca.markets"
    : "https://paper-api.alpaca.markets";

  try {
    const opts = {
      method: req.method,
      headers: {
        "APCA-API-KEY-ID":     key,
        "APCA-API-SECRET-KEY": secret,
        "Content-Type":        "application/json",
      },
    };

    if (req.method === "POST" && req.body) {
      opts.body = JSON.stringify(req.body);
    }

    const upstream = await fetch(base + path, opts);
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
