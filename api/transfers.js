// /api/transfers.js
//
// Watches ERC-20 Transfer events for tokenized stocks on Robinhood Chain
// (chain ID 4663, an Arbitrum Orbit L2, ~100ms blocks) through Quicknode's
// RPC endpoint.
//
// Why this is a plain JSON-RPC poll and not a persistent relay like
// HyperPulse's gRPC setup: Robinhood Chain is a standard EVM chain.
// eth_getLogs over a recent block range is a normal stateless request.
// There's no equivalent of Hyperliquid's gRPC-only data here, so there's
// no need for an always-on server holding a connection open. Vercel
// serverless is the right fit for this one.
//
// Why only 2 tickers for now: Robinhood Chain has 400+ tokenized stocks,
// all deployed through one StockFactory contract. Discovering all of them
// by scanning the factory's full event history isn't practical through a
// standard RPC endpoint. This chain produces blocks every ~100ms, so it's
// already done roughly 80 MILLION blocks since launch (~3 months old),
// and eth_getLogs is capped to a few thousand blocks per call on most
// providers. Full-history scanning would take thousands of paginated
// calls just to build the token list.
//
// AAPL and NVDA below are the two addresses Quicknode's own official
// guide publishes, so they're trustworthy. Add more by confirming an
// address on robinhoodchain.blockscout.com (search the ticker, copy the
// contract address) rather than from a random blog post. A wrong address
// here fails SILENTLY (just shows zero transfers), the same trap we hit
// more than once building HyperPulse.
const WATCHLIST = [
  { symbol: "AAPL", name: "Apple", address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" },
  { symbol: "NVDA", name: "Nvidia", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" },
];

const RPC_URL = process.env.QN_RH_RPC_URL; // your Quicknode Robinhood Chain endpoint
const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// How far back to look each poll. ~100ms blocks, so 3000 blocks is
// roughly 5 minutes of history. Small enough to stay well under any
// provider's getLogs range cap, wide enough not to miss activity between
// polls.
const BLOCK_WINDOW = 3000n;        // the five-minute view, used on page load and after a gap
const LIVE_BLOCK_WINDOW = 300n;    // the live view, about 30 seconds, polled every few seconds

module.exports = async function handler(req, res) {
  // GET and POST both work. The site uses GET so Vercel's CDN can cache the
  // answer and share it between visitors (see the Cache-Control line below).
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!RPC_URL) {
    res.status(200).json({ demo: true, reason: "QN_RH_RPC_URL not set" });
    return;
  }

  // Only two window sizes are allowed, so every visitor shares the same two cached answers.
  let live = false;
  try { live = new URL(req.url, "http://localhost").searchParams.get("w") === "live"; } catch (e) {}
  const windowBlocks = live ? LIVE_BLOCK_WINDOW : BLOCK_WINDOW;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);

    const rpcCall = async (method, params) => {
      const r = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      const json = await r.json();
      if (json.error) throw new Error(method + ": " + JSON.stringify(json.error));
      return json.result;
    };

    // Logs don't carry a timestamp, only a block number. Rather than call
    // eth_getBlockByNumber once per unique block (expensive), fetch just
    // the latest block's timestamp and approximate each transfer's time
    // using the chain's near-constant ~100ms block interval. Good enough
    // for a relative "Xs ago" display, not meant to be exact.
    const latestBlockObj = await rpcCall("eth_getBlockByNumber", ["latest", false]);
    const latestHex = latestBlockObj.number;
    const latest = BigInt(latestHex);
    const latestTimestampMs = Number(BigInt(latestBlockObj.timestamp)) * 1000;
    const fromBlock = latest - windowBlocks > 0n ? latest - windowBlocks : 0n;

    const logs = await rpcCall("eth_getLogs", [{
      address: WATCHLIST.map((w) => w.address),
      topics: [TRANSFER_TOPIC0],
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: latestHex,
    }]);

    clearTimeout(timeout);

    const byAddress = {};
    WATCHLIST.forEach((w) => { byAddress[w.address.toLowerCase()] = w; });

    const transfers = (logs || []).map((log) => {
      const token = byAddress[log.address.toLowerCase()] || {};
      // Transfer(address indexed from, address indexed to, uint256 value)
      // topics[1] / topics[2] are 32-byte padded addresses; data is the raw value.
      const from = "0x" + log.topics[1].slice(26);
      const to = "0x" + log.topics[2].slice(26);
      const rawValue = BigInt(log.data);
      const amount = Number(rawValue) / 1e18; // 18 decimals, standard ERC-20
      const blockNumber = BigInt(log.blockNumber);
      const approxTimeMs = latestTimestampMs - Number(latest - blockNumber) * 100; // ~100ms/block
      return {
        symbol: token.symbol || "?",
        name: token.name || "",
        from,
        to,
        amount,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        blockNumber: Number(blockNumber),
        time: new Date(approxTimeMs).toISOString(),
      };
    });

    // Cache for 15 seconds at the edge. However many people have the site open,
    // Quicknode is asked at most a few times a minute, which protects the monthly credits.
    // Live view: cached for 3 seconds. Five-minute view: cached for 15 seconds.
    // However many people have the site open, Quicknode is asked a few times a minute at most,
    // which protects the monthly credits.
    res.setHeader("Cache-Control", live ? "public, s-maxage=3" : "public, s-maxage=15, stale-while-revalidate=30");
    res.status(200).json({
      demo: false,
      data: { transfers, latestBlock: latest.toString(), latestTime: new Date(latestTimestampMs).toISOString() },
    });
  } catch (err) {
    res.status(502).json({ error: "Upstream request failed", detail: String(err && err.message ? err.message : err) });
  }
};

module.exports.config = { maxDuration: 15 };
