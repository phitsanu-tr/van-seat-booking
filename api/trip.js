// Vercel serverless function: /api/trip — every trip belongs to the signed-in LINE account that created it (trip.owner)
//   POST                 create a trip (signed in)        -> { id, trip }
//   GET  ?t= [&roster=1] read a trip for editing (owner)   -> { trip, booked, perVan, roster? }
//   PUT                  update a trip (owner, body has t)
//   DELETE ?t=           delete a trip and its bookings (owner)
// Co-organizers ("helpers", up to 3) join with the owner's invite link and can edit the trip and manage seats:
//   POST {t, invite: true | "revoke"}  owner: new invite code (7 days, one person) / cancel it
//   POST {join: code}                  signed in: become a helper of that trip
//   POST {t, removeHelper: i}          owner: remove helper #i      POST {t, leave: true}   helper: leave the trip
//   POST {t, transfer: i}              owner: helper #i becomes the owner, the old owner becomes a helper
// Closing bookings: POST {t, close: true | false} (owner or helper) closes / reopens at once; trip.closeAt closes it on time.
const L = require("./_lib");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const MAX_VANS = 5;           // vans per trip (a trip created earlier with more keeps its count when edited)
const TRIPS_PER_MONTH = 30; // per LINE account, calendar month in Thai time (UTC+7)

