// Shared helpers for the Quicknode Robinhood Chain endpoint and its Stock Token API add-on.
//
// The add-on adds JSON-RPC methods that list every official stock token (with its split and
// dividend multiplier) and report Chainlink prices and market-session state:
//   qn_getStockTokens   the token list, refreshed here every 10 minutes
//   qn_getOracleHealth  prices, market session and the mint window, refreshed here every minute
// If the add-on is unavailable the site falls back to the two tokens it started with.

const RPC_URL = process.env.QN_RH_RPC_URL;
const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const FALLBACK = [
  { symbol: "AAPL", name: "Apple", address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" },
  { symbol: "NVDA", name: "Nvidia", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" },
];

const TOKEN_TTL = 10 * 60 * 1000;
const ORACLE_TTL = 60 * 1000;
const RETRY_AFTER = 60 * 1000; // after a failure, try again in a minute

async function rpc(method, params, signal) {
  const r = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal,
  });
  const json = await r.json();
  if (json.error) {
    const e = new Error(method + ": " + JSON.stringify(json.error));
    e.rpc = json.error;
    throw e;
  }
  return json.result;
}

function cleanName(name, symbol) {
  if (!name) return symbol;
  return String(name).replace(/\s*[\u2022\-|]\s*Robinhood Token\s*$/i, "").trim() || symbol;
}

/* ---------------- token list ---------------- */
let tokenCache = null;

function shapeTokens(tokens, stockApi) {
  const byAddr = new Map();
  tokens.forEach((t) => byAddr.set(t.address.toLowerCase(), t));
  return { tokens, byAddr, stockApi };
}

async function getTokens(signal) {
  const now = Date.now();
  if (tokenCache && now - tokenCache.at < TOKEN_TTL) return tokenCache;
  try {
    const res = await rpc("qn_getStockTokens", [{}], signal);
    const list = (res && res.tokens ? res.tokens : []).filter((t) => !t.status || t.status === "ACTIVE");
    if (!list.length) throw new Error("qn_getStockTokens returned no active tokens");
    const tokens = list.map((t) => ({
      symbol: t.symbol,
      name: cleanName(t.name, t.symbol),
      address: t.address,
      multiplier: Number(t.uiMultiplierDecimal) || 1,
      supplyShares: Number(t.totalSupplyUiDecimal) || 0,
      priceFeed: t.priceFeed || null,
      oraclePaused: !!t.oraclePaused,
      pending: t.pending || null,
    }));
    tokenCache = { ...shapeTokens(tokens, true), at: now, error: null };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (tokenCache) {
      // keep the last good list and try again soon
      tokenCache = { ...tokenCache, at: now - TOKEN_TTL + RETRY_AFTER, error: msg };
    } else {
      const tokens = FALLBACK.map((t) => ({
        ...t, multiplier: 1, supplyShares: 0, priceFeed: null, oraclePaused: false, pending: null,
      }));
      tokenCache = { ...shapeTokens(tokens, false), at: now - TOKEN_TTL + RETRY_AFTER, error: msg };
    }
  }
  return tokenCache;
}

/* ---------------- prices and market session ---------------- */
let oracleCache = null;

const USABLE_STATUS = { OK: true, MARKET_CLOSED: true }; // a closed-market price is the last real price

function emptyOracle(error) {
  return { prices: new Map(), session: null, operator: null, at: Date.now(), error: error || null };
}

