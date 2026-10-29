// Vercel serverless function: /api/auth — sign in with LINE (LINE Login v2.1, web flow, no LIFF)
//   GET  ?start=1&r=/path   -> redirect to LINE's sign-in page (r = where to come back to, same site only)
//   GET  ?code=&state=      -> LINE redirects back here: check state, exchange the code, verify the ID token,
//                              start a session (HttpOnly cookie vsb_s) and go back to r
//   GET  ?me=1              -> { user: {name, pic} } or { user: null }
//   POST { logout: true }   -> end the session
// Env: LINE_CHANNEL_ID, LINE_CHANNEL_SECRET, optional LINE_REDIRECT_URI (else https://<host>/api/auth).
// Local dev only (dev.js sets VSB_DEV_AUTH=1, never on Vercel): ?start=1 signs in a fake user named by ?as=.
const L = require("./_lib");

const AUTHORIZE = "https://access.line.me/oauth2/v2.1/authorize";
const TOKEN_URL = "https://api.line.me/oauth2/v2.1/token";
const VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";
const DEV = process.env.VSB_DEV_AUTH === "1" && !process.env.VERCEL;

function env(name) {
  for (const k of Object.keys(process.env)) if ((k === name || k.endsWith("_" + name)) && process.env[k]) return process.env[k];
  return "";
}
function safeReturn(r) {
  const s = String(r || "/");
  return /^\/(?!\/)[A-Za-z0-9\-._~/?=&%#]*$/.test(s) && s.length <= 300 ? s : "/";
}
function redirectUri(req) {
  const fixed = env("LINE_REDIRECT_URI");
  if (fixed) return fixed;
  const host = String((req.headers && (req.headers["x-forwarded-host"] || req.headers.host)) || "").split(",")[0].trim();
  return (L.isHttps(req) ? "https://" : "http://") + host + "/api/auth";
}
function go(res, location, cookies) {
  if (cookies && cookies.length) res.setHeader("Set-Cookie", cookies);
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
}
function withFlag(path, flag) {
  const i = path.indexOf("#"), base = i < 0 ? path : path.slice(0, i), hash = i < 0 ? "" : path.slice(i);
  return base + (base.indexOf("?") < 0 ? "?" : "&") + flag + hash;
}

async function startSession(req, res, profile, back) {
  const sid = L.newId(32); // ~157 bits of randomness
  const sess = { u: profile.sub, n: String(profile.name || "").slice(0, 60), p: /^https:\/\//.test(profile.picture || "") ? String(profile.picture).slice(0, 300) : "", at: Date.now() };
  await L.pipeline([["SET", "sess:" + sid, JSON.stringify(sess), "EX", String(L.SESSION_DAYS * 86400)]]);
  go(res, withFlag(back, "li=1"), [L.cookieStr(req, "vsb_s", sid, L.SESSION_DAYS * 86400), L.cookieStr(req, "vsb_st", "", 0)]);
}

module.exports = async function handler(req, res) {
  if (!L.REST_URL || !L.REST_TOKEN) return L.json(res, 500, { error: "not_configured" });
  const q = req.query || {};
  try {
    if (req.method === "POST") {
      const body = L.readBody(req);
      if (body.logout === true) {
        const u = await L.currentUser(req);
        if (u) { try { await L.redis(["DEL", "sess:" + u.sid]); } catch (e) { /* ignore */ } }
        res.setHeader("Set-Cookie", [L.cookieStr(req, "vsb_s", "", 0)]);
        return L.json(res, 200, { ok: true });
      }
      return L.json(res, 400, { error: "bad_request" });
    }
    if (req.method !== "GET") { res.setHeader("Allow", "GET, POST"); return L.json(res, 405, { error: "method_not_allowed" }); }

    if (q.me !== undefined) {
      const u = await L.currentUser(req);
      return L.json(res, 200, { user: L.publicUser(u), login: DEV || !!env("LINE_CHANNEL_ID") });
    }

    if (q.start !== undefined) {
      const back = safeReturn(q.r);
      if (await L.rateLimited(req, null, "login", 30, 600)) return go(res, withFlag(back, "le=busy"));
      if (DEV) {
        const name = String(q.as || "ผู้ทดสอบ").slice(0, 30);
        return startSession(req, res, { sub: "Udev" + L.crypto.createHash("sha256").update(name).digest("hex").slice(0, 24), name, picture: "" }, back);
      }
      const id = env("LINE_CHANNEL_ID");
      if (!id || !env("LINE_CHANNEL_SECRET")) return go(res, withFlag(back, "le=setup"));
      const state = L.newId(24);
      const nonce = L.newId(16);
      const st = Buffer.from(JSON.stringify({ s: state, n: nonce, r: back })).toString("base64url");
      const url = AUTHORIZE + "?response_type=code&client_id=" + encodeURIComponent(id) + "&redirect_uri=" + encodeURIComponent(redirectUri(req)) +
        "&state=" + state + "&scope=" + encodeURIComponent("openid profile") + "&nonce=" + nonce;
      return go(res, url, [L.cookieStr(req, "vsb_st", st, 600)]);
    }

    // ---- callback from LINE ----
    let st = null;
    try { st = JSON.parse(Buffer.from(String(L.cookies(req).vsb_st || ""), "base64url").toString("utf8")); } catch (e) { st = null; }
    const back = safeReturn(st && st.r);
    if (q.error) return go(res, withFlag(back, "le=cancel"), [L.cookieStr(req, "vsb_st", "", 0)]); // the person pressed "cancel" on LINE
    if (!st || !q.state || String(q.state) !== st.s || !q.code) return go(res, withFlag(back, "le=state"), [L.cookieStr(req, "vsb_st", "", 0)]);
    const id = env("LINE_CHANNEL_ID"), secret = env("LINE_CHANNEL_SECRET");
    const tr = await fetch(TOKEN_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: String(q.code), redirect_uri: redirectUri(req), client_id: id, client_secret: secret }).toString(),
    });
    const tok = await tr.json().catch(() => ({}));
    if (!tr.ok || !tok.id_token) return go(res, withFlag(back, "le=token"), [L.cookieStr(req, "vsb_st", "", 0)]);
    // LINE checks the ID token's signature, audience, expiry and nonce for us
    const vr = await fetch(VERIFY_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: tok.id_token, client_id: id, nonce: st.n }).toString(),
    });
    const prof = await vr.json().catch(() => ({}));
    if (!vr.ok || !prof.sub || !/^U[0-9a-f]{32}$/.test(prof.sub)) return go(res, withFlag(back, "le=verify"), [L.cookieStr(req, "vsb_st", "", 0)]);
    return startSession(req, res, prof, back);
  } catch (e) {
    return go(res, withFlag(safeReturn(q.r), "le=error"));
  }
};
