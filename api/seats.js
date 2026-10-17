// Vercel serverless function: GET / POST / DELETE /api/seats
// Query / body: t = trip code (default "default"), v = van id (default: the trip's first van).
// Storage: one Redis hash per van (field = seat number, value = JSON {name, at}).
const L = require("./_lib");

module.exports = async function handler(req, res) {
  if (!L.REST_URL || !L.REST_TOKEN) return L.json(res, 500, { error: "not_configured" });

  try {
    const body = req.method === "GET" ? {} : L.readBody(req);
    const t = L.tripId((req.query && req.query.t) || body.t);
    if (!t) return L.json(res, 404, { error: "no_trip" });
    const trip = await L.loadTrip(t);
    if (!trip) return L.json(res, 404, { error: "no_trip" });
    const wanted = String((req.query && req.query.v) || body.v || trip.vans[0].id);
    const van = trip.vans.find((x) => x.id === wanted);
    if (!van) return L.json(res, 404, { error: "no_van" });
    const key = L.seatsKey(t, van.id);

    if (req.method === "GET") {
      const cmds = [["HGETALL", key]].concat(trip.vans.map((x) => ["HLEN", L.seatsKey(t, x.id)]));
      const out = await L.pipeline(cmds);
      const flat = out[0] || [];
      const seats = {};
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const n = L.parseSeat(flat[i]);
        if (n === null) continue;
        try {
          const v = JSON.parse(flat[i + 1]);
          if (v && v.name) seats[n] = { name: String(v.name), at: v.at };
        } catch (e) { /* skip a damaged entry */ }
      }
      const counts = {};
      trip.vans.forEach((x, i) => { counts[x.id] = Number(out[i + 1]) || 0; });
      return L.json(res, 200, { trip: L.publicTrip(trip), van: van.id, seats, counts });
    }

    if (req.method === "POST") {
      const seat = L.parseSeat(body.seat);
      const name = String(body.name || "").trim().slice(0, 30);
      if (seat === null) return L.json(res, 400, { error: "bad_seat" });
      if (!name) return L.json(res, 400, { error: "bad_name" });
      const at = Date.now();
      // HSETNX only writes when the seat is still empty, so two people can never take the same seat.
      const created = await L.redis(["HSETNX", key, String(seat), JSON.stringify({ name, at })]);
      if (created !== 1) return L.json(res, 409, { error: "taken" });
      return L.json(res, 200, { ok: true, at });
    }

    if (req.method === "DELETE") {
      const seat = L.parseSeat(body.seat);
      if (seat === null) return L.json(res, 400, { error: "bad_seat" });
      await L.redis(["HDEL", key, String(seat)]);
      return L.json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return L.json(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    return L.json(res, 502, { error: "storage_error" });
  }
};
