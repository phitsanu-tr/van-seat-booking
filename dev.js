#!/usr/bin/env node
// Local dev server — no install, no accounts, no deploy:   node dev.js   then open http://localhost:8765
// - serves the static pages with the same rewrites as vercel.json (/, /trips, /<trip code>; /a redirects to /trips)
// - runs the real api/*.js handlers against a tiny in-memory fake of Upstash Redis
// Data lives only in memory and is gone when you stop the server. Not used on Vercel.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 8765;
const ROOT = __dirname;

// ---- fake Upstash REST (only the commands the app uses) ----
const store = new Map();   // key -> string | Map (hash)
function run(cmd) {
  const [op, key, ...a] = cmd; const name = String(op).toUpperCase();
  const num = (v) => (v == null ? 0 : parseInt(v, 10) || 0);
  switch (name) {
    case "GET": { const v = store.get(key); return typeof v === "string" ? v : null; }
    case "SET": {
      if (a.some((x) => String(x).toUpperCase() === "NX") && store.has(key)) return null;
      store.set(key, String(a[0])); return "OK";
    }
    case "INCR": { const n = num(store.get(key)) + 1; store.set(key, String(n)); return n; }
    case "DECR": { const n = num(store.get(key)) - 1; store.set(key, String(n)); return n; }
    case "EXPIRE": return store.has(key) ? 1 : 0;
    case "DEL": return store.delete(key) ? 1 : 0;
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
  if (/^\/[a-hj-km-np-z2-9]{6,8}$/.test(pathname)) return "/book.html";
  return pathname;
}

function startApp() {
  const app = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/a") {
      res.writeHead(302, { Location: (u.searchParams.get("new") === "1" ? "/trips/new" : "/trips") });
      return res.end();
    }
    if (u.pathname === "/api/trip" || u.pathname === "/api/seats") {
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
