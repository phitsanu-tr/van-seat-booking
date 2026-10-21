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

const DEFAULT_ID = "default";
const TRIP_ID_RE = /^[a-z0-9]{3,16}$/;

function tripId(value) {
  const t = String(value || DEFAULT_ID).toLowerCase();
  return TRIP_ID_RE.test(t) ? t : null;
}
function tripKey(t) { return "trip:" + t; }
// The very first van keeps its original key so bookings made before trips existed stay visible.
function seatsKey(t, v) { return t === DEFAULT_ID && v === "A" ? "van:seats" : "seats:" + t + ":" + v; }

function defaultTrip() {
  return { id: DEFAULT_ID, name: "จองที่นั่งรถตู้", organizer: "", startDate: "", endDate: "", departTime: "", meetPoint: "", vans: [{ id: "A", label: "A" }] };
}

async function loadTrip(t) {
  const raw = await redis(["GET", tripKey(t)]);
  if (raw) {
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  return t === DEFAULT_ID ? defaultTrip() : null;
}

function publicTrip(trip) {
  const { adminToken, adminHash, ...rest } = trip; // never send the admin secret (or its hash) to passengers
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
// Unix seconds when the trip's data should vanish, or null (no dates / the default trip: never expires).
function expireAtFor(trip) {
  if (!trip || trip.id === DEFAULT_ID) return null;
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

module.exports = {
  TOTAL_SEATS, REST_URL, REST_TOKEN, pipeline, redis, readBody, json, DEFAULT_ID,
  tripId, tripKey, seatsKey, logKey, logEvent, RETENTION_DAYS, expireAtFor, expiryCommands, applyExpiry, loadTrip, publicTrip, tripEnded, parseSeat, newId, crypto,
};
