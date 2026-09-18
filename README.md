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

## Run

```
npm start
```

Visit `http://<server-ip>:3000`, enter your token, then scan the QR code
with WhatsApp (Linked Devices) to log in.

## Features

- Chat list with contact/group avatars and unread counts
- Live chat view with polling for new messages (no full refresh)
- Sends messages via AJAX, appended smoothly without reload
- "See more above" to load older messages
- Clickable links in messages
- Inline image previews with a "view full" link, other attachments as a download link
- Start a new conversation by phone number (with country code)
- Group "who" participant list
- Message search within a chat

## Notes

- `wa-session/` holds your WhatsApp login session — keep it private, do not commit it.
- `.env` holds your auth token — do not commit it.
- `media-cache/` holds cached downloaded attachments (see Caching below) — safe to delete anytime, it'll be rebuilt on demand.

## Caching

WhatsApp Web itself caches chats/messages in the page's own memory once loaded,
but the server was redoing expensive work on top of that on every request. Added:

- **Avatars**: profile picture URLs are cached in memory for 30 minutes instead
  of being re-fetched from WhatsApp on every chat-list load.
- **Media**: downloaded attachments (images, docs, etc.) are cached to disk in
  `media-cache/`, keyed by message ID, with a far-future `Cache-Control` header
  so the browser doesn't even re-request them on repeat views or polls.
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

## whatsapp-web.js media download patch

`node scripts/patch-wwebjs.js` works around an upstream whatsapp-web.js bug
(opaque `r: r` error from `Message.downloadMedia()`, see
[wwebjs/whatsapp-web.js#201828](https://github.com/wwebjs/whatsapp-web.js/issues/201828))
by adding a more resilient message-lookup helper. It edits files inside
`node_modules`, so it runs automatically via the `postinstall` script every
time you `npm install`. It's idempotent — safe to run again manually with
`npm run postinstall` if you ever suspect the patch didn't take (e.g. after
upgrading the `whatsapp-web.js` version, where the anchors it searches for
might have moved and it will just skip with a warning instead of applying).
