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
  var LINE_C = "#dbe7e8", TXT = "#1b1f22", SUB = "#5d6b73", TEAL = "#0e7c86";
  function txt(text, o) { var x = { type: "text", text: text, wrap: true }; for (var k in o) x[k] = o[k]; return x; }
  function half(label, time, date, end) { // one side of the schedule box: label, big time, small date
    var al = end ? "end" : "start";
    return { type: "box", layout: "vertical", flex: 1, contents: [
      txt(label, { size: "12px", color: SUB, align: al }),
      txt(time ? String(time) : "–", { size: "20px", weight: "bold", color: TXT, align: al }),
      txt(date || " ", { size: "12px", color: "#4a555c", align: al })] };
  }
  function line(label, value, o) { // table row: grey label left, bold value right, thin rule above (except the first)
    return { type: "box", layout: "horizontal", paddingTop: "8px", paddingBottom: "8px", spacing: "12px", contents: [
      txt(label, { size: "12px", color: SUB, flex: 0, wrap: false, gravity: "center" }),
      txt(value, { size: "14px", weight: "bold", color: (o && o.color) || TXT, align: "end", flex: 1, gravity: "center" })] };
  }
  function limitText(n) { return n === 0 ? "ไม่จำกัด" : n === 1 ? "1 ที่นั่ง" : "ไม่เกิน " + n + " ที่นั่ง"; }
  function bubble(t) {
    var head = { type: "box", layout: "vertical", alignItems: "flex-start", backgroundColor: "#e6f3f3", paddingAll: "12px", contents: [
      { type: "box", layout: "vertical", flex: 0, backgroundColor: "#ffffff", cornerRadius: "20px", paddingTop: "4px", paddingBottom: "4px", paddingStart: "12px", paddingEnd: "12px",
        contents: [txt("VanTrip · จองที่นั่ง", { size: "12px", weight: "bold", color: TEAL, wrap: false })] },
      txt(t.name || "จองที่นั่งรถตู้", { weight: "bold", size: "20px", color: TXT, margin: "8px" })] };
    var timeBox = { type: "box", layout: "horizontal", borderWidth: "1px", borderColor: LINE_C, cornerRadius: "12px", paddingAll: "12px", contents: [
      half("เดินทางไป", t.departTime, short(t.startDate), false),
      { type: "box", layout: "vertical", flex: 0, width: "44px", alignItems: "center", contents: [ // a hairline with a round ⇄ badge in the middle
        { type: "box", layout: "vertical", flex: 1, width: "1px", backgroundColor: LINE_C, contents: [] },
        { type: "box", layout: "vertical", flex: 0, width: "32px", height: "32px", cornerRadius: "16px", borderWidth: "1px", borderColor: LINE_C, justifyContent: "center", alignItems: "center",
          contents: [{ type: "image", url: ORIGIN + "/swap-icon.png", size: "16px", aspectRatio: "1:1", aspectMode: "fit" }] }, // two bold arrows (a PNG: LINE draws the ⇄ character thin)
        { type: "box", layout: "vertical", flex: 1, width: "1px", backgroundColor: LINE_C, contents: [] }] },
      half("เดินทางกลับ", t.returnTime, short(t.endDate), true)] };
    var rows = [], n = Number(t.vans) || 0;
    if (t.meetPoint) rows.push(line("จุดนัดพบ", t.meetPoint));
    if (t.limit != null && isFinite(Number(t.limit))) rows.push(line("จองได้ต่อคน", limitText(Number(t.limit))));
    if (n > 0) rows.push(line("รถตู้", n + " คัน · " + (n * 10 - (t.staffSeat ? n : 0)) + " ที่นั่ง"));
    rows.push(line("รหัสทริป", String(t.id), { color: TEAL }));
    var body = [], table = [];
    if (t.tripDays) body.push({ type: "box", layout: "horizontal", paddingBottom: "8px", contents: [ // the trip's own days, before the van's departure and return
      txt("ทริป", { size: "12px", color: SUB, flex: 0, gravity: "center", wrap: false }),
      txt(String(t.tripDays), { size: "14px", weight: "bold", color: TEAL, align: "end", gravity: "center" })] });
    body.push(timeBox);
    rows.forEach(function (r, i) { if (i) table.push({ type: "separator", color: "#e8eced" }); table.push(r); });
    body.push({ type: "box", layout: "vertical", margin: "8px", contents: table });
    return { type: "bubble", size: "mega",
      header: head,
      body: { type: "box", layout: "vertical", paddingAll: "12px", paddingBottom: "8px", contents: body },
      footer: { type: "box", layout: "vertical", paddingAll: "12px", paddingTop: "8px", contents: [{ type: "button", style: "primary", color: "#0b5f67", height: "sm",
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
