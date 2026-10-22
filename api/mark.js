// Vercel serverless function: /api/mark   (carries "which seats are mine" to the image page opened outside LINE)
//   POST {t, v, seats:[{seat, at}]}  -> {k}      the server checks each seat really is booked with that timestamp, then returns
//                                                 an opaque, encrypted + authenticated token that expires after 15 minutes
//   GET  ?k=token                    -> {t, v, seats:[n]}   only for a valid, unexpired token whose seats are still booked
// The token is AES-256-GCM encrypted with a key derived from OWNER_KEY, so it cannot be read, forged or altered.
// It only drives the green highlight in the picture; it never grants any right to cancel or change a booking.
const crypto = require("crypto");
const L = require("./_lib");

const TTL = 15 * 60; // seconds

function secret() {
  const k = process.env.OWNER_KEY;
  return typeof k === "string" && k.length >= 16 ? crypto.createHash("sha256").update("mark:" + k).digest() : null;
}
function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64url");
}
function open(key, token) {
  try {
    const raw = Buffer.from(String(token), "base64url");
    if (raw.length < 29) return null;
    const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
  } catch (e) { return null; }
}
async function currentSeats(t, v) {
  const flat = (await L.redis(["HGETALL", L.seatsKey(t, v)])) || [];
  const seats = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const n = L.parseSeat(flat[i]);
    if (n === null) continue;
    try { const x = JSON.parse(flat[i + 1]); if (x && x.name) seats[n] = x.at; } catch (e) { /* skip */ }
  }
  return seats;
}

module.exports = async function handler(req, res) {
  const key = secret();
  if (!key || !L.REST_URL || !L.REST_TOKEN) return L.json(res, 404, { error: "not_configured" });
  try {
    if (req.method === "POST") {
      const body = L.readBody(req);
      const t = L.tripId(body.t);
      const trip = t && (await L.loadTrip(t));
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      const v = String(body.v || trip.vans[0].id);
      if (!trip.vans.some((x) => x.id === v)) return L.json(res, 404, { error: "no_van" });
      const now = await currentSeats(t, v);
      const mine = [];
      (Array.isArray(body.seats) ? body.seats.slice(0, 10) : []).forEach((s) => {
        const n = L.parseSeat(s && s.seat);
        if (n !== null && now[n] !== undefined && now[n] === s.at && !mine.some((m) => m.n === n)) mine.push({ n, at: now[n] });
      });
      if (!mine.length) return L.json(res, 404, { error: "none" });
      return L.json(res, 200, { k: seal(key, { t, v, s: mine, x: Math.floor(Date.now() / 1000) + TTL }) });
    }
    if (req.method === "GET") {
      const p = open(key, (req.query && req.query.k) || "");
      if (!p || !(p.x > Math.floor(Date.now() / 1000)) || !Array.isArray(p.s)) return L.json(res, 404, { error: "bad_token" });
      const now = await currentSeats(p.t, p.v);
      const seats = p.s.filter((s) => now[s.n] !== undefined && now[s.n] === s.at).map((s) => s.n);
      return L.json(res, 200, { t: p.t, v: p.v, seats });
    }
    res.setHeader("Allow", "GET, POST");
    return L.json(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    return L.json(res, 502, { error: "storage_error" });
  }
};