async function getOracle(signal) {
  const now = Date.now();
  if (oracleCache && now - oracleCache.at < ORACLE_TTL) return oracleCache;
  try {
    const res = await rpc("qn_getOracleHealth", [{}], signal);
    const prices = new Map();
    (res.feeds || []).forEach((f) => {
      if (!f || !f.token || f.answer == null) return;
      const decimals = Number(f.decimals);
      const price = Number(f.answer) / Math.pow(10, Number.isFinite(decimals) ? decimals : 8);
      prices.set(String(f.token).toLowerCase(), {
        price: Number.isFinite(price) ? price : null,
        status: f.status || "UNKNOWN",
        ageSeconds: f.ageSeconds != null ? Number(f.ageSeconds) : null,
        usable: Number.isFinite(price) && !!USABLE_STATUS[f.status],
      });
    });
    const s = res.session || res.marketSession || null;
    const session = s ? {
      name: s.name || s.session || null,
      mintWindowOpen: s.mintWindowOpen != null ? !!s.mintWindowOpen : (s.mintWindow ? !!s.mintWindow.open : null),
      nextChangeAt: s.nextChangeAt || s.nextTransitionAt || null,
    } : null;
    const operator = res.sequencer && res.sequencer.operatorStatus ? res.sequencer.operatorStatus
      : (res.operatorStatus || null);
    oracleCache = { prices, session, operator, at: now, error: null };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    oracleCache = oracleCache
      ? { ...oracleCache, at: now - ORACLE_TTL + RETRY_AFTER, error: msg }
      : { ...emptyOracle(msg), at: now - ORACLE_TTL + RETRY_AFTER };
  }
  return oracleCache;
}

/* ---------------- logs: split the query if the provider refuses it, and remember what worked ---------------- */
const hex = (n) => "0x" + n.toString(16);

// What this endpoint has been seen to accept. Learned from refusals, then reused so a refused query
// is not repeated on every refresh. Resets when the function instance restarts.
const learned = { addr: Infinity, span: Infinity, topicOnlyFailed: false };

async function getLogs(addresses, from, to, signal, depth) {
  depth = depth || 0;
  try {
    const filter = { topics: [TRANSFER_TOPIC0], fromBlock: hex(from), toBlock: hex(to) };
    if (addresses) filter.address = addresses;
    return await rpc("eth_getLogs", [filter], signal);
  } catch (e) {
    if ((e && e.name === "AbortError") || depth >= 5) throw e;
    const aboutAddresses = /address/i.test(String(e && e.message));
    const canSplitAddresses = !!addresses && addresses.length > 20;
    const canSplitBlocks = to - from >= 200n;
    if (canSplitAddresses && (aboutAddresses || !canSplitBlocks)) {
      const h = Math.ceil(addresses.length / 2);
      learned.addr = Math.min(learned.addr, h);
      const [a, b] = await Promise.all([
        getLogs(addresses.slice(0, h), from, to, signal, depth + 1),
        getLogs(addresses.slice(h), from, to, signal, depth + 1),
      ]);
      return a.concat(b);
    }
    if (canSplitBlocks) {
      const mid = from + (to - from) / 2n;
      learned.span = Math.min(learned.span, Number((to - from) / 2n));
      const [a, b] = await Promise.all([
        getLogs(addresses, from, mid, signal, depth + 1),
        getLogs(addresses, mid + 1n, to, signal, depth + 1),
      ]);
      return a.concat(b);
    }
    throw e;
  }
}

// Reads Transfer logs for every token between two blocks, using the chunk sizes learned so far.
// Too many chunks would cost too many calls, so past eight the query drops the address filter and the
// caller keeps only the stock tokens it knows. If that is refused, it goes back to chunks for good.
async function getLogsAll(addresses, from, to, signal) {
  const chunks = [];
  const size = Number.isFinite(learned.addr) ? Math.max(1, learned.addr) : addresses.length;
  for (let i = 0; i < addresses.length; i += size) chunks.push(addresses.slice(i, i + size));
  const spans = [];
  const span = Number.isFinite(learned.span) ? BigInt(Math.max(1, learned.span)) : to - from + 1n;
  for (let f = from; f <= to; f += span) spans.push([f, f + span - 1n < to ? f + span - 1n : to]);

  if (chunks.length > 8 && !learned.topicOnlyFailed) {
    try {
      const parts = await Promise.all(spans.map(([f, t]) => getLogs(null, f, t, signal)));
      return [].concat(...parts);
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      learned.topicOnlyFailed = true;
    }
  }
  const jobs = [];
  chunks.forEach((c) => spans.forEach(([f, t]) => jobs.push(getLogs(c, f, t, signal))));
  return [].concat(...(await Promise.all(jobs)));
}

module.exports = { RPC_URL, rpc, getTokens, getOracle, getLogsAll, FALLBACK, TRANSFER_TOPIC0 };
