#!/usr/bin/env node
// Local dev server — no install, no accounts, no deploy:   node dev.js   then open http://localhost:8765
// - serves the static pages with the same rewrites as vercel.json (/, /trips, /trips/new, /<trip code>)
// - runs the real api/*.js handlers against a tiny in-memory fake of Upstash Redis
// Data lives only in memory and is gone when you stop the server. Not used on Vercel.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 8765;
const ROOT = __dirname;

// ---- fake Upstash REST (only the commands the app uses) ----
const store = new Map();   // key -> string | Map (hash) | Array (list)
const ttl = new Map();     // key -> epoch ms when it expires
function purge() { const now = Date.now(); for (const [k, t] of ttl) if (t <= now) { store.delete(k); ttl.delete(k); } }
function run(cmd) {
  purge();
  const [op, key, ...a] = cmd; const name = String(op).toUpperCase();
  const num = (v) => (v == null ? 0 : parseInt(v, 10) || 0);
  switch (name) {
    case "GET": { const v = store.get(key); return typeof v === "string" ? v : null; }
    case "SET": {
      if (a.some((x) => String(x).toUpperCase() === "NX") && store.has(key)) return null;
      store.set(key, String(a[0])); ttl.delete(key);
      const exi = a.findIndex((x) => String(x).toUpperCase() === "EX"); if (exi > 0) ttl.set(key, Date.now() + num(a[exi + 1]) * 1000);
      return "OK";
    }
    case "INCR": { const n = num(store.get(key)) + 1; store.set(key, String(n)); return n; }
    case "DECR": { const n = num(store.get(key)) - 1; store.set(key, String(n)); return n; }
    case "EXPIRE": if (!store.has(key)) return 0; ttl.set(key, Date.now() + num(a[0]) * 1000); return 1;
    case "EXPIREAT": if (!store.has(key)) return 0; ttl.set(key, num(a[0]) * 1000); purge(); return 1;
    case "PERSIST": return ttl.delete(key) ? 1 : 0;
    case "PTTL": return !store.has(key) ? -2 : ttl.has(key) ? Math.max(1, ttl.get(key) - Date.now()) : -1;
    case "HGET": { const h = store.get(key); return h instanceof Map && h.has(String(a[0])) ? h.get(String(a[0])) : null; }
    case "LPUSH": { let l = store.get(key); if (!Array.isArray(l)) { l = []; store.set(key, l); } l.unshift(String(a[0])); return l.length; }
    case "LTRIM": { const l = store.get(key); if (Array.isArray(l)) store.set(key, l.slice(num(a[0]), num(a[1]) + 1)); return "OK"; }
    case "LRANGE": { const l = store.get(key); return Array.isArray(l) ? l.slice(num(a[0]), num(a[1]) + 1) : []; }
    case "MGET": return [key, ...a].map((k) => { const v = store.get(k); return typeof v === "string" ? v : null; });
    case "SCAN": {
      const pat = String(a[1] || "*").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      const re = new RegExp("^" + pat + "$"); return ["0", [...store.keys()].filter((k) => re.test(k))];
    }
    case "DEL": ttl.delete(key); return store.delete(key) ? 1 : 0;
    case "HSETNX": {
      let h = store.get(key); if (!(h instanceof Map)) { h = new Map(); store.set(key, h); }
      if (h.has(String(a[0]))) return 0; h.set(String(a[0]), String(a[1])); return 1;
    }
    case "HDEL": { const h = store.get(key); return h instanceof Map && h.delete(String(a[0])) ? 1 : 0; }
    case "HLEN": { const h = store.get(key); return h instanceof Map ? h.size : 0; }
    case "HGETALL": { const h = store.get(key); return h instanceof Map ? [].concat(...[...h.entries()]) : []; }
    default: throw new Error("fake redis: unsupported command " + name);
  }
}
const redisServer = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const out = JSON.parse(body).map((c) => { try { return { result: run(c) }; } catch (e) { return { error: e.message }; } });
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(out));
    } catch (e) { res.statusCode = 400; res.end("[]"); }
  });
});

// ---- app server ----
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

function route(pathname, query) {
  if (pathname === "/") return "/index.html";
  if (pathname === "/trips" || pathname === "/trips/new") return "/trips.html";
  if (pathname === "/owner") return "/owner.html";
  if (/^\/[a-hj-km-np-z2-9]{6,8}$/.test(pathname)) return "/book.html";
  return pathname;
}

function startApp() {
  const app = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    const RD = { "/index.html": "/", "/book.html": "/", "/trips.html": "/trips", "/owner.html": "/owner", "/vercel.json": "/", "/dev.js": "/", "/README.md": "/" };
    if (RD[u.pathname]) { res.writeHead(302, { Location: RD[u.pathname] }); return res.end(); }
    if (u.pathname === "/api/trip" || u.pathname === "/api/seats" || u.pathname === "/api/owner" || u.pathname === "/api/mark") {
      let raw = ""; req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        req.query = Object.fromEntries(u.searchParams);
        try { req.body = raw ? JSON.parse(raw) : {}; } catch (e) { req.body = {}; }
        res.status = (c) => { res.statusCode = c; return res; };
        res.json = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
        try { await require("./api/" + path.basename(u.pathname))(req, res); }
        catch (e) { console.error(e); if (!res.writableEnded) { res.statusCode = 500; res.end("{}"); } }
      });
      return;
    }
    const rel = route(u.pathname, u.searchParams);
    // only plain static assets at the project root (never dev.js, api/, vercel.json, .git ...)
    if (rel !== "/qrcode.js" && !/^\/[A-Za-z0-9_-]+\.(html|css|svg|png|ico|webmanifest)$/.test(rel)) { res.statusCode = 404; return res.end("Not found"); }
    const file = path.join(ROOT, rel);
    fs.readFile(file, (err, data) => {
      if (err) { res.statusCode = 404; return res.end("Not found"); }
      res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      res.end(data);
    });
  });
  app.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error("\n  Port " + PORT + " is already in use (an old server is still running).");
      console.error("  Stop it:  lsof -ti:" + PORT + " | xargs kill     or use another port:  PORT=8766 node dev.js\n");
    } else console.error(e);
    process.exit(1);
  });
  app.listen(PORT, () => {
    console.log("\n  Van seat booking (local dev)\n");
    console.log("  Home            http://localhost:" + PORT + "/");
    console.log("  My trips (/trips)   http://localhost:" + PORT + "/trips");
    console.log("\n  Data is kept in memory only; it resets when you stop this server.\n");
  });
}

redisServer.listen(0, "127.0.0.1", () => {
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:" + redisServer.address().port;
  process.env.UPSTASH_REDIS_REST_TOKEN = "dev";
  startApp();
});
