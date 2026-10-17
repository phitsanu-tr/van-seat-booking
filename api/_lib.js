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
  const { adminToken, ...rest } = trip; // never send the admin secret to passengers
  return rest;
}

function parseSeat(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= TOTAL_SEATS ? n : null;
}

function newId(len) {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

module.exports = {
  TOTAL_SEATS, REST_URL, REST_TOKEN, pipeline, redis, readBody, json, DEFAULT_ID,
  tripId, tripKey, seatsKey, loadTrip, publicTrip, parseSeat, newId, crypto,
};
