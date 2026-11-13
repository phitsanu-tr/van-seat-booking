/* VSBShare — sends a trip into LINE as a card (Flex Message) through LIFF's chat picker, so the chat shows a card with a
   "เลือกที่นั่ง" button that opens the LIFF page directly (one window, no long link). Where the picker is not available
   (outside LINE, API not enabled for this LIFF app) send() resolves false and the caller falls back to the text link. */
(function () {
  var LIFF_ID = "2012285472-FvtYKx00", ORIGIN = "https://van-seat-booking.vercel.app";
  var MON = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."], DOW = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
  function liffUrl(id) { return "https://liff.line.me/" + LIFF_ID + "/" + id; }
  function short(iso) { // "ศ. 15 ม.ค." — no year, so it fits the narrow half of the card
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "")); if (!m) return "";
    return DOW[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()] + " " + (+m[3]) + " " + MON[+m[2] - 1];
  }
  var LINE_C = "#dbe7e8", TXT = "#1b1f22", SUB = "#5d6b73";
  function txt(text, o) { var x = { type: "text", text: text, wrap: true }; for (var k in o) x[k] = o[k]; return x; }
  function frame(contents, o) { // one bordered box (1px, 12px radius) — every info box on the card looks the same
    var x = { type: "box", layout: "vertical", borderWidth: "1px", borderColor: LINE_C, cornerRadius: "12px", paddingTop: "8px", paddingBottom: "8px", paddingStart: "12px", paddingEnd: "12px", contents: contents };
    for (var k in o) x[k] = o[k];
    return x;
  }
  function info(label, value, flex) { return frame([txt(label, { size: "12px", color: SUB }), txt(value, { size: "14px", color: TXT })], flex ? { flex: 1 } : null); }
  function half(label, time, date, end) { // one side of the schedule box: label, big time, small date
    var al = end ? "end" : "start";
    return { type: "box", layout: "vertical", flex: 1, contents: [
      txt(label, { size: "12px", color: SUB, align: al }),
      txt(time ? String(time).replace(":", ".") : "–", { size: "20px", weight: "bold", color: TXT, align: al }),
      txt(date || " ", { size: "12px", color: "#4a555c", align: al })] };
  }
  function limitText(n) { return n === 0 ? "ไม่จำกัด" : n === 1 ? "1 ที่นั่ง" : "ไม่เกิน " + n + " ที่นั่ง"; }
  function bubble(t) {
    var chip = { type: "box", layout: "vertical", flex: 0, borderWidth: "1px", borderColor: "#ffffffaa", cornerRadius: "8px", paddingTop: "1px", paddingBottom: "1px", paddingStart: "8px", paddingEnd: "8px",
      contents: [txt(String(t.id), { size: "12px", weight: "bold", color: "#ffffff", wrap: false })] };
    var org = t.organizer ? txt(String(t.organizer), { size: "12px", color: "#ffffffcc", maxLines: 1, flex: 1 }) : { type: "filler" };
    var head = { type: "box", layout: "vertical", backgroundColor: "#0e7c86", paddingAll: "12px", contents: [
      txt(t.name || "จองที่นั่งรถตู้", { weight: "bold", size: "16px", color: "#ffffff" }),
      { type: "box", layout: "horizontal", alignItems: "center", margin: "4px", contents: [org, chip] }] };
    var body = [frame([{ type: "box", layout: "horizontal", contents: [
      half("เที่ยวไป", t.departTime, short(t.startDate), false),
      { type: "box", layout: "vertical", flex: 0, width: "28px", justifyContent: "center", alignItems: "center", contents: [
        txt("→", { size: "20px", weight: "bold", color: "#0e7c86", align: "center", wrap: false }),
        txt("←", { size: "20px", weight: "bold", color: "#e5484d", align: "center", wrap: false })] },
      half("เที่ยวกลับ", t.returnTime, short(t.endDate), true)] }], { paddingAll: "12px" })];
    if (t.meetPoint) body.push(info("จุดนัดพบ", t.meetPoint, false));
    var row = [], n = Number(t.vans) || 0;
    if (n > 0) row.push(info("รถตู้", n + " คัน · " + (n * 10 - (t.staffSeat ? n : 0)) + " ที่นั่ง", true));
    if (t.limit != null && isFinite(Number(t.limit))) row.push(info("จองได้ต่อคน", limitText(Number(t.limit)), true));
    if (row.length) body.push({ type: "box", layout: "horizontal", spacing: "8px", contents: row });
    return { type: "bubble", size: "mega",
      header: head,
      body: { type: "box", layout: "vertical", paddingAll: "12px", spacing: "8px", contents: body },
      footer: { type: "box", layout: "vertical", paddingAll: "10px", paddingTop: "0px", contents: [{ type: "button", style: "primary", color: "#0e7c86", height: "sm",
        action: { type: "uri", label: t.closed ? "ดูผังที่นั่ง" : "เลือกที่นั่ง", uri: liffUrl(t.id) } }] } };
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
  function send(t) { // t: {id, name, organizer, startDate, endDate, departTime, returnTime, meetPoint, vans (count), staffSeat, limit (0 = none), closed}
    return ensure().then(function (ok) {
      if (!ok || !t || !t.id) return false;
      try {
        if (!liff.isInClient() || !liff.isLoggedIn() || !liff.isApiAvailable("shareTargetPicker")) return false;
      } catch (e) { return false; }
      return liff.shareTargetPicker([{ type: "flex", altText: "🚐 " + (t.name || "จองที่นั่งรถตู้") + " · เลือกที่นั่ง", contents: bubble(t) }])
        .then(function () { return true; }, function () { return false; });
    }).catch(function () { return false; });
  }
  window.VSBShare = { send: send, liffUrl: liffUrl };
})();
