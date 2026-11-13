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
  function half(label, time, date, end) { // one side of the schedule frame: label, big time, small date
    var al = end ? "end" : "start";
    return { type: "box", layout: "vertical", flex: 1, contents: [
      { type: "text", text: label, size: "xxs", color: "#5d6b73", align: al },
      { type: "text", text: time ? String(time).replace(":", ".") : "–", size: "lg", weight: "bold", color: "#1b1f22", align: al },
      { type: "text", text: date || " ", size: "xxs", color: "#4a555c", align: al }] };
  }
  function bubble(t) {
    var go = short(t.startDate), back = short(t.endDate);
    var head = { type: "box", layout: "vertical", backgroundColor: "#0e7c86", paddingAll: "12px", contents: [
      { type: "box", layout: "horizontal", alignItems: "center", contents: [
        { type: "text", text: "VANTRIP · ตั๋วรถตู้", size: "xxs", weight: "bold", color: "#ffffffcc", flex: 1 },
        { type: "box", layout: "vertical", flex: 0, borderWidth: "1px", borderColor: "#ffffffaa", cornerRadius: "8px", paddingTop: "1px", paddingBottom: "1px", paddingStart: "8px", paddingEnd: "8px",
          contents: [{ type: "text", text: String(t.id), size: "xs", weight: "bold", color: "#ffffff" }] }] },
      { type: "text", text: t.name || "จองที่นั่งรถตู้", weight: "bold", size: "sm", wrap: true, color: "#ffffff", margin: "sm" }] };
    if (t.organizer) head.contents.push({ type: "text", text: String(t.organizer), size: "xxs", color: "#ffffffcc", maxLines: 1, margin: "xs" }); // organizer under the title, one line
    var body = [{ type: "box", layout: "horizontal", borderWidth: "1px", borderColor: "#dbe7e8", cornerRadius: "12px", paddingAll: "12px", contents: [
      half("เที่ยวไป", t.departTime, go, false),
      { type: "box", layout: "vertical", flex: 0, width: "28px", justifyContent: "center", alignItems: "center", contents: [
        { type: "text", text: "→", size: "lg", weight: "bold", color: "#0e7c86", align: "center" },
        { type: "text", text: "←", size: "lg", weight: "bold", color: "#e5484d", align: "center" }] },
      half("เที่ยวกลับ", t.returnTime, back, true)] }];
    if (t.meetPoint) body.push({ type: "box", layout: "baseline", spacing: "sm", margin: "sm", contents: [
      { type: "text", text: "📍", size: "xs", flex: 0 },
      { type: "text", text: t.meetPoint, size: "xs", color: "#4a555c", wrap: true, flex: 1 }] });
    return { type: "bubble", size: "mega",
      header: head,
      body: { type: "box", layout: "vertical", paddingAll: "12px", contents: body },
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
  function send(t) { // t: {id, name, startDate, endDate, departTime, returnTime, meetPoint, closed}
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
