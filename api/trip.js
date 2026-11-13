// Vercel serverless function: /api/trip — every trip belongs to the signed-in LINE account that created it (trip.owner)
//   POST                 create a trip (signed in)        -> { id, trip }
//   GET  ?t= [&roster=1] read a trip for editing (owner)   -> { trip, booked, perVan, roster? }
//   PUT                  update a trip (owner, body has t)
//   DELETE ?t=           delete a trip and its bookings (owner)
// Co-organizers ("helpers", up to 2) join with the owner's invite link and can edit the trip and manage seats:
//   POST {t, invite: true | "revoke"}  owner: new invite code (7 days, one person) / cancel it
//   POST {join: code}                  signed in: become a helper of that trip
//   POST {t, removeHelper: i}          owner: remove helper #i      POST {t, leave: true}   helper: leave the trip
//   POST {t, transfer: i}              owner: helper #i becomes the owner, the old owner becomes a helper
// Closing bookings: POST {t, close: true | false} (owner or helper) closes / reopens at once; trip.closeAt closes it on time.
// Packages (api/_plans.js): the owner's package limits open trips, vans, helpers and check-in rounds; POST {..., usePass: true}
//   on create spends a per-trip pass (Standard limits for that trip); POST {t, usePass: true} upgrades an existing trip.
// Check-in rounds: POST {t, resetBoard: true, name?} (owner or helper) saves a summary of the current round and clears every
//   boarded tick for the next one (e.g. the way back); POST {t, boardName} renames the current round. Passengers never see trip.board.
const L = require("./_lib");
const P = require("./_plans");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const MAX_VANS = 5;           // vans per trip (a trip created earlier with more keeps its count when edited)

// Counts a creation against this month's trips for the account (cap: the package's trips a month, or 30 while packages
// are off). Returns null, or the month counted in, plus the error when over.
async function takeQuota(user, cap) {
  const month = P.monthNow(), key = P.quotaKey(user.id, month);
  const out = await L.pipeline([["INCR", key], ["EXPIRE", key, String(40 * 86400)]]);
  if (Number(out[0]) > cap) { try { await L.redis(["DECR", key]); } catch (e) { /* best effort */ } return { over: true, month }; }
  return { over: false, month };
}
async function refundQuota(user, month) {
  if (!user) return;
  try { await L.redis(["DECR", P.quotaKey(user.id, month)]); } catch (e) { /* best effort */ }
}

// text limits (characters, Thai vowels/tone marks count): a trip saved before these limits keeps its longer text until that field is edited
const LIM = { name: 60, organizer: 60, meetPoint: 60, label: 4, plate: 25 };
function clean(body, vanCap, planVans, prev) {
  const s = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const keep = (v, n, old) => { const t = String(v == null ? "" : v).trim(); return old && t === old ? t : t.slice(0, n); };
  const oldVan = (id) => ((prev && prev.vans) || []).find((x) => id && x.id === id) || {};
  const name = keep(body.name, LIM.name, prev && prev.name);
  if (!name) return { error: "bad_name" };
  const startDate = s(body.startDate, 10), endDate = s(body.endDate, 10), departTime = s(body.departTime, 5);
  if (startDate && !DATE_RE.test(startDate)) return { error: "bad_date" };
  if (endDate && !DATE_RE.test(endDate)) return { error: "bad_date" };
  if (departTime && !TIME_RE.test(departTime)) return { error: "bad_time" };
  const returnTime = s(body.returnTime, 5); // optional: when the van leaves for home
  if (returnTime && !TIME_RE.test(returnTime)) return { error: "bad_time" };
  const vans = Array.isArray(body.vans) ? body.vans : [];
  if (vans.length < 1) return { error: "bad_vans" };
  if (vans.length > Math.max(planVans || MAX_VANS, vanCap || 0)) return { error: planVans ? "plan_vans" : "bad_vans", limit: planVans || MAX_VANS };
  const seen = new Set();
  const outVans = [];
  for (const v of vans) {
    const ov = oldVan(String((v && v.id) || ""));
    const label = keep(v && v.label, LIM.label, ov.label);
    if (!label) return { error: "bad_vans" };
    const id = s(v && v.id, 12);
    if (id && (seen.has(id) || !/^[A-Za-z0-9]+$/.test(id))) return { error: "bad_vans" };
    if (id) seen.add(id);
    const plate = keep(v && v.plate, LIM.plate, ov.plate);
    outVans.push(plate ? { id, label, plate } : { id, label });
  }
  const meetPoint = keep(body.meetPoint, LIM.meetPoint, prev && prev.meetPoint);
  if (!meetPoint && !(prev && !prev.meetPoint)) return { error: "bad_meet" }; // required (an old trip saved without one may stay without)
  const value = { name, organizer: keep(body.organizer, LIM.organizer, prev && prev.organizer), startDate, endDate, departTime, returnTime, meetPoint, vans: outVans };
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
  value.staffSeat = body.staffSeat === undefined ? !!(prev && prev.staffSeat) : body.staffSeat === true; // seat 1 of every van kept for the organizer team
  const sn = body.staffName === undefined ? (prev && prev.staffName) : body.staffName;
  value.staffName = STAFF_NAMES.includes(sn) ? sn : "STAFF"; // the name shown on those seats
  return { value };
}

