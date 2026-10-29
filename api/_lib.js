// Shared helpers for the API functions (the leading underscore keeps this file from becoming a route).
const crypto = require("crypto");

const TOTAL_SEATS = 10;

// Accept the variable names with or without a custom prefix (e.g. VAN_SEAT_BOOKING_KV_REST_API_URL).
function pickEnv(...names) {
  for (const name of names) {
    for (const key of Object.keys(process.env)) {
      if ((key === name || key.endsWith("_" + name)) && process.env[key]) return process.env[key];
    }
  }
  return undefined;
}

const REST_URL = pickEnv("KV_REST_API_URL", "UPSTASH_REDIS_REST_URL");
const REST_TOKEN = pickEnv("KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN");

// Runs several commands in one round trip; returns their results in order.
async function pipeline(commands) {
  const res = await fetch(REST_URL.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + REST_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  const out = await res.json();
  if (!res.ok || !Array.isArray(out) || out.length !== commands.length) throw new Error("redis_http_" + res.status);
  return out.map((o) => {
    if (o && o.error) throw new Error(o.error);
    return o ? o.result : null;
  });
}
async function redis(command) { return (await pipeline([command]))[0]; }

function readBody(req) {
  let b = req.body;
  if (typeof b === "string") {
    try { b = JSON.parse(b); } catch (e) { b = {}; }
  }
  return b && typeof b === "object" ? b : {};
}

function json(res, status, payload) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(payload);
}

const TRIP_ID_RE = /^[a-z0-9]{3,16}$/;

function tripId(value) {
  const t = String(value || "").toLowerCase();
  return TRIP_ID_RE.test(t) ? t : null;
}
function tripKey(t) { return "trip:" + t; }
function seatsKey(t, v) { return "seats:" + t + ":" + v; }

async function loadTrip(t) {
  const raw = await redis(["GET", tripKey(t)]);
  if (raw) {
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  return null;
}

function publicTrip(trip) {
  const { adminToken, adminHash, owner, ownerName, helpers, invite, ...rest } = trip; // never send account ids (owner, helpers) or the invite code to passengers
  return rest;
}

// A trip is over once today's date in Bangkok is after its last day (endDate, or startDate when there is no endDate).
function tripEnded(trip) {
  const end = (trip && (trip.endDate || trip.startDate)) || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return false;
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  return today > end;
}

// Auto-delete: a trip's data (trip, seats, log) expires RETENTION_DAYS after its last day (endDate, else startDate), end of day Bangkok time.
const RETENTION_DAYS = 60;
// Unix seconds when the trip's data should vanish, or null (no dates: never expires).
function expireAtFor(trip) {
  if (!trip) return null;
  const end = trip.endDate || trip.startDate || "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(end);
  if (!m) return null;
  const endOfDay = Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59, 59) - 7 * 3600 * 1000;
  return Math.floor((endOfDay + RETENTION_DAYS * 86400 * 1000) / 1000);
}
function tripKeys(trip) {
  return [tripKey(trip.id), logKey(trip.id)].concat((trip.vans || []).map((v) => seatsKey(trip.id, v.id)));
}
// Commands that (re)apply the expiry to every key of a trip. Dates cleared -> PERSIST. Never expires data immediately unless force=true.
function expiryCommands(trip, minSec) {
  let exp = expireAtFor(trip);
  const cmds = [];
  if (exp === null) { tripKeys(trip).forEach((k) => cmds.push(["PERSIST", k])); return cmds; }
  if (minSec && exp < minSec) exp = minSec;
  tripKeys(trip).forEach((k) => cmds.push(["EXPIREAT", k, String(exp)]));
  return cmds;
}
async function applyExpiry(trip) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const exp = expireAtFor(trip);
    if (exp !== null && exp <= now) return; // already past retention: leave it to the owner console, never wipe on an ordinary edit
    await pipeline(expiryCommands(trip, 0));
  } catch (e) { /* best effort */ }
}

// Per-trip activity log (newest first, last 200 events, expires 90 days after the latest event). Best effort: never breaks a booking.
function logKey(t) { return "log:" + t; }
async function logEvent(t, ev, tripExpSec) {
  try {
    const clean = {};
    Object.keys(ev).forEach((k) => { if (ev[k] !== undefined && ev[k] !== "") clean[k] = ev[k]; });
    await pipeline([["LPUSH", logKey(t), JSON.stringify(clean)], ["LTRIM", logKey(t), "0", "199"], tripExpSec && tripExpSec > Math.floor(Date.now() / 1000) && tripExpSec < Math.floor(Date.now() / 1000) + 90 * 86400 ? ["EXPIREAT", logKey(t), String(tripExpSec)] : ["EXPIRE", logKey(t), String(90 * 86400)]]);
  } catch (e) { /* ignore */ }
}

