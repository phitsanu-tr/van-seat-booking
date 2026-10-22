// Vercel serverless function: /api/mark   (carries "which seats are mine" to the picture page opened outside LINE)
//   POST {t, v, seats:[{seat, at}]}  -> {k}      the server checks each seat really is booked with that timestamp, stores the
//                                                 result under a random 10-character code for 15 minutes (Redis deletes it itself)
//   GET  ?k=code                     -> {t, v, seats:[n]}   only for a live code whose seats are still booked
// The link carries nothing but the random code. It only drives the green highlight in the picture and never grants
// any right to cancel or change a booking.
const L = require("./_lib");

const TTL = 15 * 60; // seconds
const ID_RE = /^[a-z0-9]{10}$/;
const markKey = (id) => "mark:" + id;

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
  if (!L.REST_URL || !L.REST_TOKEN) return L.json(res, 404, { error: "not_configured" });
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
      const id = L.newId(10);
      await L.redis(["SET", markKey(id), JSON.stringify({ t, v, s: mine }), "EX", String(TTL)]);
      return L.json(res, 200, { k: id });
    }
    if (req.method === "GET") {
      const id = String((req.query && req.query.k) || "");
      if (!ID_RE.test(id)) return L.json(res, 404, { error: "bad_token" });
      let p = null;
      try { p = JSON.parse(await L.redis(["GET", markKey(id)])); } catch (e) { p = null; }
      if (!p || !Array.isArray(p.s)) return L.json(res, 404, { error: "bad_token" });
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