// "สงวนที่นั่ง 1 สำหรับผู้จัด": books seat 1 as STAFF in the owner's name (not in their "my seats" list); a seat someone
// already booked is left alone. Returns the labels of the vans where seat 1 was taken.
const STAFF_NAMES = ["STAFF", "ไกด์", "ผู้จัด"];
async function reserveStaff(trip, vanIds) {
  if (!vanIds.length) return [];
  const nm = trip.staffName || "STAFF", at = Date.now(), rec = JSON.stringify({ name: nm, at, u: trip.owner, ln: trip.ownerName || "", lp: "", st: 1, sn: nm }); // sn: the name the app gave it
  const out = await L.pipeline(vanIds.map((id) => ["HSETNX", L.seatsKey(trip.id, id), "1", rec]));
  const skipped = [];
  for (let i = 0; i < vanIds.length; i++) {
    if (Number(out[i]) === 1) await L.logEvent(trip.id, { e: "book", v: vanIds[i], s: 1, n: nm, u: trip.owner, at });
    else skipped.push(L.vanLabel(trip, vanIds[i]));
  }
  return skipped;
}
// the seat-1 records the app made and nobody renamed since
function appStaff(r) { return !!(r && r.st === 1 && r.name === (r.sn || "STAFF")); }
// A new name chosen while it stays on: rename those seats too.
async function renameStaff(trip) {
  const ids = trip.vans.map((v) => v.id), nm = trip.staffName || "STAFF";
  const got = await L.pipeline(ids.map((id) => ["HGET", L.seatsKey(trip.id, id), "1"]));
  const cmds = [];
  ids.forEach((id, i) => { let r = null; try { r = JSON.parse(got[i]); } catch (e) { /* empty */ } if (appStaff(r) && r.name !== nm) cmds.push(["HSET", L.seatsKey(trip.id, id), "1", JSON.stringify(Object.assign(r, { name: nm, sn: nm }))]); });
  if (cmds.length) await L.pipeline(cmds);
}
// vans whose seat 1 is no longer held for the team (cancelled on the booking page, or booked by someone)
async function staffGaps(trip) {
  const got = await L.pipeline(trip.vans.map((v) => ["HGET", L.seatsKey(trip.id, v.id), "1"]));
  return trip.vans.filter((v, i) => { let r = null; try { r = JSON.parse(got[i]); } catch (e) { /* empty */ } return !(r && r.st === 1); });
}
// Turning it off frees only the seats the app made that nobody renamed.
async function releaseStaff(trip) {
  const ids = trip.vans.map((v) => v.id);
  const got = await L.pipeline(ids.map((id) => ["HGET", L.seatsKey(trip.id, id), "1"]));
  for (let i = 0; i < ids.length; i++) {
    let r = null; try { r = JSON.parse(got[i]); } catch (e) { /* empty or damaged */ }
    if (appStaff(r)) {
      if (Number(await L.redis(["HDEL", L.seatsKey(trip.id, ids[i]), "1"])) === 1) await L.logEvent(trip.id, { e: "cancel", v: ids[i], s: 1, n: r.name, u: trip.owner, at: Date.now() });
    }
  }
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
async function limitsOf(trip) { return P.limitsFor(trip && trip.owner ? await P.getPlan(trip.owner) : null, trip); } // the owner's package decides
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
// the organizer's passenger list of one trip (no account ids), from the HGETALL of each van in trip.vans order
function rosterPayload(trip, user, all) {
  const roster = {}, perVan = {};
  let booked = 0;
  trip.vans.forEach((v, i) => {
    const flat = all[i] || [], seats = {};
    for (let j = 0; j + 1 < flat.length; j += 2) {
      const n = L.parseSeat(flat[j]); if (n === null) continue;
      try { const r = JSON.parse(flat[j + 1]); if (r && r.name) seats[n] = Object.assign({ name: String(r.name), at: r.at }, r.u ? { a: 1 } : {}, user && r.u === user.id ? { m: 1 } : {}, r.c ? { c: r.c } : {}, r.c && r.cb ? { cb: r.cb } : {}, r.nt ? { nt: String(r.nt) } : {}); /* c = boarded, cb = ticked by (organizers only) */ } catch (e) { /* skip */ }
    }
    roster[v.id] = seats; perVan[v.id] = Math.floor(flat.length / 2); booked += perVan[v.id];
  });
  return { trip: tripSummary(trip, user), booked, perVan, roster, board: trip.board || null, ended: L.tripEnded(trip), team: team(trip, user) };
}
function roundName(v) { return String(v == null ? "" : v).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 24); } // check-in round label, e.g. "เที่ยวกลับ"