// Booking names: Thai + English letters only, up to 16, no spaces/digits/symbols.
// Thai vowel/tone marks must follow a consonant (or another mark); leading vowels (เ แ โ ใ ไ) may start a name.
const NAME_MAX = 16;
function cleanName(input) {
  const src = Array.from(String(input == null ? "" : input).normalize("NFC"));
  let out = "", prev = "", marks = 0, removed = false, truncated = false;
  for (const ch of src) {
    const c = ch.charCodeAt(0);
    const cons = c >= 0x0E01 && c <= 0x0E2E;
    const lead = (c >= 0x0E40 && c <= 0x0E45);
    const mark = (c >= 0x0E30 && c <= 0x0E39) || (c >= 0x0E47 && c <= 0x0E4C);
    const latin = /^[A-Za-z]$/.test(ch);
    let ok = cons || lead || latin;
    if (mark) {
      const pc = prev ? prev.charCodeAt(0) : 0;
      const afterBase = (pc >= 0x0E01 && pc <= 0x0E2E) || ((pc >= 0x0E30 && pc <= 0x0E39) || (pc >= 0x0E47 && pc <= 0x0E4C));
      ok = afterBase && marks < 2 && ch !== prev;
    }
    if (!ok) { removed = true; continue; }
    if (out.length >= NAME_MAX) { truncated = true; continue; }
    out += ch; prev = ch; marks = mark ? marks + 1 : 0;
  }
  return { text: out, removed, truncated };
}
function hasBaseLetter(s) { return /[\u0E01-\u0E2EA-Za-z]/.test(String(s)); }

function parseSeat(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= TOTAL_SEATS ? n : null;
}

function newId(len) {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[crypto.randomInt(chars.length)]; // unbiased
  return out;
}

// ---- accounts (LINE Login) ----
// Session cookie "vsb_s" (HttpOnly) -> Redis "sess:<id>" = {u, n, p}. u = LINE user id (never sent to other visitors).
const SESSION_DAYS = 30;
const MY_DAYS = 400; // "my trips" / "my seats" index lifetime, refreshed on every write
function cookies(req) {
  const out = {};
  String((req.headers && req.headers.cookie) || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > 0) { const k = part.slice(0, i).trim(); try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* skip */ } }
  });
  return out;
}
function isHttps(req) { return String((req.headers && req.headers["x-forwarded-proto"]) || "").split(",")[0].trim() === "https"; }
function cookieStr(req, name, value, maxAgeSec) {
  return name + "=" + encodeURIComponent(value) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + Math.max(0, Math.floor(maxAgeSec)) + (isHttps(req) ? "; Secure" : "");
}
async function currentUser(req) {
  const sid = cookies(req).vsb_s;
  if (!sid || !/^[a-z0-9]{32}$/.test(sid)) return null;
  try {
    const raw = await redis(["GET", "sess:" + sid]);
    const s = raw ? JSON.parse(raw) : null;
    return s && s.u ? { id: String(s.u), name: String(s.n || ""), pic: String(s.p || ""), sid } : null;
  } catch (e) { return null; }
}
function publicUser(u) { return u ? { name: u.name, pic: u.pic } : null; }
function clientIp(req) {
  return (String((req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"])) || "").split(",")[0].trim() || "unknown").slice(0, 64);
}
// Fixed-window counter: true when this caller (signed-in user, else network) went over `max` in the current window.
async function rateLimited(req, user, scope, max, windowSec) {
  try {
    const who = user ? "u:" + user.id : "ip:" + clientIp(req);
    const key = "rl:" + scope + ":" + who + ":" + Math.floor(Date.now() / 1000 / windowSec);
    const out = await pipeline([["INCR", key], ["EXPIRE", key, String(windowSec * 2)]]);
    return Number(out[0]) > max;
  } catch (e) { return false; }
}
function myTripsKey(uid) { return "mytrips:" + uid; }
function mySeatsKey(uid) { return "myseats:" + uid; }
// Trip managers: the owner (created the trip) and up to MAX_HELPERS co-organizers who joined with the owner's invite link.
// Helpers manage seats and edit the trip; only the owner deletes it, invites/removes helpers or hands the trip over.
const MAX_HELPERS = 3;
function roleOf(trip, user) {
  if (!trip || !user) return null;
  if (trip.owner && trip.owner === user.id) return "owner";
  if (Array.isArray(trip.helpers) && trip.helpers.some((h) => h && h.u === user.id)) return "helper";
  return null;
}
// Seats one account may hold in one trip (all vans together). The organizer is not limited. 0 = no limit.
const DEFAULT_MAX_PER_PERSON = 4;
function maxPerPerson(trip) { const n = Number(trip && trip.maxPerPerson); return Number.isInteger(n) && n >= 0 && n <= 50 ? n : DEFAULT_MAX_PER_PERSON; }

module.exports = {
  TOTAL_SEATS, REST_URL, REST_TOKEN, pipeline, redis, readBody, json,
  tripId, tripKey, seatsKey, logKey, logEvent, RETENTION_DAYS, expireAtFor, expiryCommands, applyExpiry, loadTrip, publicTrip, tripEnded, parseSeat, cleanName, hasBaseLetter, NAME_MAX, newId, crypto,
  SESSION_DAYS, MY_DAYS, cookies, cookieStr, isHttps, currentUser, publicUser, clientIp, rateLimited, myTripsKey, mySeatsKey, MAX_HELPERS, roleOf, DEFAULT_MAX_PER_PERSON, maxPerPerson,
};
