// Personal Goodreads MCP server (Streamable HTTP, JSON responses) for Claude.ai.
// Secrets: CONNECTOR_KEY (path secret), optional GR_COOKIE (fallback cookie).
// The Goodreads cookie lives in KV (GR_KV, key "cookie") and can be refreshed at /refresh/<CONNECTOR_KEY>.
// Endpoint: /mcp/<CONNECTOR_KEY>

const GR = "https://www.goodreads.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const decode = (s) =>
  (s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

async function gr(env, path, init = {}) {
  const res = await fetch(GR + path, {
    ...init,
    redirect: "manual",
    headers: {
      "User-Agent": UA,
      Cookie: env.GR_COOKIE,
      Accept: "text/html,application/json,*/*",
      ...(init.headers || {}),
    },
  });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location") || "";
    if (loc.includes("sign_in"))
      throw new Error(`Goodreads session expired. Ask the user to paste a fresh Goodreads cookie at ${env.REFRESH_URL}`);
  }
  if (!res.ok && res.status !== 302) throw new Error(`Goodreads ${res.status} for ${path}`);
  return res;
}

function cell(row, name) {
  const m = row.match(new RegExp(`<td class="field ${name}"[^>]*>[\\s\\S]*?<div class="value">([\\s\\S]*?)</div>\\s*</td>`));
  return m ? decode(m[1]).replace(/\[edit\]/g, "").trim() : "";
}

function parseShelfPage(html) {
  const rows = html.match(/<tr id="review_\d+" class="bookalike review">[\s\S]*?<\/tr>/g) || [];
  return rows.map((row) => {
    const t = row.match(/<td class="field title">[\s\S]*?<a title="([^"]*)" href="\/book\/show\/(\d+)/);
    const rating = (row.match(/data-rating="([\d.]+)"/) || [])[1];
    const shelves = [...row.matchAll(/class="shelfLink"[^>]*>([^<]+)</g)].map((m) => m[1]);
    return {
      book_id: t ? t[2] : null,
      title: t ? decode(t[1]) : "",
      author: cell(row, "author").replace(/\s*\*$/, ""),
      avg_rating: cell(row, "avg_rating"),
      pages: cell(row, "num_pages").replace(/\s*pp$/, ""),
      my_rating: rating && rating !== "0" && rating !== "0.0" ? rating : null,
      shelves,
      date_read: cell(row, "date_read").replace(/^not set$/, "") || null,
      date_added: cell(row, "date_added"),
    };
  });
}

async function listShelf(env, { shelf = "to-read", max = 200 }) {
  const out = [];
  for (let page = 1; page <= 10 && out.length < max; page++) {
    const q = new URLSearchParams({ shelf, per_page: "100", page: String(page), print: "true", sort: "date_added", order: "d" });
    const html = await (await gr(env, `/review/list/${env.GR_USER_ID}?${q}`)).text();
    const books = parseShelfPage(html);
    out.push(...books);
    if (books.length < 100) break;
  }
  return { shelf, count: out.length, books: out.slice(0, max) };
}

