// Vercel serverless function: GET /api/me — the signed-in person's own trips (as organizer) and seats (as passenger).
// Index sets: mytrips:<uid> = trip ids, myseats:<uid> = "trip|van|seat". Entries that no longer match are dropped here.
const L = require("./_lib");
const MAX = 60;

function summary(trip, perVan) {
  const booked = trip.vans.reduce((a, v) => a + (perVan[v.id] || 0), 0);
  return {
    id: trip.id, name: trip.name, organizer: trip.organizer || "", startDate: trip.startDate || "", endDate: trip.endDate || "",
    departTime: trip.departTime || "", meetPoint: trip.meetPoint || "", vans: trip.vans.length, booked, total: trip.vans.length * L.TOTAL_SEATS,
    ended: L.tripEnded(trip),
  };
}

module.exports = async function handler(req, res) {
  if (!L.REST_URL || !L.REST_TOKEN) return L.json(res, 500, { error: "not_configured" });
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return L.json(res, 405, { error: "method_not_allowed" }); }
  try {
    const user = await L.currentUser(req);
    if (!user) return L.json(res, 401, { error: "login_required" });
    const [tripIds, seatRefs] = await L.pipeline([["SMEMBERS", L.myTripsKey(user.id)], ["SMEMBERS", L.mySeatsKey(user.id)]]);
    const refs = (seatRefs || []).map((r) => String(r).split("|")).filter((p) => p.length === 3 && L.tripId(p[0]) && L.parseSeat(p[2]) !== null).slice(0, MAX);
    const ids = Array.from(new Set((tripIds || []).map(String).filter((x) => L.tripId(x)).slice(0, MAX).concat(refs.map((p) => p[0]))));
    const raws = ids.length ? await L.pipeline(ids.map((id) => ["GET", L.tripKey(id)])) : [];
    const trips = {};
    ids.forEach((id, i) => { try { if (raws[i]) trips[id] = JSON.parse(raws[i]); } catch (e) { /* skip */ } });

    // seat counts for my trips + the seat records I booked, in one round trip
    const owned = (tripIds || []).map(String).filter((id) => trips[id] && trips[id].owner === user.id);
    const cmds = [], map = [];
    owned.forEach((id) => trips[id].vans.forEach((v) => { cmds.push(["HLEN", L.seatsKey(id, v.id)]); map.push(["n", id, v.id]); }));
    refs.forEach((p) => { if (trips[p[0]]) { cmds.push(["HGET", L.seatsKey(p[0], p[1]), p[2]]); map.push(["s", p]); } });
    const out = cmds.length ? await L.pipeline(cmds) : [];
    const perVan = {}, mine = {}, stale = [];
    map.forEach((m, i) => {
      if (m[0] === "n") { (perVan[m[1]] = perVan[m[1]] || {})[m[2]] = Number(out[i]) || 0; return; }
      const p = m[1];
      let rec = null;
      try { rec = JSON.parse(out[i]); } catch (e) { rec = null; }
      if (!rec || rec.u !== user.id) { stale.push(p.join("|")); return; }
      (mine[p[0]] = mine[p[0]] || []).push({ v: p[1], s: Number(p[2]), name: String(rec.name || ""), at: rec.at });
    });
    refs.forEach((p) => { if (!trips[p[0]]) stale.push(p.join("|")); });
    const goneTrips = (tripIds || []).map(String).filter((id) => !trips[id] || trips[id].owner !== user.id);
    const clean = [];
    if (stale.length) clean.push(["SREM", L.mySeatsKey(user.id)].concat(stale));
    if (goneTrips.length) clean.push(["SREM", L.myTripsKey(user.id)].concat(goneTrips));
    if (clean.length) { try { await L.pipeline(clean); } catch (e) { /* best effort */ } }

    const myTrips = owned.map((id) => summary(trips[id], perVan[id] || {}));
    const mySeats = Object.keys(mine).map((id) => {
      const t = trips[id];
      const list = mine[id].sort((a, b) => a.s - b.s).map((x) => {
        const van = t.vans.find((v) => v.id === x.v);
        return { van: x.v, vanLabel: van ? van.label : x.v, plate: van && van.plate ? van.plate : "", seat: x.s, name: x.name, at: x.at };
      });
      return Object.assign(summary(t, {}), { seats: list });
    });
    const byDate = (a, b) => (a.ended - b.ended) || String(a.startDate || "9").localeCompare(String(b.startDate || "9"));
    myTrips.sort(byDate); mySeats.sort(byDate);
    return L.json(res, 200, { user: L.publicUser(user), trips: myTrips, seats: mySeats });
  } catch (e) {
    return L.json(res, 502, { error: "storage_error" });
  }
};
