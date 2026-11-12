// One footer for every page: just "© 2026 VanTrip · ความเป็นส่วนตัว · เงื่อนไข · ติดต่อ" (the driving van, dotted road and rotating
// travel lines were removed on 12 Nov 2026).
// Use: <footer class="vfoot"></footer><script src="/footer.js"></script>  (a link to the page you're on becomes "กลับหน้าแรก")
(function () {
  var CONTACT = "phitsanu.tr@outlook.com";

  if (!document.getElementById("vfootCss")) {
    var st = document.createElement("style"); st.id = "vfootCss";
    st.textContent =
      "html { overflow-x: clip; }" +
      ".vfoot { margin-top: auto; padding-top: 24px; text-align: center; font-size: 12px; line-height: 16px; color: #5f6b73; }" +
      ".vfoot .vc { white-space: normal; }" +
      ".vfoot a { color: inherit; text-decoration: none; }" +
      ".vfoot a:hover { text-decoration: underline; }";
    document.head.appendChild(st);
  }

  function links() {
    var here = location.pathname.replace(/\/+$/, "") || "/", home = '<a href="/">กลับหน้าแรก</a>';
    var parts = [here === "/privacy" ? home : '<a href="/privacy">ความเป็นส่วนตัว</a>', here === "/terms" ? home : '<a href="/terms">เงื่อนไข</a>', '<a href="mailto:' + CONTACT + '">ติดต่อ</a>'];
    return "© 2026 VanTrip · " + parts.join(" · ");
  }

  function mount(f) {
    if (f.getAttribute("data-on")) return; f.setAttribute("data-on", "1");
    f.innerHTML = '<div class="vc">' + links() + "</div>";
  }

  [].forEach.call(document.querySelectorAll("footer.vfoot"), mount);
})();
