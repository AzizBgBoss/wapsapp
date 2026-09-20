# WapsApp

A minimal, self-hosted WhatsApp Web client built with Express + whatsapp-web.js,
designed to be lightweight enough to use from old browsers (e.g. BlackBerry NetFront).

## Setup

```
npm install
```

Copy `.env` and set your own token:

```
AUTH_TOKEN=your-secret-token
PORT=3000
```

Optional but recommended: install [ffmpeg](https://ffmpeg.org/) and make sure
it's on your PATH. It's used to transcode voice notes to MP3 and to offer
480p/360p video downscaling. Nothing breaks without it — those features just
fall back to serving the original file and log a one-time notice.

## Run

```
npm start
```

Visit `http://<server-ip>:3000`, enter your token, then scan the QR code
with WhatsApp (Linked Devices) to log in.

Stop the server with Ctrl+C — it closes the WhatsApp/Puppeteer session
cleanly on `SIGINT`/`SIGTERM` so the next start doesn't hit a stuck
"browser is already running" error. If that error does show up anyway (e.g.
after a crash, or Windows holding a stale process-singleton lock even with
no visible `chrome.exe`/`node.exe`), the most reliable fix is a full reboot;
short of that, renaming/deleting `wa-session/` forces a fresh login.

## Features

- Chat list with contact/group avatars and unread counts
- Live chat view with polling for new messages (no full refresh)
- Sends messages via AJAX, appended smoothly without reload
- "See more above" to load older messages
- Clickable links in messages
- Inline image previews with a "view full" link
- Voice notes play inline (`<audio>`) with a "view full" link fallback for
  devices that can't play HTML5 audio; transcoded to MP3 automatically if
  ffmpeg is available (WhatsApp sends them as Opus/OGG, which many old
  devices can't decode)
- Videos offer "View full", "480p", and "360p" links, downscaled on demand
  via ffmpeg (falls back to the original file if ffmpeg is missing)
- Other attachments shown as a download link labeled with their mimetype
- Start a new conversation by phone number (with country code)
- **About page** (`/chat/:id/about`) for every conversation, group or DM:
  avatar, name, phone number, and full participant list (with roles) for
  groups
- Chat header shows the conversation's avatar next to its name
- Group messages show the actual sender's name, not the group's name
- Message search within a chat
- Proactive media caching: new incoming/outgoing media is downloaded and
  cached to disk the moment it arrives (see Caching below), instead of
  relying on WhatsApp's temporary media hosting window

## Notes

- `wa-session/` holds your WhatsApp login session — keep it private, do not commit it.
- `.env` holds your auth token — do not commit it.
- `media-cache/` holds cached downloaded attachments (see Caching below) — safe to delete anytime, it'll be rebuilt on demand where WhatsApp still has the media.

## Caching

WhatsApp Web itself caches chats/messages in the page's own memory once loaded,
but the server was redoing expensive work on top of that on every request. Added:

- **Avatars**: profile picture URLs are cached in memory for 30 minutes instead
  of being re-fetched from WhatsApp on every chat-list load.
- **Media**: downloaded attachments (images, voice notes, videos, docs, etc.)
  are cached to disk in `media-cache/`, keyed by message ID (and quality, for
  downscaled video), with a far-future `Cache-Control` header so the browser
  doesn't even re-request them on repeat views or polls.
- **Proactive media caching**: rather than only caching on-view, a
  `message_create` listener downloads and caches media the moment it's sent
  or received, while it's still the live in-page message model. This matters
  because WhatsApp only mirrors media for a limited window — media pulled
  later via `fetchMessages()` can 404 once that window closes, and (for
  older/LID-addressed messages) can't always be looked up in the page's live
  message store for decryption at all. Grabbing it immediately sidesteps
  both problems.
- **Chat list**: the rendered chat list is cached in memory for 4 seconds, to
  de-dupe rapid reloads (e.g. quick back-and-forth navigation).
- **Group participant names**: cached in memory for 1 hour.
- **Static assets** (`style.css`, `poll.js`, `chatlist.js`) are served with a
  1-day `Cache-Control` header.
- **Avatars are lazy-loaded**: the chat list renders immediately with letter
  placeholders, then `chatlist.js` fetches each contact's picture from
  `/avatar/:id` a few at a time in the background. This matters because the
  single headless Chromium tab (and Node's single event loop) is shared by
  everything the app does — fetching 100+ avatars up front, all at once,
  before the first response, was enough to make the whole server feel frozen
  right after WhatsApp connects. Note that `wa.getChats()` itself (from
  whatsapp-web.js) still does its own metadata refresh per group chat, so a
  large number of groups can still make the very first chat-list load after
  "ready" noticeably slow — that part isn't something this app controls.

## Media download: known WhatsApp/whatsapp-web.js issues and workarounds

Media downloading hit two separate upstream problems, both worked around in
`server.js`'s `/media/:msgId/:chatId` route:

1. **Message lookup failure for LID-addressed chats.** In mid-2026 WhatsApp's
   own web app renamed the internal serialized-id field from `_serialized` to
   `$1` ([wwebjs/whatsapp-web.js#201833](https://github.com/wwebjs/whatsapp-web.js/issues/201833)).
   `scripts/patch-wwebjs.js` (see below) now tries both, restoring
   `downloadMedia()`'s ability to find messages pulled via `fetchMessages()`.
2. **Video-specific decrypt gaps in the manual fallback path.** If the patched
   `downloadMedia()` still comes back empty, the route falls back to
   reconstructing the decrypt call itself from the raw message fields
   (`directPath`, `mediaKey`, etc.). This works reliably for images, audio,
   and documents, but video's internal streaming-sidecar data doesn't survive
   the trip across Puppeteer's serialization boundary intact, so very old or
   otherwise-inaccessible videos can still fail even after the patch. Videos
   that are still within WhatsApp's normal media-hosting window work fine via
   the (now-fixed) primary path.

If media genuinely fails (WhatsApp's hosting window has closed and it was
never proactively cached), the route returns a friendly message naming the
media's type/mimetype and suggesting you open WhatsApp on your phone and
view it there once.

## BlackBerry 6 WebKit compatibility

The 9700's WebKit browser (BlackBerry OS6, ~2010-era WebKit) predates Flexbox,
`position: sticky`, and `object-fit`. Fixes applied in `style.css`:

- `box-sizing: border-box` and `border-radius` are prefixed with `-webkit-`
  as well as unprefixed, since the old engine ignores the unprefixed form.
- Every `display: flex` layout (`.chatitem`, `.startform`, `.avatar-default`,
  `.header`, `.participant`) has a `display: block` fallback plus the old
  `-webkit-box` flexbox syntax before the modern `display: flex`/`flex: 1`
  rules, so layout doesn't collapse to inline on the old engine.
- `position: sticky` on the header/toolbar degrades gracefully to normal
  static positioning there — not a bug, just a lost nicety on that browser.
- `object-fit: cover` on avatars has no real fallback in pure CSS; non-square
  profile pictures will stretch instead of crop on that browser.
- `poll.js`'s "see more above" no longer uses `insertAdjacentHTML` (spotty
  support on that engine) — it builds nodes via `createDocumentFragment` and
  `insertBefore` instead, which is safe on virtually any browser.

All of `poll.js` and `chatlist.js` were already plain ES5 (`var`, function
expressions, callback-style `XMLHttpRequest`) with no arrow functions,
`let`/`const`, template literals, or `fetch` — no changes needed there.

## whatsapp-web.js message-lookup patch

`node scripts/patch-wwebjs.js` works around two upstream whatsapp-web.js
issues by adding a more resilient message-lookup helper:

- opaque `r: r` error from `Message.downloadMedia()`
  ([wwebjs/whatsapp-web.js#201828](https://github.com/wwebjs/whatsapp-web.js/issues/201828))
- broken lookup for LID-addressed messages after WhatsApp's `_serialized` →
  `$1` rename
  ([wwebjs/whatsapp-web.js#201833](https://github.com/wwebjs/whatsapp-web.js/issues/201833))

It edits files inside `node_modules`, so it runs automatically via the
`postinstall` script every time you `npm install`. It's idempotent — safe to
run again manually with `npm run postinstall` if you ever suspect the patch
didn't take (e.g. after upgrading the `whatsapp-web.js` version, where the
anchors it searches for might have moved and it will just skip with a
warning instead of applying).