// Counts a creation against this month's quota for the account. Returns the error code when over the limit.
async function takeQuota(user) {
  const month = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
  const key = "quota:" + month + ":u:" + user.id;
  const out = await L.pipeline([["INCR", key], ["EXPIRE", key, String(40 * 86400)]]);
  if (Number(out[0]) > TRIPS_PER_MONTH) { try { await L.redis(["DECR", key]); } catch (e) { /* best effort */ } return "quota_month"; }
  return null;
}
async function refundQuota(user) {
  if (!user) return;
  const month = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
  try { await L.redis(["DECR", "quota:" + month + ":u:" + user.id]); } catch (e) { /* best effort */ }
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
  if (body.closeAt !== undefined) { // "" = no automatic closing
    const ca = s(body.closeAt, 16);
    if (ca && !L.CLOSE_AT_RE.test(ca)) return { error: "bad_close" };
    value.closeAt = ca;
  }
  if (body.closed !== undefined) value.closed = body.closed === true;
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

// The owner and helpers may read the edit view and change a trip; only the owner deletes it or manages helpers.
function isManager(trip, user) { return !!L.roleOf(trip, user); }
function isOwner(trip, user) { return L.roleOf(trip, user) === "owner"; }
function deny(res, user) { return user ? L.json(res, 403, { error: "not_owner" }) : L.json(res, 401, { error: "login_required" }); }
function tripSummary(trip, user) { return Object.assign(L.publicTrip(trip), { mine: isOwner(trip, user), role: L.roleOf(trip, user), closedNow: L.bookingClosed(trip) }); }
// what the managers see about the team: names only (account ids never leave the server)
function team(trip, user) {
  const role = L.roleOf(trip, user);
  const out = { role, ownerName: trip.ownerName || "", helpers: (trip.helpers || []).map((h, i) => ({ i, name: h.n || "", me: !!(user && h.u === user.id) })), max: L.MAX_HELPERS };
  if (role === "owner" && trip.invite && trip.invite.exp > Date.now()) out.invite = { code: trip.invite.c, exp: trip.invite.exp };
  return out;
}
async function saveTrip(trip) { await L.redis(["SET", L.tripKey(trip.id), JSON.stringify(trip)]); await L.applyExpiry(trip); } // SET clears the TTL
const INVITE_DAYS = 7;

module.exports = async function handler(req, res) {
  if (!L.REST_URL || !L.REST_TOKEN) return L.json(res, 500, { error: "not_configured" });
  try {
    const user = await L.currentUser(req);
    const pb = req.method === "POST" ? L.readBody(req) : {};
    if (req.method === "POST" && typeof pb.join === "string") {
      if (!user) return L.json(res, 401, { error: "login_required" });
      if (await L.rateLimited(req, user, "join", 20, 3600)) return L.json(res, 429, { error: "too_many" });
      const code = /^[a-z0-9]{10}$/.test(pb.join) ? pb.join : "";
      const t = code ? L.tripId(await L.redis(["GET", "inv:" + code])) : null;
      const trip = t ? await L.loadTrip(t) : null;
      if (!trip || !trip.invite || trip.invite.c !== code) return L.json(res, 404, { error: "bad_invite" });
      if (L.roleOf(trip, user)) return L.json(res, 200, { ok: true, id: t, name: trip.name, already: true });
      const helpers = Array.isArray(trip.helpers) ? trip.helpers.slice() : [];
      if (helpers.length >= L.MAX_HELPERS) return L.json(res, 409, { error: "helpers_full", max: L.MAX_HELPERS });
      helpers.push({ u: user.id, n: user.name, at: Date.now() });
      const next = Object.assign({}, trip, { helpers });
      delete next.invite; // one person per invite link: it stops working once used
      await L.redis(["DEL", "inv:" + code]);
      await saveTrip(next);
      await L.pipeline([["SADD", L.myTripsKey(user.id), t], ["EXPIRE", L.myTripsKey(user.id), String(L.MY_DAYS * 86400)]]);
      await L.logEvent(t, { e: "helper_join", n: user.name, u: user.id, at: Date.now() });
      await L.notify([trip.owner], { k: "helper_joined", t, tn: trip.name, n: user.name });
      return L.json(res, 200, { ok: true, id: t, name: trip.name });
    }
    if (req.method === "POST" && typeof pb.close === "boolean") {
      const t = L.tripId(pb.t);
      const trip = t ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      if (!isManager(trip, user)) return deny(res, user);
      const next = Object.assign({}, trip, { closed: pb.close, updatedAt: Date.now() });
      // reopening also drops a closing time that has already passed, otherwise it would stay closed
      if (!pb.close && next.closeAt && L.bookingClosed(Object.assign({}, next, { closed: false }))) next.closeAt = "";
      await saveTrip(next);
      await L.logEvent(t, { e: pb.close ? "close" : "reopen", n: user.name, u: user.id, by: L.roleOf(trip, user), at: Date.now() });
      return L.json(res, 200, { ok: true, closed: L.bookingClosed(next), trip: tripSummary(next, user) });
    }
    if (req.method === "POST" && (pb.invite !== undefined || pb.removeHelper !== undefined || pb.leave !== undefined || pb.transfer !== undefined)) {
      const t = L.tripId(pb.t);
      const trip = t ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      const role = L.roleOf(trip, user);
      if (!role) return deny(res, user);
      const helpers = Array.isArray(trip.helpers) ? trip.helpers.slice() : [];
      if (pb.leave === true) {
        if (role !== "helper") return L.json(res, 400, { error: "not_helper" });
        const next = Object.assign({}, trip, { helpers: helpers.filter((h) => h.u !== user.id) });
        await saveTrip(next); await L.redis(["SREM", L.myTripsKey(user.id), t]);
        await L.logEvent(t, { e: "helper_leave", n: user.name, u: user.id, at: Date.now() });
        return L.json(res, 200, { ok: true });
      }
      if (role !== "owner") return L.json(res, 403, { error: "owner_only" });
      if (pb.invite === "revoke" || pb.invite === true) {
        const cmds = [];
        if (trip.invite && trip.invite.c) cmds.push(["DEL", "inv:" + trip.invite.c]);
        const next = Object.assign({}, trip);
        if (pb.invite === true) {
          const code = L.newId(10), exp = Date.now() + INVITE_DAYS * 86400 * 1000;
          cmds.push(["SET", "inv:" + code, t, "EX", String(INVITE_DAYS * 86400)]);
          next.invite = { c: code, exp };
        } else delete next.invite;
        if (cmds.length) await L.pipeline(cmds);
        await saveTrip(next);
        return L.json(res, 200, Object.assign({ ok: true }, team(next, user)));
      }
      const i = Number(pb.removeHelper !== undefined ? pb.removeHelper : pb.transfer);
      if (!Number.isInteger(i) || i < 0 || i >= helpers.length) return L.json(res, 400, { error: "bad_helper" });
      const h = helpers[i];
      if (pb.removeHelper !== undefined) {
        helpers.splice(i, 1);
        const next = Object.assign({}, trip, { helpers });
        await saveTrip(next); await L.redis(["SREM", L.myTripsKey(h.u), t]);
        await L.logEvent(t, { e: "helper_remove", n: h.n, u: user.id, ou: h.u, at: Date.now() });
        await L.notify([h.u], { k: "removed_team", t, tn: trip.name });
        return L.json(res, 200, Object.assign({ ok: true }, team(next, user)));
      }
      // transfer: helper #i becomes the owner, the old owner stays on as a helper
      helpers.splice(i, 1, { u: trip.owner, n: trip.ownerName || "", at: Date.now() });
      const next = Object.assign({}, trip, { owner: h.u, ownerName: h.n, helpers });
      delete next.invite;
      if (trip.invite && trip.invite.c) { try { await L.redis(["DEL", "inv:" + trip.invite.c]); } catch (e) { /* best effort */ } }
      await saveTrip(next);
      await L.logEvent(t, { e: "transfer", n: h.n, u: user.id, ou: h.u, at: Date.now() });
      await L.notify([h.u], { k: "became_owner", t, tn: trip.name, n: trip.ownerName || "" });
      return L.json(res, 200, Object.assign({ ok: true }, team(next, user)));
    }
    if (req.method === "POST") {
      if (!user) return L.json(res, 401, { error: "login_required" }); // a trip always has an owner account
      const c = clean(L.readBody(req));
      if (c.error) return L.json(res, 400, { error: c.error });
      const over = await takeQuota(user);
      if (over) return L.json(res, 429, { error: over, limit: TRIPS_PER_MONTH });
      const id = L.newId(8);
      const now = Date.now();
      const trip = Object.assign({ id, schemaVersion: 1, createdAt: now, updatedAt: now, owner: user.id, ownerName: user.name }, c.value);
      trip.vans = assignVanIds(trip.vans, []);
      const ok = await L.redis(["SET", L.tripKey(id), JSON.stringify(trip), "NX"]);
      if (ok !== "OK") { await refundQuota(user); return L.json(res, 502, { error: "storage_error" }); }
      await L.applyExpiry(trip);
      { try { await L.pipeline([["SADD", L.myTripsKey(user.id), id], ["EXPIRE", L.myTripsKey(user.id), String(L.MY_DAYS * 86400)]]); } catch (e) { /* best effort */ } }
      return L.json(res, 200, { id, trip: tripSummary(trip, user) });
    }

    if (req.method === "GET") {
      const t = L.tripId(req.query && req.query.t);
      const trip = t ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      if (!isManager(trip, user)) return deny(res, user);
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
            try { const r = JSON.parse(flat[j + 1]); if (r && r.name) seats[n] = Object.assign({ name: String(r.name), at: r.at }, r.u ? { a: 1 } : {}, user && r.u === user.id ? { m: 1 } : {}, r.p ? { p: 1 } : {}, r.c ? { c: r.c } : {}); /* p = paid, c = boarded (organizers only) */ } catch (e) { /* skip */ }
          }
          roster[v.id] = seats;
        });
      }
      return L.json(res, 200, { trip: tripSummary(trip, user), booked, perVan, roster, ended: L.tripEnded(trip), team: team(trip, user) });
    }

    if (req.method === "DELETE") {
      const t = L.tripId(req.query && req.query.t);
      const trip = t ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      if (!isOwner(trip, user)) return isManager(trip, user) ? L.json(res, 403, { error: "owner_only" }) : deny(res, user);
      const bookers = await L.tripBookers(trip); // read before the seats are gone
      const cmds = [["DEL", L.tripKey(t)], ["DEL", L.logKey(t)]];
      if (trip.owner) cmds.push(["SREM", L.myTripsKey(trip.owner), t]);
      (trip.helpers || []).forEach((h) => cmds.push(["SREM", L.myTripsKey(h.u), t]));
      if (trip.invite && trip.invite.c) cmds.push(["DEL", "inv:" + trip.invite.c]);
      trip.vans.forEach((v) => cmds.push(["DEL", L.seatsKey(t, v.id)]));
      await L.pipeline(cmds);
      await L.notify([].concat(...Object.values(bookers), L.teamIds(trip)), { k: "trip_deleted", t, tn: trip.name, by: "owner" }, user.id);
      return L.json(res, 200, { ok: true });
    }

    if (req.method === "PUT") {
      const body = L.readBody(req);
      const t = L.tripId(body.t);
      const trip = t ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      if (!isManager(trip, user)) return deny(res, user);
      const c = clean(body, trip.vans.length);
      if (c.error) return L.json(res, 400, { error: c.error });
      const oldIds = trip.vans.map((v) => v.id);
      const next = assignVanIds(c.value.vans.map((v) => ({ id: oldIds.includes(v.id) ? v.id : "", label: v.label, plate: v.plate })), oldIds);
      const kept = new Set(next.map((v) => v.id));
      const removed = oldIds.filter((id) => !kept.has(id));
      const updated = Object.assign({}, trip, c.value, { vans: next, schemaVersion: 1, updatedAt: Date.now() });
      const bookers = await L.tripBookers(trip); // before removed vans lose their seats
      const cmds = [["SET", L.tripKey(t), JSON.stringify(updated)]];
      removed.forEach((id) => cmds.push(["DEL", L.seatsKey(t, id)]));
      await L.pipeline(cmds);
      await L.applyExpiry(updated); // SET cleared the TTL; dates may have changed
      // notifications: what passengers care about (name, dates, departure, meeting point) and removed vans
      const by = L.roleOf(trip, user), ch = [];
      if ((trip.name || "") !== (updated.name || "")) ch.push({ f: "name", o: trip.name || "", n: updated.name || "" });
      if ((trip.startDate || "") !== (updated.startDate || "") || (trip.endDate || "") !== (updated.endDate || "")) ch.push({ f: "date", o: [trip.startDate || "", trip.endDate || ""], n: [updated.startDate || "", updated.endDate || ""] });
      if ((trip.departTime || "") !== (updated.departTime || "")) ch.push({ f: "time", o: trip.departTime || "", n: updated.departTime || "" });
      if ((trip.meetPoint || "") !== (updated.meetPoint || "")) ch.push({ f: "meet", o: trip.meetPoint || "", n: updated.meetPoint || "" });
      const gone = new Set();
      removed.forEach((id) => { (bookers[id] || []).forEach((u) => gone.add(u)); });
      if (gone.size) await L.notify(Array.from(gone), { k: "van_removed", t, tn: updated.name, vl: L.vanLabel(trip, removed[0]), by }, user.id);
      if (ch.length) await L.notify([].concat(...next.map((v) => bookers[v.id] || []), L.teamIds(updated)), { k: "trip_changed", t, tn: updated.name, ch, by }, user.id);
      return L.json(res, 200, { ok: true, trip: tripSummary(updated, user) });
    }

    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return L.json(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    return L.json(res, 502, { error: "storage_error" });
  }
};
