/* VSBShare — sends a trip into LINE as a card (Flex Message) through LIFF's chat picker, so the chat shows a card with a
   "เลือกที่นั่ง" button that opens the LIFF page directly (one window, no long link). Where the picker is not available
   (outside LINE, API not enabled for this LIFF app) send() resolves false and the caller falls back to the text link. */
(function () {
  var LIFF_ID = "2012285472-FvtYKx00", ORIGIN = "https://van-seat-booking.vercel.app";
  var MON = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."], DOW = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
  function liffUrl(id) { return "https://liff.line.me/" + LIFF_ID + "/" + id; }
  function day(iso, time) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "")); if (!m) return "";
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return DOW[d.getUTCDay()] + " " + (+m[3]) + " " + MON[+m[2] - 1] + " " + String(+m[1] + 543).slice(2) + (time ? " · " + String(time).replace(":", ".") + " น." : "");
  }
  function row(icon, text) {
    return { type: "box", layout: "baseline", spacing: "sm", contents: [
      { type: "text", text: icon, size: "sm", flex: 0 },
      { type: "text", text: text, size: "sm", color: "#4a555c", wrap: true, flex: 1 }] };
  }
  function bubble(t) {
    var body = [{ type: "text", text: t.name || "จองที่นั่งรถตู้", weight: "bold", size: "lg", wrap: true, color: "#1b1f22" }];
    var go = day(t.startDate, t.departTime), back = day(t.endDate, t.returnTime);
    if (go) body.push(row("→", "เที่ยวไป " + go));
    if (back) body.push(row("←", "เที่ยวกลับ " + back));
    if (t.meetPoint) body.push(row("📍", t.meetPoint));
    body.push({ type: "box", layout: "baseline", spacing: "sm", contents: [
      { type: "text", text: "🔑", size: "sm", flex: 0 },
      { type: "text", size: "sm", color: "#4a555c", wrap: true, flex: 1, contents: [
        { type: "span", text: "รหัสทริป " }, { type: "span", text: String(t.id), weight: "bold", color: "#0e7c86" }] }] });
    return { type: "bubble", size: "mega",
      hero: { type: "image", url: ORIGIN + "/share-card.png", size: "full", aspectRatio: "20:9", aspectMode: "cover" },
      body: { type: "box", layout: "vertical", spacing: "md", contents: body },
      footer: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "button", style: "primary", color: "#0e7c86", height: "sm",
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
