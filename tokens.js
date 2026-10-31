// /api/tokens
//
// The directory behind the Stock tokens page: every official Robinhood stock token with its price,
// multiplier and supply, plus the current market session. All of it comes from the Quicknode Stock Token
// API add-on (qn_getStockTokens and qn_getOracleHealth), cached in memory here and at the edge.
const { RPC_URL, getTokens, getOracle } = require("../lib/stock.js");

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!RPC_URL) {
    res.status(200).json({ demo: true, reason: "QN_RH_RPC_URL not set" });
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const [tokens, oracle] = await Promise.all([getTokens(controller.signal), getOracle(controller.signal)]);
    clearTimeout(timeout);
    const rows = tokens.tokens.map((t) => {
      const p = oracle.prices.get(t.address.toLowerCase());
      return {
        symbol: t.symbol,
        name: t.name,
        address: t.address,
        multiplier: t.multiplier,
        supplyShares: t.supplyShares,
        priceUsd: p && p.usable ? p.price : null,
        priceStatus: p ? p.status : (t.priceFeed ? "UNKNOWN" : "NOT_CONFIGURED"),
        priceAgeSeconds: p ? p.ageSeconds : null,
        paused: !!t.oraclePaused,
        pending: t.pending ? { multiplier: Number(t.pending.uiMultiplierDecimal) || null, effectiveAt: t.pending.effectiveAtIso || null } : null,
      };
    });
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
    res.status(200).json({
      demo: false,
      data: {
        tokens: rows,
        session: oracle.session,
        operator: oracle.operator ? oracle.operator.status || null : null,
        stockApi: tokens.stockApi,
      },
    });
  } catch (err) {
    clearTimeout(timeout);
    res.status(502).json({ error: "Upstream request failed", detail: String(err && err.message ? err.message : err) });
  }
};

module.exports.config = { maxDuration: 15 };
