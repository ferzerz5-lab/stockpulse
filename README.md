# StockPulse

Every transfer of AAPL and NVDA stock tokens on Robinhood Chain, printed on a live paper-tape page. Built on Quicknode's RPC endpoint for the chain.

It is a static site plus one Vercel serverless function (`api/transfers.js`). Robinhood Chain is a standard EVM chain, so recent transfers come from a plain `eth_getLogs` call over the last 3000 blocks (about five minutes). No always-on server is needed. The page loads the last five minutes from `/api/transfers` (cached 15 seconds at the edge), then asks `/api/transfers?w=live` every 3 seconds for just the newest 300 blocks (cached 3 seconds). Only those two window sizes are accepted, so any number of visitors share the same two cached answers and Quicknode credits stay predictable. A hidden tab asks for nothing, and after 10 minutes with no touch, click, key or scroll the page slows to one check every 20 seconds.

Nothing on the site is simulated. If the feed is down or not configured, pages stay empty and say so.

## Pages

- `index.html`: the live tape, five stats, filters for transfers, mints and burns
- `aapl.html`, `nvda.html`: the same for one ticker, with its contract address
- `wallets.html`: most active wallets per ticker, ranked by tokens moved
- `developers.html`: contract addresses, a ready `eth_getLogs` request, the JSON shape, how to add a ticker
- `about.html`: how it works and what it leaves out
- `privacy.html`, `terms.html`

## Files to upload

Everything at the repo root except `transfers.js`, which goes inside a folder named `api`:

`index.html`, `aapl.html`, `nvda.html`, `wallets.html`, `developers.html`, `about.html`, `privacy.html`, `terms.html`, `styles.css`, `app.js`, `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`, `package.json`, `README.md`, and `api/transfers.js`.

## Deploying (GitHub web UI and Vercel)

1. Create a GitHub repo called `stockpulse` and upload the files above.
2. In Vercel, create a New Project from the repo. Leave the framework preset as "Other".
3. In Settings, Environment Variables, add `QN_RH_RPC_URL` with the HTTPS URL of your Quicknode Robinhood Chain endpoint. The token is inside that URL, so treat it like a password.
4. Redeploy. Environment variables only apply to new deployments.
5. Open the site. The lamp should read "printing live".

## Checking it works

Open `your-site.vercel.app/?debug=1` and scroll to the bottom for the raw response from `/api/transfers`. A `demo: true` flag means the environment variable is missing or the project was not redeployed. An `error` field means the RPC call failed. An empty `transfers` list with no error means the call worked and nothing moved in the last five minutes, which is normal for two tickers on a young chain.

If the debug panel shows an error about the block range, lower `BLOCK_WINDOW` at the top of `api/transfers.js`.

## Adding a ticker

Check the contract address on robinhoodchain.blockscout.com, then add it to the `WATCHLIST` array in `api/transfers.js`. A wrong address fails silently and just shows an empty reel. Tape pages style AAPL and NVDA specially, and other symbols appear in a neutral color.

## Before launch

- Connect a custom domain in Vercel
- Favicon: added
- No "Made with AI" tag: none is present
- Privacy and terms pages: added
