// Vercel serverless function: /api/trip
//   POST            create a trip                 -> { id, token }
//   GET  ?t=&k=     read a trip for editing (needs the admin token k)
//   PUT             update a trip (body has t, k)
//   DELETE ?t=      delete a trip and its bookings (admin token in x-admin-key)
// Whoever holds the secret admin link (t + k) manages the trip; so does the signed-in LINE account that created
// (or claimed) it (trip.owner). k = "o" is the placeholder the page sends in owner mode.
//   POST { claim: true, t }   signed-in + secret -> the trip becomes this account's (only if it has no owner yet)
const L = require("./_lib");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const MAX_VANS = 5;           // vans per trip (a trip created earlier with more keeps its count when edited)
const QUOTA_ENABLED = false;    // monthly creation limit is switched off for now; set to true to bring it back
const TRIPS_PER_MONTH = 5;      // per creator (browser/device id)
const TRIPS_PER_MONTH_IP = 15;  // backstop per network, so clearing browser data is not a free reset

// Counts a creation against this month's quota. Returns null when allowed, else an error code.
// Month boundary follows Thai time (UTC+7). Counters expire on their own.
async function takeQuota(req, deviceId) {
  const month = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
  const fwd = String((req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"])) || "").split(",")[0].trim() || "unknown";
  const keys = [];
  if (/^[A-Za-z0-9-]{8,64}$/.test(deviceId || "")) keys.push(["quota:" + month + ":d:" + deviceId, TRIPS_PER_MONTH, "quota_device"]);
  keys.push(["quota:" + month + ":ip:" + fwd.slice(0, 64), TRIPS_PER_MONTH_IP, "quota_ip"]);
  const cmds = [];
  keys.forEach((k) => { cmds.push(["INCR", k[0]]); cmds.push(["EXPIRE", k[0], String(40 * 86400)]); });
  const res = await L.pipeline(cmds);
  let over = null;
  keys.forEach((k, i) => { if (!over && Number(res[i * 2]) > k[1]) over = k[2]; });
  if (over) await refundQuota(keys);
  return { over, keys };
}
async function refundQuota(keys) {
  try { await L.pipeline(keys.map((k) => ["DECR", k[0]])); } catch (e) { /* best effort */ }
}

function clean(body, vanCap) {
  const s = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const name = s(body.name, 80);
  if (!name) return { error: "bad_name" };
  const startDate = s(body.startDate, 10), endDate = s(body.endDate, 10), departTime = s(body.departTime, 5);
  if (startDate && !DATE_RE.test(startDate)) return { error: "bad_date" };
  if (endDate && !DATE_RE.test(endDate)) return { error: "bad_date" };
  if (departTime && !TIME_RE.test(departTime)) return { error: "bad_time" };
  const vans = Array.isArray(body.vans) ? body.vans : [];
  if (vans.length < 1 || vans.length > Math.max(MAX_VANS, vanCap || 0)) return { error: "bad_vans" };
  const seen = new Set();
  const outVans = [];
  for (const v of vans) {
    const label = s(v && v.label, 12);
    if (!label) return { error: "bad_vans" };
    const id = s(v && v.id, 12);
    if (id && (seen.has(id) || !/^[A-Za-z0-9]+$/.test(id))) return { error: "bad_vans" };
    if (id) seen.add(id);
    const plate = s(v && v.plate, 25);
    outVans.push(plate ? { id, label, plate } : { id, label });
  }
  const value = { name, organizer: s(body.organizer, 80), startDate, endDate, departTime, meetPoint: s(body.meetPoint, 120), vans: outVans };
  if (body.maxPerPerson !== undefined && body.maxPerPerson !== null && body.maxPerPerson !== "") {
    const m = Number(body.maxPerPerson);
    if (!Number.isInteger(m) || m < 0 || m > 50) return { error: "bad_max" };
    value.maxPerPerson = m; // 0 = no limit
  }
  return { value };
}

// Gives each new van an id that is unused so far (v1, v2, ...).
function assignVanIds(vans, taken) {
  const used = new Set(taken);
  vans.forEach((v) => { if (v.id) used.add(v.id); });
  let i = 1;
  vans.forEach((v) => {
    if (v.id) return;
    while (used.has("v" + i)) i++;
    v.id = "v" + i; used.add(v.id);
  });
  return vans;
}

const sha256 = (v) => L.crypto.createHash("sha256").update(String(v)).digest("hex");
function safeEq(x, y) {
  const a = Buffer.from(String(x)), b = Buffer.from(String(y));
  return a.length === b.length && L.crypto.timingSafeEqual(a, b);
}
// New trips store only a hash of the secret (adminHash); older trips still hold it in plain (adminToken).
function tokenOk(trip, k) {
  if (!trip || typeof k !== "string" || !k || k.length > 64) return false;
  if (trip.adminHash) return safeEq(trip.adminHash, sha256(k));
  return !!trip.adminToken && safeEq(trip.adminToken, k);
}

// Brute-force guard: wrong secrets are counted per network per hour.
const MAX_BAD_TOKENS = 10;
const clientIp = L.clientIp;
function failKey(req) { return "authfail:" + clientIp(req) + ":" + Math.floor(Date.now() / 3600000); }
async function authBlocked(req) {
  const n = Number(await L.redis(["GET", failKey(req)]));
  return n >= MAX_BAD_TOKENS;
}
async function authFailed(req) {
  const key = failKey(req);
  await L.pipeline([["INCR", key], ["EXPIRE", key, "7200"]]);
}
// Secret comes from the x-admin-key header (keeps it out of URLs/logs); ?k= still accepted for old links.
function adminKey(req, fallback) {
  const h = req.headers && req.headers["x-admin-key"];
  return typeof h === "string" && h ? h : fallback;
}

// Signed-in owner, or the secret. The owner check comes first so it never counts as a failed secret.
async function allowed(req, trip, k, user) {
  if (user && trip.owner && trip.owner === user.id) return true;
  if (await authBlocked(req)) return "blocked";
  if (tokenOk(trip, k)) return true;
  await authFailed(req);
  return false;
}
function deny(res, a) { return a === "blocked" ? L.json(res, 429, { error: "too_many" }) : L.json(res, 403, { error: "bad_token" }); }
function tripSummary(trip, user) { return Object.assign(L.publicTrip(trip), { mine: !!(user && trip.owner === user.id) }); }

module.exports = async function handler(req, res) {
  if (!L.REST_URL || !L.REST_TOKEN) return L.json(res, 500, { error: "not_configured" });
  try {
    const user = await L.currentUser(req);
    if (req.method === "POST" && L.readBody(req).claim === true) {
      const t = L.tripId(L.readBody(req).t);
      const trip = t && t !== L.DEFAULT_ID ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      if (!user) return L.json(res, 401, { error: "login_required" });
      if (trip.owner) return L.json(res, 200, { ok: trip.owner === user.id, mine: trip.owner === user.id });
      if (await authBlocked(req)) return L.json(res, 429, { error: "too_many" });
      if (!tokenOk(trip, adminKey(req, ""))) { await authFailed(req); return L.json(res, 403, { error: "bad_token" }); }
      const updated = Object.assign({}, trip, { owner: user.id, ownerName: user.name });
      await L.pipeline([["SET", L.tripKey(t), JSON.stringify(updated)], ["SADD", L.myTripsKey(user.id), t], ["EXPIRE", L.myTripsKey(user.id), String(L.MY_DAYS * 86400)]]);
      await L.applyExpiry(updated); // SET cleared the TTL
      return L.json(res, 200, { ok: true, mine: true });
    }
    if (req.method === "POST" && L.readBody(req).mint === true) {
      // short-lived code that lets the ADMIN PASS picture page open outside LINE without the secret ever appearing in a URL
      const t = L.tripId(L.readBody(req).t);
      const trip = t && t !== L.DEFAULT_ID ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      const secret = adminKey(req, "");
      const a = await allowed(req, trip, secret, user);
      if (a !== true) return deny(res, a);
      const code = L.newId(10);
      const ownerMode = !tokenOk(trip, secret); // signed-in owner without the secret: the picture page gets the owner link (#id-o)
      await L.redis(["SET", "pass:" + code, JSON.stringify(ownerMode ? { t, o: trip.owner } : { t, k: secret }), "EX", String(15 * 60)]);
      return L.json(res, 200, { k: code });
    }
    if (req.method === "POST") {
      if (L.REQUIRE_LOGIN && !user) return L.json(res, 401, { error: "login_required" });
      const c = clean(L.readBody(req));
      if (c.error) return L.json(res, 400, { error: c.error });
      const q = QUOTA_ENABLED ? await takeQuota(req, L.readBody(req).d) : { over: null, keys: [] };
      if (q.over) return L.json(res, 429, { error: q.over, limit: TRIPS_PER_MONTH });
      const id = L.newId(8), secret = L.newId(16);
      const now = Date.now();
      if (await L.rateLimited(req, user, "create", 20, 3600)) return L.json(res, 429, { error: "too_many" });
      const trip = Object.assign({ id, schemaVersion: 1, createdAt: now, updatedAt: now, adminHash: sha256(secret) }, user ? { owner: user.id, ownerName: user.name } : {}, c.value);
      trip.vans = assignVanIds(trip.vans, []);
      const ok = await L.redis(["SET", L.tripKey(id), JSON.stringify(trip), "NX"]);
      if (ok !== "OK") { await refundQuota(q.keys); return L.json(res, 502, { error: "storage_error" }); }
      await L.applyExpiry(trip);
      if (user) { try { await L.pipeline([["SADD", L.myTripsKey(user.id), id], ["EXPIRE", L.myTripsKey(user.id), String(L.MY_DAYS * 86400)]]); } catch (e) { /* best effort */ } }
      return L.json(res, 200, { id, token: secret, trip: tripSummary(trip, user) });
    }

    if (req.method === "GET" && req.query && req.query.code !== undefined) {
      const code = String(req.query.code || "");
      if (await authBlocked(req)) return L.json(res, 429, { error: "too_many" });
      let p = null;
      if (/^[a-z0-9]{10}$/.test(code)) { try { p = JSON.parse(await L.redis(["GET", "pass:" + code])); } catch (e) { p = null; } }
      const trip = p && p.t ? await L.loadTrip(p.t) : null;
      const ok = trip && (p.o ? trip.owner === p.o : tokenOk(trip, p.k));
      if (!ok) { await authFailed(req); return L.json(res, 404, { error: "bad_code" }); }
      return L.json(res, 200, { id: p.t, token: p.o ? "o" : p.k, trip: L.publicTrip(trip) });
    }
    if (req.method === "GET") {
      const t = L.tripId(req.query && req.query.t);
      const trip = t && t !== L.DEFAULT_ID ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      const a = await allowed(req, trip, adminKey(req, req.query.k), user);
      if (a !== true) return deny(res, a);
      const counts = await L.pipeline(trip.vans.map((v) => ["HLEN", L.seatsKey(t, v.id)]));
      const perVan = {};
      trip.vans.forEach((v, i) => { perVan[v.id] = Number(counts[i]) || 0; });
      const booked = counts.reduce((a, n) => a + (Number(n) || 0), 0);
      let roster;
      if (req.query.roster !== undefined) { // organizer's passenger list: every seat of every van (no account ids)
        const all = await L.pipeline(trip.vans.map((v) => ["HGETALL", L.seatsKey(t, v.id)]));
        roster = {};
        trip.vans.forEach((v, i) => {
          const flat = all[i] || [], seats = {};
          for (let j = 0; j + 1 < flat.length; j += 2) {
            const n = L.parseSeat(flat[j]); if (n === null) continue;
            try { const r = JSON.parse(flat[j + 1]); if (r && r.name) seats[n] = Object.assign({ name: String(r.name), at: r.at }, r.u ? { a: 1 } : {}, user && r.u === user.id ? { m: 1 } : {}); } catch (e) { /* skip */ }
          }
          roster[v.id] = seats;
        });
      }
      return L.json(res, 200, { trip: tripSummary(trip, user), booked, perVan, claimable: !!(user && !trip.owner), roster, ended: L.tripEnded(trip) });
    }

    if (req.method === "DELETE") {
      const t = L.tripId(req.query && req.query.t);
      const trip = t && t !== L.DEFAULT_ID ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      const a = await allowed(req, trip, adminKey(req, req.query.k), user);
      if (a !== true) return deny(res, a);
      const cmds = [["DEL", L.tripKey(t)], ["DEL", L.logKey(t)]];
      if (trip.owner) cmds.push(["SREM", L.myTripsKey(trip.owner), t]);
      trip.vans.forEach((v) => cmds.push(["DEL", L.seatsKey(t, v.id)]));
      await L.pipeline(cmds);
      return L.json(res, 200, { ok: true });
    }

    if (req.method === "PUT") {
      const body = L.readBody(req);
      const t = L.tripId(body.t);
      const trip = t && t !== L.DEFAULT_ID ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      const a = await allowed(req, trip, adminKey(req, body.k), user);
      if (a !== true) return deny(res, a);
      const c = clean(body, trip.vans.length);
      if (c.error) return L.json(res, 400, { error: c.error });
      const oldIds = trip.vans.map((v) => v.id);
      const next = assignVanIds(c.value.vans.map((v) => ({ id: oldIds.includes(v.id) ? v.id : "", label: v.label, plate: v.plate })), oldIds);
      const kept = new Set(next.map((v) => v.id));
      const removed = oldIds.filter((id) => !kept.has(id));
      const updated = Object.assign({}, trip, c.value, { vans: next, schemaVersion: 1, updatedAt: Date.now() });
      const cmds = [["SET", L.tripKey(t), JSON.stringify(updated)]];
      removed.forEach((id) => cmds.push(["DEL", L.seatsKey(t, id)]));
      await L.pipeline(cmds);
      await L.applyExpiry(updated); // SET cleared the TTL; dates may have changed
      return L.json(res, 200, { ok: true, trip: tripSummary(updated, user) });
    }

    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return L.json(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    return L.json(res, 502, { error: "storage_error" });
  }
};