async function listShelves(env) {
  const html = await (await gr(env, `/review/list/${env.GR_USER_ID}?shelf=%23ALL%23&per_page=1`)).text();
  const shelves = [...html.matchAll(/class="actionLinkLite" href="\/review\/list\/\d+[^"]*?[?&;](?:shelf|tag)=([^"&]+)">([^<]+?)\s*&lrm;\((\d+)\)<\/a>/g)].map((m) => ({
    shelf: decodeURIComponent(m[1]),
    name: decode(m[2]),
    count: Number(m[3]),
  }));
  return { shelves };
}

async function searchBooks(env, { query, limit = 10 }) {
  const res = await gr(env, `/book/auto_complete?format=json&q=${encodeURIComponent(query)}`);
  const data = await res.json();
  return {
    results: data.slice(0, limit).map((b) => ({
      book_id: String(b.bookId),
      title: b.title,
      author: b.author?.name,
      avg_rating: b.avgRating,
      ratings: b.ratingsCount,
      pages: b.numPages,
      url: GR + b.bookUrl,
    })),
  };
}

async function getBook(env, { book_id }) {
  const html = await (await gr(env, `/book/show/${encodeURIComponent(book_id)}`)).text();
  let ld = {};
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (m) try { ld = JSON.parse(m[1]); } catch {}
  let desc = "";
  const nd = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (nd) {
    const ds = [...nd[1].matchAll(/"description(?:\(\{[^}]*\}\))?":"((?:[^"\\]|\\.)*)"/g)].map((d) => d[1]).sort((a, b) => b.length - a.length);
    if (ds[0]) try { desc = JSON.parse(`"${ds[0]}"`); } catch {}
  }
  if (!desc) desc = (html.match(/<meta property="og:description" content="([^"]*)"/) || [])[1] || "";
  const genres = [...new Set([...html.matchAll(/href="https:\/\/www\.goodreads\.com\/genres\/[^"]+"[^>]*>\s*<span[^>]*>([^<]+)</g)].map((g) => decode(g[1])))].slice(0, 8);
  return {
    book_id,
    title: decode(ld.name),
    authors: (Array.isArray(ld.author) ? ld.author : [ld.author]).filter(Boolean).map((a) => a.name),
    pages: ld.numberOfPages,
    avg_rating: ld.aggregateRating?.ratingValue,
    ratings: ld.aggregateRating?.ratingCount,
    genres,
    description: decode(desc),
    url: `${GR}/book/show/${book_id}`,
  };
}

async function csrf(env) {
  const html = await (await gr(env, `/review/list/${env.GR_USER_ID}?shelf=read&per_page=1`)).text();
  const t = (html.match(/name="csrf-token" content="([^"]+)"/) || [])[1];
  if (!t) throw new Error("Could not get a CSRF token (session may have expired).");
  return t;
}

async function shelveBook(env, { book_id, shelf, remove = false }) {
  const token = await csrf(env);
  const body = new URLSearchParams({ book_id: String(book_id), name: shelf, a: remove ? "remove" : "" });
  const res = await gr(env, "/shelf/add_to_shelf", {
    method: "POST",
    headers: {
      "X-CSRF-Token": token,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/javascript, */*",
    },
    body,
  });
  const text = await res.text();
  return { ok: res.ok, book_id, shelf, action: remove ? "removed" : "added", response: text.slice(0, 200) };
}

const TOOLS = [
  {
    name: "list_shelves",
    description: "List the user's Goodreads shelves with book counts.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    run: listShelves,
  },
  {
    name: "list_shelf",
    description: "List books on one of the user's Goodreads shelves (e.g. to-read, currently-reading, read, or a custom shelf). Newest first.",
    inputSchema: {
      type: "object",
      properties: {
        shelf: { type: "string", description: "Shelf name, e.g. to-read, currently-reading, read" },
        max: { type: "number", description: "Max books to return (default 200)" },
      },
      required: ["shelf"],
    },
    annotations: { readOnlyHint: true },
    run: listShelf,
  },
  {
    name: "search_books",
    description: "Search Goodreads for books by title/author. Returns book_ids.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
    run: searchBooks,
  },
  {
    name: "get_book",
    description: "Get details for a Goodreads book: description, rating, pages, genres.",
    inputSchema: {
      type: "object",
      properties: { book_id: { type: "string" } },
      required: ["book_id"],
    },
    annotations: { readOnlyHint: true },
    run: getBook,
  },
  {
    name: "shelve_book",
    description:
      "Put a book on a shelf. Exclusive shelves (to-read, currently-reading, read) move the book; custom shelves are added alongside. Set remove=true to take it off a custom shelf.",
    inputSchema: {
      type: "object",
      properties: {
        book_id: { type: "string" },
        shelf: { type: "string" },
        remove: { type: "boolean" },
      },
      required: ["book_id", "shelf"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: shelveBook,
  },
];

const rpc = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg, env) {
  const { id, method, params } = msg;
  if (id === undefined) return null; // notification
  switch (method) {
    case "initialize":
      return rpc(id, {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "goodreads-personal", version: "1.0.0" },
        instructions: "Aadhi's personal Goodreads library. Read shelves, search books, and move books between shelves.",
      });
    case "ping":
      return rpc(id, {});
    case "tools/list":
      return rpc(id, { tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return rpcErr(id, -32602, `Unknown tool ${params?.name}`);
      try {
        const data = await tool.run(env, params.arguments || {});
        return rpc(id, { content: [{ type: "text", text: JSON.stringify(data, null, 1) }] });
      } catch (e) {
        return rpc(id, { content: [{ type: "text", text: String(e.message || e) }], isError: true });
      }
    }
    default:
      return rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

async function sessionOk(cookie, userId) {
  const res = await fetch(`${GR}/review/list/${userId}?shelf=read&per_page=1`, {
    redirect: "manual",
    headers: { "User-Agent": UA, Cookie: cookie },
  });
  if (res.status !== 200) return false;
  const html = await res.text();
  return /name="csrf-token"/.test(html) && /bookalike review|No matching items/.test(html);
}

const page = (body) =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Goodreads connector</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:32px auto;padding:0 16px;color:#222;background:#faf8f5}
textarea{width:100%;height:140px;font:13px monospace;padding:8px;box-sizing:border-box}button{font-size:16px;padding:8px 18px;margin-top:8px}
.ok{color:#1a7f37}.bad{color:#b42318}code{background:#eee;padding:1px 4px;border-radius:3px}ol{padding-left:20px}
@media (prefers-color-scheme:dark){body{background:#181818;color:#ddd}code{background:#333}textarea{background:#222;color:#ddd}}</style></head><body>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );

async function refreshPage(request, env) {
  let msg = "";
  if (request.method === "POST") {
    const form = await request.formData();
    const cookie = String(form.get("cookie") || "").replace(/^\s*cookie:\s*/i, "").replace(/\s*\n\s*/g, " ").trim();
    if (!cookie) msg = `<p class="bad">Paste the cookie first.</p>`;
    else if (await sessionOk(cookie, env.GR_USER_ID)) {
      await env.GR_KV.put("cookie", cookie);
      await env.GR_KV.put("updated", new Date().toISOString());
      msg = `<p class="ok"><b>Saved.</b> Goodreads accepted it. You can close this page.</p>`;
    } else msg = `<p class="bad"><b>Not saved.</b> Goodreads didn't accept that cookie. Make sure you copied the whole <code>Cookie</code> request header while logged in.</p>`;
  }
  const current = env.GR_COOKIE ? await sessionOk(env.GR_COOKIE, env.GR_USER_ID) : false;
  const updated = await env.GR_KV.get("updated");
  return page(`<h1>Goodreads connector</h1>
<p>Current session: ${current ? '<span class="ok">working</span>' : '<span class="bad">expired, refresh below</span>'}${updated ? ` · last refreshed ${updated.slice(0, 10)}` : ""}</p>
${msg}
<ol><li>Open <a href="https://www.goodreads.com/review/list/${env.GR_USER_ID}" target="_blank">goodreads.com</a> and make sure you're logged in.</li>
<li>Open DevTools (<code>Cmd+Option+I</code>) → <b>Network</b> tab → reload the page.</li>
<li>Click the first request (<code>www.goodreads.com</code>) → <b>Request Headers</b> → copy the whole <code>Cookie</code> value.</li>
<li>Paste it below and save.</li></ol>
<form method="post"><textarea name="cookie" placeholder="session-id=...; ubid-main=...; at-main=...; ..."></textarea><br><button>Save</button></form>`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    env = {
      ...env,
      GR_COOKIE: (await env.GR_KV.get("cookie")) || env.GR_COOKIE,
      REFRESH_URL: `${url.origin}/refresh/${env.CONNECTOR_KEY}`,
    };
    if (url.pathname === `/refresh/${env.CONNECTOR_KEY}`) return refreshPage(request, env);
    if (url.pathname !== `/mcp/${env.CONNECTOR_KEY}`) return new Response("Not found", { status: 404 });
    if (request.method === "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    let body;
    try { body = await request.json(); } catch { return Response.json(rpcErr(null, -32700, "Parse error"), { status: 400 }); }
    const batch = Array.isArray(body);
    const results = (await Promise.all((batch ? body : [body]).map((m) => handle(m, env)))).filter(Boolean);
    if (!results.length) return new Response(null, { status: 202 });
    return Response.json(batch ? results : results[0]);
  },
};
