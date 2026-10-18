// Vercel serverless function: /api/trip
//   POST            create a trip                 -> { id, token }
//   GET  ?t=&k=     read a trip for editing (needs the admin token k)
//   PUT             update a trip (body has t, k)
//   DELETE ?t=      delete a trip and its bookings (admin token in x-admin-key)
// No accounts: whoever holds the secret admin link (t + k) manages the trip.
const L = require("./_lib");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const MAX_VANS = 5;           // vans per trip (a trip created earlier with more keeps its count when edited)
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
  return {
    value: { name, organizer: s(body.organizer, 80), startDate, endDate, departTime, meetPoint: s(body.meetPoint, 120), vans: outVans },
  };
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
function clientIp(req) {
  return (String((req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"])) || "").split(",")[0].trim() || "unknown").slice(0, 64);
}
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

module.exports = async function handler(req, res) {
  if (!L.REST_URL || !L.REST_TOKEN) return L.json(res, 500, { error: "not_configured" });
  try {
    if (req.method === "POST") {
      const c = clean(L.readBody(req));
      if (c.error) return L.json(res, 400, { error: c.error });
      const q = await takeQuota(req, L.readBody(req).d);
      if (q.over) return L.json(res, 429, { error: q.over, limit: TRIPS_PER_MONTH });
      const id = L.newId(8), secret = L.newId(16);
      const trip = Object.assign({ id, createdAt: Date.now(), adminHash: sha256(secret) }, c.value);
      trip.vans = assignVanIds(trip.vans, []);
      const ok = await L.redis(["SET", L.tripKey(id), JSON.stringify(trip), "NX"]);
      if (ok !== "OK") { await refundQuota(q.keys); return L.json(res, 502, { error: "storage_error" }); }
      return L.json(res, 200, { id, token: secret, trip: L.publicTrip(trip) });
    }

    if (req.method === "GET") {
      const t = L.tripId(req.query && req.query.t);
      const trip = t && t !== L.DEFAULT_ID ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      if (await authBlocked(req)) return L.json(res, 429, { error: "too_many" });
      if (!tokenOk(trip, adminKey(req, req.query.k))) { await authFailed(req); return L.json(res, 403, { error: "bad_token" }); }
      const counts = await L.pipeline(trip.vans.map((v) => ["HLEN", L.seatsKey(t, v.id)]));
      const booked = counts.reduce((a, n) => a + (Number(n) || 0), 0);
      return L.json(res, 200, { trip: L.publicTrip(trip), booked });
    }

    if (req.method === "DELETE") {
      const t = L.tripId(req.query && req.query.t);
      const trip = t && t !== L.DEFAULT_ID ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      if (await authBlocked(req)) return L.json(res, 429, { error: "too_many" });
      if (!tokenOk(trip, adminKey(req, req.query.k))) { await authFailed(req); return L.json(res, 403, { error: "bad_token" }); }
      const cmds = [["DEL", L.tripKey(t)]];
      trip.vans.forEach((v) => cmds.push(["DEL", L.seatsKey(t, v.id)]));
      await L.pipeline(cmds);
      return L.json(res, 200, { ok: true });
    }

    if (req.method === "PUT") {
      const body = L.readBody(req);
      const t = L.tripId(body.t);
      const trip = t && t !== L.DEFAULT_ID ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      if (await authBlocked(req)) return L.json(res, 429, { error: "too_many" });
      if (!tokenOk(trip, adminKey(req, body.k))) { await authFailed(req); return L.json(res, 403, { error: "bad_token" }); }
      const c = clean(body, trip.vans.length);
      if (c.error) return L.json(res, 400, { error: c.error });
      const oldIds = trip.vans.map((v) => v.id);
      const next = assignVanIds(c.value.vans.map((v) => ({ id: oldIds.includes(v.id) ? v.id : "", label: v.label, plate: v.plate })), oldIds);
      const kept = new Set(next.map((v) => v.id));
      const removed = oldIds.filter((id) => !kept.has(id));
      const updated = Object.assign({}, trip, c.value, { vans: next });
      const cmds = [["SET", L.tripKey(t), JSON.stringify(updated)]];
      removed.forEach((id) => cmds.push(["DEL", L.seatsKey(t, id)]));
      await L.pipeline(cmds);
      return L.json(res, 200, { ok: true, trip: L.publicTrip(updated) });
    }

    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return L.json(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    return L.json(res, 502, { error: "storage_error" });
  }
};
