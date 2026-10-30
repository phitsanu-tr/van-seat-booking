# Tests

Browser tests that drive the real pages in Chromium against the local dev server
(`dev.js`: fake Redis in memory, fake LINE accounts). Nothing touches Upstash or LINE.

## First time

```sh
cd tests
npm install                     # Playwright + the two Thai fonts (for realistic screenshots)
npx playwright install chromium # the browser, ~150 MB, once per machine
```

## Run

```sh
node tests/run.js            # all tests (about 4 minutes)
node tests/run.js 05 08      # only files starting with 05 or 08
```

Each test gets a fresh dev server on port 8765 (stop your own `node dev.js` first, or set `PORT`).
A test passes when it exits cleanly, the pages threw no JavaScript errors, and what it printed
matches `tests/expected/<name>.txt`. Screenshots go to `tests/out/` (not committed).

## When a change is on purpose

If you change behaviour on purpose and a test now prints something different, check the
difference shown, then save the new output:

```sh
node tests/run.js 05 --update
```

In expected files, trip ids and timestamps are masked, and `{a..b}` accepts any whole number
from a to b (used for counts that depend on timing).

## What each test covers

| File | Covers |
|---|---|
| 01-login | must sign in to create or book, account chip, LINE in-app auto sign-in |
| 02-limit-wipe | seats-per-person limit, "delete my data" (as booker and as owner) |
| 03-roster-move | organizer roster, rename, move and swap seats, booker-only rights |
| 04-share-delete | seat-pass picture and share link, deleting a trip |
| 05-team-hold | helper invites (one person per link, max 3), helper rights, transfer, seat hold while signing in |
| 06-notify | notifications for trip changes, moves, renames, cancels, deleted trips; change banner |
| 07-polling | hold per browser, polling slows when idle and resumes on touch (fake clock) |
| 08-inbox-rename | read state survives new notifications, bell updates on an open page, "⋯" rename menu, no dark-theme CSS |
| 09-roster-scroll | a long passenger list scrolls inside the sheet on a short phone screen |
| 10-checkin | check-in ticks: organizer-only, hidden from passengers, follow moves, live refresh; paid ticks rejected |
| 11-routes | link scheme: /mytrips, /trips/new, /trips/<id>, old /trips#<id>-o, seat-pass picture outside LINE |
| 12-close-booking | close/reopen bookings, automatic closing time, what passengers and organizers can still do |
| 13-copy-duplicate | copy the passenger list as text, duplicate a trip (upcoming and finished) |
| 14-rounds | check-in rounds: names, new round, history, privacy, read-only summary after the trip |
