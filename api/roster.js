// Vercel serverless function: /api/roster — the passenger list as a page to print (save as PDF) or a CSV file.
// Inside LINE (LIFF) the app can't open print windows or download blobs, so the organizer's phone gets a short-lived
// link instead and LINE opens it in the real browser:
//   POST {t}            (organizer team, signed in)  -> {k}   a random code, kept 10 minutes
//   GET  ?k=code        -> the printable page (reads the live list at open time)
//   GET  ?k=code&csv=1  -> the CSV file (Content-Disposition: attachment)
// The code carries no right to change anything; it only reads the list, and dies after 10 minutes.
const L = require("./_lib");

const TTL = 10 * 60; // seconds
const ID_RE = /^[a-z0-9]{16}$/;
const key = (k) => "rostk:" + k;

const MON = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
function thDateY(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  return m ? Number(m[3]) + " " + MON[Number(m[2]) - 1] + " " + (Number(m[1]) + 543) : "";
}
function dateRange(a, b) {
  if (!a) return "";
  return !b || b === a ? thDateY(a) : thDateY(a) + " – " + thDateY(b);
}
function when(ts) {
  if (!ts) return "";
  const d = new Date(Number(ts) + 7 * 3600 * 1000);
  return d.getUTCDate() + " " + MON[d.getUTCMonth()] + " " + String(d.getUTCHours()).padStart(2, "0") + "." + String(d.getUTCMinutes()).padStart(2, "0") + " น.";
}
function isoT(ts) { return ts ? new Date(Number(ts) + 7 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ") : ""; }
function eh(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function csvCell(v) { v = String(v == null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

async function seatsOf(trip) { // per van: {n: {name, at, c, nt}} — never the booker's LINE identity
  const all = await L.pipeline(trip.vans.map((v) => ["HGETALL", L.seatsKey(trip.id, v.id)]));
  return trip.vans.map((v, i) => {
    const flat = all[i] || [], seats = {};
    for (let j = 0; j + 1 < flat.length; j += 2) {
      const n = L.parseSeat(flat[j]);
      if (n === null) continue;
      try { const r = JSON.parse(flat[j + 1]); if (r && r.name) seats[n] = { name: String(r.name), at: r.at, c: r.c, nt: r.nt ? String(r.nt) : "" }; } catch (e) { /* skip */ }
    }
    return seats;
  });
}

function csvOf(trip, perVan) {
  const rows = [["ทริป", "รถ", "ที่นั่ง", "ชื่อผู้จอง", "จองเมื่อ", "ขึ้นรถ", "หมายเหตุ"]];
  trip.vans.forEach((v, i) => {
    const seats = perVan[i];
    Object.keys(seats).map(Number).sort((a, b) => a - b).forEach((n) => {
      const s = seats[n];
      rows.push([trip.name || "", "รถ " + v.label, n, s.name, isoT(s.at), s.c ? "ขึ้นแล้ว" : "", s.nt || ""]);
    });
  });
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

function htmlOf(trip, perVan) {
  const tm = trip.departTime ? "ออก " + trip.departTime.replace(":", ".") + " น." : "";
  let h = "";
  trip.vans.forEach((v, i) => {
    const seats = perVan[i];
    let cnt = 0; for (let n = 1; n <= L.TOTAL_SEATS; n++) if (seats[n]) cnt++;
    h += "<h2>รถคัน " + eh(v.label) + (v.plate ? " · " + eh(v.plate) : "") + " <small>" + cnt + "/" + L.TOTAL_SEATS + " ที่</small></h2>";
    h += "<table><tr><th class=c>ที่</th><th>ชื่อผู้จอง</th><th>จองเมื่อ</th><th class=c>ขึ้นรถ</th><th class=nt>หมายเหตุ</th></tr>";
    for (let n = 1; n <= L.TOTAL_SEATS; n++) {
      const s = seats[n];
      h += s ? '<tr><td class=c>' + n + "</td><td>" + eh(s.name) + "</td><td>" + eh(when(s.at)) + '</td><td class="c chk">' + (s.c ? "✓" : "") + "</td><td>" + eh(s.nt || "") + "</td></tr>"
             : '<tr class=e><td class=c>' + n + "</td><td>— ว่าง —</td><td></td><td></td><td></td></tr>";
    }
    h += "</table>";
  });
  return '<!doctype html><html lang=th><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=robots content="noindex"><title>รายชื่อ — ' + eh(trip.name || "") + "</title>"
    + '<link href="https://fonts.googleapis.com/css2?family=Prompt:wght@400;600&display=swap" rel=stylesheet>'
    + '<style>body{font-family:Prompt,"Noto Sans Thai",sans-serif;color:#111;margin:0 auto;padding:28px 30px;max-width:640px}'
    + "h1{font-size:19px;margin:0;color:#0b5f67}.sub{font-size:12.5px;color:#555;margin-top:4px;line-height:1.6}"
    + "h2{font-size:13.5px;margin:22px 0 8px}h2 small{color:#777;font-weight:400}"
    + "table{width:100%;border-collapse:collapse;font-size:12.5px}th{background:#eef6f7;color:#0b5f67;text-align:left;padding:6px 10px;font-weight:600;font-size:11.5px}"
    + "td{padding:6px 10px;border-bottom:1px solid #eef1f3}tr.e td{color:#bbb}.c{text-align:center;width:40px}.nt{width:30%}.chk{color:#0b8457;font-weight:700}"
    + ".foot{margin-top:24px;font-size:10.5px;color:#999}"
    + ".pbar{position:sticky;top:0;background:#0b5f67;margin:-28px -30px 20px;padding:10px 16px;display:flex;justify-content:space-between;align-items:center;gap:10px}"
    + ".pbar button{background:#fff;color:#0b5f67;border:0;border-radius:9px;padding:8px 18px;font:600 13px Prompt,sans-serif}.pbar span{color:#fff;font-size:12px}"
    + "@media print{.pbar{display:none}body{padding:0}}</style>"
    + '<div class=pbar><span>กด "พิมพ์" แล้วเลือกบันทึกเป็น PDF ได้</span><button onclick="print()">พิมพ์</button></div>'
    + "<h1>รายชื่อผู้โดยสาร — " + eh(trip.name || "") + "</h1>"
    + "<div class=sub>" + eh([dateRange(trip.startDate, trip.endDate), tm].filter(Boolean).join(" · ")) + (trip.meetPoint ? "<br>จุดนัดพบ: " + eh(trip.meetPoint) : "") + "</div>"
    + h + "<div class=foot>พิมพ์จาก VanTrip · " + eh(when(Date.now())) + "</div>";
}

module.exports = async function handler(req, res) {
  if (!L.REST_URL || !L.REST_TOKEN) return L.json(res, 404, { error: "not_configured" });
  if (L.crossSite(req)) return L.json(res, 403, { error: "cross_site" });
  try {
    if (req.method === "POST") {
      const user = await L.currentUser(req);
      if (!user) return L.json(res, 401, { error: "login_required" });
      const body = L.readBody(req);
      const t = L.tripId(body.t);
      const trip = t && (await L.loadTrip(t));
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      if (!L.roleOf(trip, user)) return L.json(res, 403, { error: "not_owner" });
      const k = L.newId(16);
      await L.redis(["SET", key(k), t, "EX", String(TTL)]);
      return L.json(res, 200, { k, exp: Date.now() + TTL * 1000 });
    }
    if (req.method === "GET") {
      const k = String((req.query && req.query.k) || "");
      if (!ID_RE.test(k)) return L.json(res, 404, { error: "bad_token" });
      const t = L.tripId(await L.redis(["GET", key(k)]));
      const trip = t && (await L.loadTrip(t));
      if (!trip) return L.json(res, 404, { error: "bad_token" });
      const perVan = await seatsOf(trip);
      res.statusCode = 200;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
      if (req.query.csv !== undefined) {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        const fn = encodeURIComponent(("รายชื่อ-" + String(trip.name || "ทริป").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60)) + ".csv");
        res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + fn);
        return res.end(csvOf(trip, perVan));
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(htmlOf(trip, perVan));
    }
    res.setHeader("Allow", "GET, POST");
    return L.json(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    return L.json(res, 502, { error: "storage_error" });
  }
};