module.exports = async function handler(req, res) {
  if (!L.REST_URL || !L.REST_TOKEN) return L.json(res, 500, { error: "not_configured" });
  if (L.crossSite(req)) return L.json(res, 403, { error: "cross_site" });
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
      const hl = (await limitsOf(trip)).helpers;
      if (helpers.length >= hl) return L.json(res, 409, { error: hl < L.MAX_HELPERS || hl === 0 ? "plan_helpers" : "helpers_full", max: hl });
      try { await P.getPlan(user.id); } catch (e) { /* best effort */ } // records "free" first, so joining a team never looks like an old organizer (launch gift)
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
    if (req.method === "POST" && (pb.resetBoard === true || typeof pb.boardName === "string")) {
      // check-in rounds (trip.board = { cur: {i, name, at, by}, hist: [summary of each earlier round] }), organizers only
      const t = L.tripId(pb.t);
      const trip = t ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      if (!isManager(trip, user)) return deny(res, user);
      if (L.tripEnded(trip)) return L.json(res, 403, { error: "ended" });
      const board = Object.assign({ cur: { i: 1, name: "", at: 0, by: "" }, hist: [] }, trip.board || {});
      if (pb.resetBoard === true) { const rl = (await limitsOf(trip)).rounds; if (rl && board.cur.i >= rl) return L.json(res, 402, { error: "plan_rounds", limit: rl }); }
      if (pb.resetBoard !== true) { // rename the current round
        const next = Object.assign({}, trip, { board: Object.assign({}, board, { cur: Object.assign({}, board.cur, { name: roundName(pb.boardName) }) }) });
        await saveTrip(next);
        return L.json(res, 200, { ok: true, board: next.board });
      }
      // start a new round: sum up the current one (who was missing at this moment), then clear every tick
      const all = await L.pipeline(trip.vans.map((v) => ["HGETALL", L.seatsKey(t, v.id)]));
      const clears = [], miss = [];
      let total = 0, inN = 0, first = 0, last = 0;
      const checkers = []; // who ticked people in this round (round 1 has no one who "started" it)
      trip.vans.forEach((v, i) => {
        const flat = all[i] || [];
        for (let j = 0; j + 1 < flat.length; j += 2) {
          let r = null; try { r = JSON.parse(flat[j + 1]); } catch (e) { r = null; }
          if (!r || !r.name) continue;
          total++;
          if (r.c) { inN++; first = first ? Math.min(first, r.c) : r.c; last = Math.max(last, r.c); if (r.cb && checkers.indexOf(r.cb) < 0) checkers.push(r.cb); delete r.c; delete r.cb; clears.push({ key: L.seatsKey(t, v.id), field: flat[j], expect: flat[j + 1], value: JSON.stringify(r) }); }
          else miss.push({ vl: v.label, s: Number(flat[j]), n: String(r.name) });
        }
      });
      miss.sort((a, b) => (a.vl === b.vl ? a.s - b.s : String(a.vl).localeCompare(String(b.vl))));
      const done = { i: board.cur.i, name: board.cur.name || "", start: board.cur.at || first, end: last, by: board.cur.by || checkers.slice(0, 3).join(", "), n: inN, total, miss: miss.slice(0, 40) };
      const hist = [done].concat(board.hist || []).slice(0, 20); // newest first, at most 20 rounds
      const next = Object.assign({}, trip, { board: { cur: { i: board.cur.i + 1, name: roundName(pb.name), at: Date.now(), by: user.name }, hist } });
      // clear each tick only if that seat is unchanged since it was read: a seat cancelled meanwhile must not come back
      for (const c of clears) { try { await L.hcas([c]); } catch (e) { /* best effort per seat */ } }
      await saveTrip(next);
      await L.logEvent(t, { e: "board_reset", n: user.name, u: user.id, by: L.roleOf(trip, user), at: Date.now() });
      return L.json(res, 200, { ok: true, board: next.board });
    }
    if (req.method === "POST" && pb.staffRestore === true) { // "สงวนคืน": hold seat 1 again where it is still free
      const t = L.tripId(pb.t);
      const trip = t ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      if (!isManager(trip, user)) return deny(res, user);
      if (!trip.staffSeat) return L.json(res, 400, { error: "staff_off" });
      const taken = await reserveStaff(trip, (await staffGaps(trip)).map((v) => v.id));
      return L.json(res, 200, { ok: true, taken, gaps: (await staffGaps(trip)).map((v) => v.label) });
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
    if (req.method === "POST" && pb.usePass === true && pb.t !== undefined) { // spend a pass on an existing trip
      const t = L.tripId(pb.t);
      const trip = t ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      if (!isOwner(trip, user)) return isManager(trip, user) ? L.json(res, 403, { error: "owner_only" }) : deny(res, user);
      if (trip.plus) return L.json(res, 200, { ok: true, already: true, limits: await limitsOf(trip) });
      if (!(await P.getPlan(user.id)).on) return L.json(res, 403, { error: "plans_off" });
      if (!(await P.usePass(user.id))) return L.json(res, 402, { error: "no_pass" });
      const next = Object.assign({}, trip, { plus: true, updatedAt: Date.now() });
      await saveTrip(next);
      return L.json(res, 200, { ok: true, limits: await limitsOf(next), trip: tripSummary(next, user) });
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
      if (pb.invite === true) { const hl = (await limitsOf(trip)).helpers; if (!hl || helpers.length >= hl) return L.json(res, 402, { error: "plan_helpers", max: hl }); }
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
      // retry of the same create (reply lost on a bad connection): hand back the trip already made, no second trip or quota
      const ck = typeof pb.ck === "string" && /^[A-Za-z0-9]{12,32}$/.test(pb.ck) ? "ck:" + user.id + ":" + pb.ck : "";
      if (ck) {
        const prevId = await L.redis(["GET", ck]);
        if (prevId) { const pt = await L.loadTrip(String(prevId)); if (pt && pt.owner === user.id) return L.json(res, 200, { id: pt.id, trip: tripSummary(pt, user) }); }
      }
      const plan = await P.getPlan(user.id);
      let plus = false;
      const lim0 = P.limitsFor(plan, null);
      const vl = P.limitsFor(plan, pb.usePass === true && lim0.on ? { plus: true } : null);
      const c = clean(pb, 0, vl.on ? vl.vans : 0);
      if (c.error) return L.json(res, c.error === "plan_vans" ? 402 : 400, { error: c.error, limit: c.limit });
      { const mx = pb.usePass === true ? "" : P.horizon(plan); if (mx && c.value.startDate > mx) return L.json(res, 402, { error: "plan_date", max: mx, passes: plan.passes, tier: plan.tier }); }
      if (lim0.on && pb.usePass === true) { if (!(await P.usePass(user.id))) return L.json(res, 402, { error: "no_pass" }); plus = true; }
      let qm = "";
      if (!plus) { // a trip on a pass doesn't count toward the month
        const cap = P.monthCap(lim0), q = await takeQuota(user, cap);
        if (q.over) return lim0.on && lim0.trips ? L.json(res, 402, { error: "plan_trips", limit: lim0.trips, passes: plan.passes, tier: plan.tier }) : L.json(res, 429, { error: "quota_month", limit: cap });
        qm = q.month;
      }
      const id = L.newId(8);
      const now = Date.now();
      const trip = Object.assign({ id, schemaVersion: 1, createdAt: now, updatedAt: now, owner: user.id, ownerName: user.name }, c.value, plus ? { plus: true } : {}, qm ? { qm } : {}, !plus && P.horizon(plan) ? { hz: P.horizon(plan) } : {});
      trip.vans = assignVanIds(trip.vans, []);
      const ok = await L.redis(["SET", L.tripKey(id), JSON.stringify(trip), "NX"]);
      if (ok !== "OK") { if (qm) await refundQuota(user, qm); if (plus) await P.refundPass(user.id); return L.json(res, 502, { error: "storage_error" }); }
      if (trip.staffSeat) { try { await reserveStaff(trip, trip.vans.map((v) => v.id)); } catch (e) { /* the trip exists; seats can be booked by hand */ } }
      await L.applyExpiry(trip); // after the STAFF seats so their van lists get the trip's expiry too
      if (ck) { try { await L.redis(["SET", ck, id, "EX", "86400"]); } catch (e) { /* best effort */ } }
      L.bump(plus ? "trip_pass" : "trip_new");
      { try { await L.pipeline([["SADD", L.myTripsKey(user.id), id], ["EXPIRE", L.myTripsKey(user.id), String(L.MY_DAYS * 86400)]]); } catch (e) { /* best effort */ } }
      return L.json(res, 200, { id, trip: tripSummary(trip, user) });
    }

    if (req.method === "GET" && req.query && typeof req.query.many === "string") {
      // several passenger lists in one request (the my-trips page loads them in the background); only trips you organize
      const ids = Array.from(new Set(req.query.many.split(",").map((x) => L.tripId(x)).filter(Boolean))).slice(0, 12);
      if (!user) return L.json(res, 401, { error: "login_required" });
      const raws = ids.length ? await L.pipeline(ids.map((id) => ["GET", L.tripKey(id)])) : [];
      const trips = [];
      raws.forEach((raw) => { let tr = null; try { tr = JSON.parse(raw); } catch (e) { tr = null; } if (tr && tr.id && isManager(tr, user)) trips.push(tr); });
      const cmds = [];
      trips.forEach((tr) => tr.vans.forEach((v) => cmds.push(["HGETALL", L.seatsKey(tr.id, v.id)])));
      const all = cmds.length ? await L.pipeline(cmds) : [];
      const out = {};
      let k = 0;
      trips.forEach((tr) => { out[tr.id] = rosterPayload(tr, user, all.slice(k, k + tr.vans.length)); k += tr.vans.length; });
      return L.json(res, 200, { rosters: out });
    }
    if (req.method === "GET") {
      const t = L.tripId(req.query && req.query.t);
      const trip = t ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      if (!isManager(trip, user)) return deny(res, user);
      const wantRoster = req.query.roster !== undefined;
      // one round trip: the roster's HGETALL also gives the counts (HLEN only when no roster is asked for)
      const all = await L.pipeline(trip.vans.map((v) => [wantRoster ? "HGETALL" : "HLEN", L.seatsKey(t, v.id)]));
      const counts = all.map((x) => (wantRoster ? Math.floor(((x || []).length) / 2) : Number(x) || 0));
      const perVan = {};
      trip.vans.forEach((v, i) => { perVan[v.id] = counts[i]; });
      const booked = counts.reduce((a, n) => a + n, 0);
      let roster;
      const limits = await limitsOf(trip);
      const tm = Object.assign(team(trip, user), { max: limits.helpers });
      if (wantRoster) return L.json(res, 200, Object.assign(rosterPayload(trip, user, all), { limits, team: tm }));
      const staffGap = trip.staffSeat ? (await staffGaps(trip)).map((v) => v.label) : undefined;
      return L.json(res, 200, { trip: tripSummary(trip, user), booked, perVan, roster, ended: L.tripEnded(trip), team: tm, limits, staffGaps: staffGap });
    }

    if (req.method === "DELETE") {
      const t = L.tripId(req.query && req.query.t);
      const trip = t ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      if (!isOwner(trip, user)) return isManager(trip, user) ? L.json(res, 403, { error: "owner_only" }) : deny(res, user);
      const bookers = await L.tripBookers(trip); // read before the seats are gone
      // made by mistake (deleted within a day, nobody booked): the month's trip is given back
      let refunded = false;
      if (trip.qm && !trip.plus && Date.now() - (trip.createdAt || 0) < P.REFUND_HOURS * 3600 * 1000) {
        const lens = await L.pipeline(trip.vans.map((v) => ["HLEN", L.seatsKey(t, v.id)]));
        if (lens.every((n) => !Number(n))) { await refundQuota({ id: trip.owner }, trip.qm); refunded = true; }
      }
      const cmds = [["DEL", L.tripKey(t)], ["DEL", L.logKey(t)]];
      if (trip.owner) cmds.push(["SREM", L.myTripsKey(trip.owner), t]);
      (trip.helpers || []).forEach((h) => cmds.push(["SREM", L.myTripsKey(h.u), t]));
      if (trip.invite && trip.invite.c) cmds.push(["DEL", "inv:" + trip.invite.c]);
      trip.vans.forEach((v) => cmds.push(["DEL", L.seatsKey(t, v.id)]));
      await L.pipeline(cmds);
      await L.notify([].concat(...Object.values(bookers), L.teamIds(trip)), { k: "trip_deleted", t, tn: trip.name, by: "owner" }, user.id);
      return L.json(res, 200, { ok: true, refunded });
    }

    if (req.method === "PUT") {
      const body = L.readBody(req);
      const t = L.tripId(body.t);
      const trip = t ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      if (!isManager(trip, user)) return deny(res, user);
      if (body.rev !== undefined && Number(body.rev) !== (trip.rev || 0)) return L.json(res, 409, { error: "stale" }); // another organizer saved this trip after the form was opened
      const lt = await limitsOf(trip);
      const c = clean(body, trip.vans.length, lt.on ? lt.vans : 0, trip);
      if (c.error) return L.json(res, c.error === "plan_vans" ? 402 : 400, { error: c.error, limit: c.limit });
      if (!trip.plus && c.value.startDate && c.value.startDate !== (trip.startDate || "")) { // moving a date later can't dodge the limit, even after the package ended (trip.hz = the cap it was made under)
        const plan = await P.getPlan(trip.owner), live = P.horizon(plan), mx = trip.hz && trip.hz > live ? trip.hz : live;
        if (mx && c.value.startDate > mx) return L.json(res, 402, { error: "plan_date", max: mx, passes: plan.passes, tier: plan.tier });
      }
      const oldIds = trip.vans.map((v) => v.id);
      const next = assignVanIds(c.value.vans.map((v) => ({ id: oldIds.includes(v.id) ? v.id : "", label: v.label, plate: v.plate })), oldIds);
      const kept = new Set(next.map((v) => v.id));
      const removed = oldIds.filter((id) => !kept.has(id));
      const updated = Object.assign({}, trip, c.value, { vans: next, schemaVersion: 1, updatedAt: Date.now(), rev: (trip.rev || 0) + 1 });
      const bookers = await L.tripBookers(trip); // before removed vans lose their seats
      const cmds = [["SET", L.tripKey(t), JSON.stringify(updated)]];
      removed.forEach((id) => cmds.push(["DEL", L.seatsKey(t, id)]));
      await L.pipeline(cmds);
      let staffSkipped = [];
      try {
        if (updated.staffSeat && !trip.staffSeat) staffSkipped = await reserveStaff(updated, next.map((v) => v.id)); // just turned on: every van
        else if (updated.staffSeat) {
          if ((trip.staffName || "STAFF") !== updated.staffName) await renameStaff(updated);
          staffSkipped = await reserveStaff(updated, next.filter((v) => !oldIds.includes(v.id)).map((v) => v.id)); // new vans only
        }
        else if (trip.staffSeat) await releaseStaff(updated);
      } catch (e) { /* best effort: the trip itself is saved */ }
      await L.applyExpiry(updated); // SET cleared the TTL; dates may have changed
      // notifications: what passengers care about (name, dates, departure, meeting point) and removed vans
      const by = L.roleOf(trip, user), ch = [];
      if ((trip.name || "") !== (updated.name || "")) ch.push({ f: "name", o: trip.name || "", n: updated.name || "" });
      if ((trip.startDate || "") !== (updated.startDate || "") || (trip.endDate || "") !== (updated.endDate || "")) ch.push({ f: "date", o: [trip.startDate || "", trip.endDate || ""], n: [updated.startDate || "", updated.endDate || ""] });
      if ((trip.departTime || "") !== (updated.departTime || "")) ch.push({ f: "time", o: trip.departTime || "", n: updated.departTime || "" });
      if ((trip.returnTime || "") !== (updated.returnTime || "")) ch.push({ f: "rtime", o: trip.returnTime || "", n: updated.returnTime || "" });
      if ((trip.meetPoint || "") !== (updated.meetPoint || "")) ch.push({ f: "meet", o: trip.meetPoint || "", n: updated.meetPoint || "" });
      const gone = new Set();
      removed.forEach((id) => { (bookers[id] || []).forEach((u) => gone.add(u)); });
      if (gone.size) await L.notify(Array.from(gone), { k: "van_removed", t, tn: updated.name, vl: L.vanLabel(trip, removed[0]), by }, user.id);
      if (ch.length) await L.notify([].concat(...next.map((v) => bookers[v.id] || []), L.teamIds(updated)), { k: "trip_changed", t, tn: updated.name, ch, by }, user.id);
      let gapsNow; try { gapsNow = updated.staffSeat ? (await staffGaps(updated)).map((v) => v.label) : undefined; } catch (e) { /* shown next load */ }
      return L.json(res, 200, { ok: true, trip: tripSummary(updated, user), staffSkipped: staffSkipped.length ? staffSkipped : undefined, staffGaps: gapsNow });
    }

    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return L.json(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    return L.json(res, 502, { error: "storage_error" });
  }
};
