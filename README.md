# goodreads-mcp

A tiny personal [MCP](https://modelcontextprotocol.io) server that connects your Goodreads account to Claude (Claude.ai custom connector). Runs free on Cloudflare Workers.

Goodreads has no API anymore (and killed its RSS feeds), so this uses your own logged-in Goodreads session cookie and reads the same pages your browser does.

## Tools
| Tool | What it does |
|---|---|
| `list_shelves` | Your shelves with counts |
| `list_shelf` | Books on a shelf (to-read, currently-reading, read, custom) |
| `search_books` | Search Goodreads |
| `get_book` | Description, rating, pages, genres |
| `shelve_book` | Move a book to a shelf (or add/remove a custom shelf) |

## Setup
1. `pnpm install`
2. Set your Goodreads user ID in `wrangler.toml` (`GR_USER_ID`).
3. Create a KV namespace and put its id in `wrangler.toml`: `pnpm exec wrangler kv namespace create GR_KV`
4. Set a long random path secret: `openssl rand -hex 24 | pnpm exec wrangler secret put CONNECTOR_KEY`
5. `pnpm exec wrangler deploy`
6. Open `https://<your-worker>.workers.dev/refresh/<CONNECTOR_KEY>` and paste your Goodreads cookie (instructions on the page).
7. In Claude.ai: Customize → Connectors → Add custom connector → URL `https://<your-worker>.workers.dev/mcp/<CONNECTOR_KEY>`, Authentication: **No sign-in**.

## When the session expires
Tools return an error with the refresh link. Open it, paste a fresh `Cookie` request header from DevTools (Network tab, first `www.goodreads.com` request), save. Nothing else to redeploy.

## Notes
- Anyone with the connector URL can use it, so keep `CONNECTOR_KEY` secret.
- Scraping pages is fragile; a Goodreads redesign may need a parser fix.
- This automates your own account, which is against Goodreads' terms. Use at your own risk.
