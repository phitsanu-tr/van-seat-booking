/* VSBShare — sends a trip into LINE as a card (Flex Message) through LIFF's chat picker, so the chat shows a card with a
   "เลือกที่นั่ง" button that opens the LIFF page directly (one window, no long link). Where the picker is not available
   (outside LINE, API not enabled for this LIFF app) send() resolves false and the caller falls back to the text link. */
(function () {
  var LIFF_ID = "2012285472-FvtYKx00", ORIGIN = "https://van-seat-booking.vercel.app";
  var MON = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."], DOW = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
  function tripText(n, start) { // same wording as the server's tripDaysText
    n = Number(n); var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(start || ""));
    if (!Number.isInteger(n) || n < 1 || !m) return "";
    var a = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])), b = new Date(a.getTime() + (n - 1) * 86400000);
    var d1 = a.getUTCDate() + " " + MON[a.getUTCMonth()], d2 = b.getUTCDate() + " " + MON[b.getUTCMonth()];
    if (n === 1) return "เดย์ทริป · " + d1;
    return n + " วัน " + (n - 1) + " คืน · " + (a.getUTCMonth() === b.getUTCMonth() ? a.getUTCDate() + " – " + d2 : d1 + " – " + d2);
  }
  function vanUrl(k) { return "https://liff.line.me/" + LIFF_ID + "/t/" + k; } // one van's own link: the card built for a van never carries the trip code
  function liffUrl(id, kind) { return "https://liff.line.me/" + LIFF_ID + "/" + id + (kind === "info" ? "" : "/seats"); } // /<id> is the trip details, /<id>/seats the seat map
  function shortY(iso) { // short() plus the Buddhist-era year when the date is not in the current year
    var m = /^(\d{4})-/.exec(String(iso || "")), d = short(iso);
    return d && m && +m[1] !== new Date().getFullYear() ? d + " " + String((+m[1] + 543) % 100).padStart(2, "0") : d;
  }
  function short(iso) { // "ศ. 15 ม.ค." — no year, so it fits the narrow half of the card
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "")); if (!m) return "";
    return DOW[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()] + " " + (+m[3]) + " " + MON[+m[2] - 1];
  }
  var LINE_C = "#dbe7e8", TXT = "#1b1f22", SUB = "#5d6b73", TEAL = "#0e7c86";
  function txt(text, o) { var x = { type: "text", text: text, wrap: true }; for (var k in o) x[k] = o[k]; return x; }
  function half(label, time, date, end, warn) { // one side of the schedule box: label, big time, small date (warn: orange, a night-before departure)
    var al = end ? "end" : "start";
    return { type: "box", layout: "vertical", flex: 1, contents: [
      txt(label, { size: "12px", color: SUB, align: al }),
      txt(time ? String(time) : "–", { size: "20px", weight: "bold", color: TXT, align: al }),
      txt(date || " ", warn ? { size: "12px", color: "#b45309", align: al } : { size: "12px", color: "#4a555c", align: al })] };
  }
  function line(label, value, o) { // table row: grey label left, bold value right, thin rule above (except the first)
    return { type: "box", layout: "horizontal", paddingTop: "8px", paddingBottom: "8px", spacing: "12px", contents: [
      txt(label, { size: "12px", color: SUB, flex: 0, wrap: false, gravity: "center" }),
      txt(value, { size: "14px", weight: "bold", color: (o && o.color) || TXT, align: "end", flex: 1, gravity: "center" })] };
  }
  function limitText(n) { return n === 0 ? "ไม่จำกัด" : n === 1 ? "1 ที่นั่ง" : "ไม่เกิน " + n + " ที่นั่ง"; }
  function gh(title, first) { // group heading; no rule between groups, a 20px gap separates them
    var h = txt(title, { size: "14px", weight: "bold", color: "#0b5f67", wrap: false });
    if (!first) h.margin = "20px";
    return [h];
  }
  function irow(label, value) { // label left (grey), value right (bold); same wording as the trip details tab
    return { type: "box", layout: "horizontal", margin: "8px", spacing: "12px", contents: [
      txt(label, { size: "12px", color: SUB, flex: 0, wrap: false, gravity: "center" }),
      txt(value, { size: "14px", weight: "bold", color: TXT, align: "end", flex: 1, gravity: "center" })] };
  }
  function infoBubble(t, plain, kind) { // card 1: shared from the trip details tab — everything about the trip, button opens the details
    var brand = plain ? txt("VAN TRIP", { size: "14px", weight: "bold", color: "#ffffff", wrap: false, flex: 1, gravity: "center" })
      : { type: "text", wrap: false, flex: 1, gravity: "center", size: "14px", weight: "bold", contents: [ // same wordmark as the poster: VAN white, TRIP pastel yellow
        { type: "span", text: "VAN", color: "#ffffff" }, { type: "span", text: " " }, { type: "span", text: "TRIP", color: "#fde9a6" }] };
    var head = { type: "box", layout: "vertical", alignItems: "flex-start", backgroundColor: kind === "org" ? "#7a4f00" : "#0b5f67", paddingAll: "14px", contents: [
      { type: "box", layout: "horizontal", spacing: "8px", alignItems: "center", width: "100%", contents: [ // brand at the left, the trip code (plain, upper case) at the right
        brand].concat((t.id || t.vk) && !plain ? [txt((t.vk && kind !== "org" ? "VT" + String(t.vk) : kind === "org" ? "OG" + String(t.id) : String(t.id)).toUpperCase(), { size: "12px", color: "#bfe9ed", wrap: false, flex: 0, align: "end", gravity: "center" })] : []) }]
      .concat(plain ? [] : [{ type: "separator", color: kind === "org" ? "#b8893a" : "#4f8a91", margin: "10px" }])
      .concat([txt(String(t.name || "ทริปรถตู้"), { weight: "bold", size: "20px", color: "#ffffff", margin: "8px", maxLines: 2 })])
      .concat(kind === "org" ? [txt("ลิงก์ผู้จัด · ดูทุกคัน · ห้ามส่งให้ผู้จอง", { size: "12px", color: "#ffe3a3", margin: "4px" })] : []) };
    var tdp = String(t.tripDays || "").split(" · "), n = Number(t.vans) || 0, body = [], g1 = [];
    if (t.organizer) g1.push(irow("ผู้จัด", t.organizer));
    if (tdp[0]) g1.push(irow("ทริป", tdp[0] === "เดย์ทริป" ? "เดย์ทริป" : "ค้างคืน · " + tdp[0]));
    var ty = /^(\d{4})-/.exec(String(t.tripStart || t.startDate || "")); // add the Buddhist-era year only when the trip is not in the current year
    if (tdp[1]) g1.push(irow("วันที่", tdp[1] + (ty && +ty[1] !== new Date().getFullYear() ? " " + String((+ty[1] + 543) % 100).padStart(2, "0") : "")));
    if (t.vk) g1.push(irow("รถของคุณ", "คัน " + t.vl)); // a card for one van
    else if (n > 0) g1.push(irow("รถตู้", n + " คัน · " + (n * 10 - (t.staffSeat ? n : 0)) + " ที่นั่ง"));
    if (Number(t.limit) > 0) g1.push(irow("จำกัดที่นั่งต่อคน", Number(t.limit) + " ที่นั่ง"));
    if (g1.length) { gh("รายละเอียดทริป", true).forEach(function (x) { body.push(x); }); g1.forEach(function (r) { body.push(r); }); }
    var hasTime = t.startDate || t.departTime || t.endDate || t.returnTime;
    var nightBefore = !!(hasTime && t.tripStart && t.startDate && t.departTime && t.startDate < t.tripStart); // leaves the evening before the trip's first day (same rule as the details tab)
    if (hasTime || t.meetPoint) {
      gh("กำหนดการเดินทาง", !body.length).forEach(function (x) { body.push(x); });
      var card = []; // one bordered box: the times, then (under a hairline) the meeting point
      if (hasTime) card.push({ type: "box", layout: "horizontal", paddingAll: "12px", spacing: "8px", alignItems: "center", contents: [
        half("เดินทางไป", t.departTime ? t.departTime + " น." : "", shortY(t.startDate), false, nightBefore),
        plain ? { type: "image", url: ORIGIN + "/swap-icon.png", size: "20px", aspectRatio: "1:1", aspectMode: "fit", flex: 0, gravity: "center", margin: "8px" }
          : { type: "box", layout: "vertical", flex: 0, width: "28px", height: "28px", cornerRadius: "14px", borderWidth: "1px", borderColor: "#dfe5e8", justifyContent: "center", alignItems: "center",
              contents: [{ type: "image", url: ORIGIN + "/swap-icon.png", size: "16px", aspectRatio: "1:1", aspectMode: "fit" }] },
        half("เดินทางกลับ", t.returnTime ? t.returnTime + " น." : "", shortY(t.endDate || t.startDate), true)] });
      if (t.meetPoint) {
        if (hasTime) card.push({ type: "box", layout: "vertical", paddingStart: "12px", paddingEnd: "12px", contents: [{ type: "box", layout: "vertical", height: "1px", backgroundColor: "#dbe1e4", contents: [{ type: "filler" }] }] }); // inset hairline (a 1px box: a separator here did not draw in the simulator), not edge to edge
        card.push({ type: "box", layout: "vertical", paddingAll: "12px", contents: [
          txt("จุดนัดพบ", { size: "12px", color: SUB }),
          txt(t.meetPoint, { size: "14px", weight: "bold", color: TXT })] });
      }
      body.push(Object.assign({ type: "box", layout: "vertical", margin: "8px", cornerRadius: "12px", contents: card }, plain ? { backgroundColor: "#f6f8f9" } : { backgroundColor: "#ffffff", borderWidth: "1px", borderColor: "#dfe5e8" })); // plain = fallback look if LINE rejects the richer card
    }
    return { type: "bubble", size: "mega", header: head,
      body: { type: "box", layout: "vertical", paddingAll: "12px", paddingTop: "4px", paddingBottom: "8px", contents: body },
      footer: { type: "box", layout: "vertical", paddingAll: "12px", paddingTop: "4px", contents: [{ type: "button", style: "primary", color: kind === "org" ? "#8a5a00" : "#0b5f67", height: "sm",
        action: kind === "org" ? { type: "uri", label: "เปิดหน้าผู้จัด", uri: liffUrl(t.id) } : kind === "info" ? { type: "uri", label: "ดูรายละเอียดทริป", uri: liffUrl(t.id, "info") } : t.vk ? { type: "uri", label: (t.closed ? "ดูผังที่นั่งคัน " : "จองที่นั่งคัน ") + t.vl, uri: vanUrl(t.vk) } : { type: "uri", label: t.closed ? "ดูผังที่นั่ง" : "เลือกที่นั่ง", uri: liffUrl(t.id) } }] } };
  }
  var ready = null;
  function ensure() { // the page may or may not have loaded/initialised the LIFF SDK already
    if (ready) return ready;
    ready = new Promise(function (resolve) {
      function init() {
        if (!window.liff) { resolve(false); return; }
        if (liff.id) { resolve(true); return; }
        liff.init({ liffId: LIFF_ID }).then(function () { resolve(true); }, function () { resolve(false); });
      }
      if (window.liff) { init(); return; }
      var s = document.createElement("script"); s.src = "https://static.line-scdn.net/liff/edge/2/sdk.js"; s.onload = init; s.onerror = function () { resolve(false); };
      document.head.appendChild(s);
    });
    return ready;
  }
  function send(t, kind) { // t: {id, name, organizer, startDate, endDate, departTime, returnTime, meetPoint, vans (count), staffSeat, limit (0 = none), closed}
    return ensure().then(function (ok) {
      if (!ok || !t || !t.id) return false;
      try {
        if (!liff.isInClient() || !liff.isLoggedIn() || !liff.isApiAvailable("shareTargetPicker")) return false;
      } catch (e) { return false; }
      function pick(plain) { // plain = the header without the hairline + code pill (fallback if LINE rejects the richer card)
        return liff.shareTargetPicker([{ type: "flex", altText: "🚐 " + (t.name || "จองที่นั่งรถตู้") + (t.vk ? " · คัน " + t.vl : "") + (kind === "org" ? " · ลิงก์ผู้จัด (ดูทุกคัน)" : kind === "info" ? " · รายละเอียดทริป" : t.closed ? " · ดูผังที่นั่ง" : " · เลือกที่นั่ง"), contents: infoBubble(t, plain, kind) }])
          .then(function () { return true; }, function (e) { if (!plain) return pick(true); return false; });
      }
      return pick(false);
    }).catch(function () { return false; });
  }
  window.VSBShare = { send: send, liffUrl: liffUrl, vanUrl: vanUrl, tripText: tripText };
})();
