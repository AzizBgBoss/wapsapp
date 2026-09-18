const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// tiny .env loader (no extra dependency)
(function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const idx = trimmed.indexOf('=');
        if (idx === -1) return;
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (!(key in process.env)) process.env[key] = val;
    });
})();

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'change-this-token'; // shared-secret, single-user auth

const MEDIA_CACHE_DIR = path.join(__dirname, 'media-cache');
if (!fs.existsSync(MEDIA_CACHE_DIR)) fs.mkdirSync(MEDIA_CACHE_DIR);

const AVATAR_TTL = 30 * 60 * 1000; // profile pics rarely change
const CONTACT_NAME_TTL = 60 * 60 * 1000; // names change even less
const CHAT_LIST_TTL = 4000; // just enough to de-dupe rapid reloads/back-nav

const avatarCache = new Map(); // id -> { url, ts }
const contactNameCache = new Map(); // id -> { name, ts }
let chatListCache = { data: null, ts: 0 };

let waReady = false;
let lastQr = null; // data URL of the current QR, if any

const wa = new Client({
    authStrategy: new LocalAuth({ dataPath: './wa-session' }),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

wa.on('qr', async qr => {
    lastQr = await qrcode.toDataURL(qr);
    console.log('\nScan this QR code with WhatsApp (or visit /login):\n');
    qrcodeTerminal.generate(qr, { small: true });
});

wa.on('authenticated', () => {
    lastQr = null;
    console.log('WhatsApp authenticated.');
});

wa.on('ready', () => {
    waReady = true;
    lastQr = null;
    console.log('WhatsApp is ready.');
});

wa.on('auth_failure', msg => {
    console.error('Auth failure:', msg);
});

wa.on('disconnected', reason => {
    console.log('WhatsApp disconnected:', reason);
    waReady = false;
});

// ---- helpers ----

function serializedId(id) {
    return id?._serialized || id?.$1;
}

function chatTitle(chat) {
    return chat.name || chat.formattedTitle || chat.id?.user || 'Unknown';
}

function linkify(escapedText) {
    return escapedText.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

async function getAvatarUrl(id) {
    const cached = avatarCache.get(id);
    if (cached && (Date.now() - cached.ts) < AVATAR_TTL) {
        return cached.url;
    }
    let url = null;
    try {
        url = await wa.getProfilePicUrl(id);
    } catch (e) {
        url = null;
    }
    avatarCache.set(id, { url, ts: Date.now() });
    return url;
}

async function getContactName(id) {
    const cached = contactNameCache.get(id);
    if (cached && (Date.now() - cached.ts) < CONTACT_NAME_TTL) {
        return cached.name;
    }
    let name = id;
    try {
        const contact = await wa.getContactById(id);
        name = contact?.name || contact?.pushname || contact?.number || id;
    } catch (e) { /* keep raw id */ }
    contactNameCache.set(id, { name, ts: Date.now() });
    return name;
}

function mediaCachePaths(msgId) {
    const key = crypto.createHash('sha1').update(msgId).digest('hex');
    return {
        data: path.join(MEDIA_CACHE_DIR, key + '.bin'),
        meta: path.join(MEDIA_CACHE_DIR, key + '.json')
    };
}

function requireAuth(req, res, next) {
    if (req.cookies?.token === AUTH_TOKEN || req.query.token === AUTH_TOKEN) {
        return next();
    }
    res.redirect('/token?next=' + encodeURIComponent(req.originalUrl));
}

// very small cookie parser (avoid extra deps)
function cookieParser(req, res, next) {
    req.cookies = {};
    const header = req.headers.cookie;
    if (header) {
        header.split(';').forEach(pair => {
            const idx = pair.indexOf('=');
            if (idx > -1) {
                const key = pair.slice(0, idx).trim();
                const val = pair.slice(idx + 1).trim();
                req.cookies[key] = decodeURIComponent(val);
            }
        });
    }
    next();
}

// ---- app setup ----

const app = express();
app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');
app.use(express.static(__dirname + '/public', { maxAge: '1d' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser);

// ---- auth / setup pages ----

app.get('/token', (req, res) => {
    res.render('token', { next: req.query.next || '/' });
});

app.post('/token', (req, res) => {
    if (req.body.token === AUTH_TOKEN) {
        res.setHeader('Set-Cookie', `token=${encodeURIComponent(AUTH_TOKEN)}; Path=/; Max-Age=31536000`);
        res.redirect(req.body.next || '/');
    } else {
        res.render('token', { next: req.body.next || '/', error: 'Wrong token.' });
    }
});

app.get('/login', requireAuth, (req, res) => {
    res.render('login', { waReady, qr: lastQr });
});

// ---- chat list ----

app.post('/start', requireAuth, async (req, res) => {
    try {
        let number = (req.body.number || '').replace(/[^0-9]/g, '');
        if (!number) return res.redirect('/');
        const id = `${number}@c.us`;
        const isRegistered = await wa.isRegisteredUser(id);
        if (!isRegistered) return res.status(404).send('Number not on WhatsApp');
        res.redirect(`/chat/${encodeURIComponent(id)}?token=${req.cookies.token || ''}`);
    } catch (e) {
        console.error('start convo error:', e);
        res.status(500).send('Could not start conversation: ' + (e?.message || e));
    }
});

app.get('/', requireAuth, async (req, res) => {
    if (!waReady) return res.redirect('/login');

    try {
        if (chatListCache.data && (Date.now() - chatListCache.ts) < CHAT_LIST_TTL) {
            return res.render('chatlist', { chats: chatListCache.data });
        }

        let chats = await wa.getChats();
        chats = chats
            .filter(c => !c.isStatus)
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        const view = chats.map(c => ({
            id: serializedId(c.id),
            title: chatTitle(c),
            unread: c.unreadCount || 0,
            lastMessage: c.lastMessage?.body || '',
            avatar: null
        }));

        chatListCache = { data: view, ts: Date.now() };
        res.render('chatlist', { chats: view });
    } catch (e) {
        console.error('chat list error:', e);
        res.status(500).send('Error loading chats: ' + (e?.message || e));
    }
});

app.get('/avatar/:id', requireAuth, async (req, res) => {
    try {
        const url = await getAvatarUrl(req.params.id);
        res.json({ url });
    } catch (e) {
        res.json({ url: null });
    }
});

// ---- single chat ----

app.get('/chat/:id', requireAuth, async (req, res) => {
    if (!waReady) return res.redirect('/login');

    try {
        const chat = await wa.getChatById(req.params.id);
        const messages = await chat.fetchMessages({ limit: 30 });

        const view = messages.map(m => ({
            id: m.id?._serialized || m.id?.$1,
            fromMe: m.fromMe,
            name: m.fromMe ? 'You' : (m._data?.notifyName || chat.name || 'Unknown'),
            text: linkify(escapeHtml(m.body || '')),
            hasMedia: m.hasMedia,
            mediaType: m.type,
            timestamp: m.timestamp
        }));

        res.render('chat', {
            chatId: req.params.id,
            title: chatTitle(chat),
            messages: view,
            isGroup: chat.isGroup
        });
    } catch (e) {
        console.error('chat load error:', e);
        res.status(500).send('Error loading chat: ' + (e?.message || e));
    }
});

// poll: returns an HTML fragment of messages newer than ?since=<unix ts>
app.get('/chat/:id/poll', requireAuth, async (req, res) => {
    try {
        const chat = await wa.getChatById(req.params.id);
        const since = Number(req.query.since) || 0;

        const messages = await chat.fetchMessages({ limit: 30 });
        const fresh = messages.filter(m => (m.timestamp || 0) > since);

        const chatIdSerialized = serializedId(chat.id);
        res.set('Content-Type', 'text/html');
        res.send(
            fresh.map(m => {
                const name = m.fromMe ? 'You' : (m._data?.notifyName || chat.name || 'Unknown');
                const cls = m.fromMe ? 'out' : 'in';
                const msgId = m.id?._serialized || m.id?.$1;
                const time = formatTime(m.timestamp);
                let mediaHtml = '';
                if (m.hasMedia) {
                    const mediaUrl = `/media/${encodeURIComponent(msgId)}/${encodeURIComponent(chatIdSerialized)}`;
                    mediaHtml = m.type === 'image'
                        ? `<br><img class="thumb" src="${mediaUrl}" loading="lazy"><br><a href="${mediaUrl}" target="_blank">View full</a>`
                        : `<br><a href="${mediaUrl}" target="_blank">View attachment</a>`;
                }
                return `<div class="msg ${cls}" data-ts="${m.timestamp}"><b>${name}:</b> ${linkify(escapeHtml(m.body || ''))}${mediaHtml}<span class="time">${time}</span></div>`;
            }).join('')
        );
    } catch (e) {
        console.error('poll error:', e);
        res.status(500).send('');
    }
});

app.get('/chat/:id/older', requireAuth, async (req, res) => {
    try {
        const chat = await wa.getChatById(req.params.id);
        const before = Number(req.query.before) || Math.floor(Date.now() / 1000);
        const chatIdSerialized = serializedId(chat.id);

        const messages = await chat.fetchMessages({ limit: 100 });
        const older = messages.filter(m => (m.timestamp || 0) < before).slice(-20);

        res.set('Content-Type', 'text/html');
        res.send(
            older.map(m => {
                const name = m.fromMe ? 'You' : (m._data?.notifyName || chat.name || 'Unknown');
                const cls = m.fromMe ? 'out' : 'in';
                const msgId = m.id?._serialized || m.id?.$1;
                const time = formatTime(m.timestamp);
                let mediaHtml = '';
                if (m.hasMedia) {
                    const mediaUrl = `/media/${encodeURIComponent(msgId)}/${encodeURIComponent(chatIdSerialized)}`;
                    mediaHtml = m.type === 'image'
                        ? `<br><img class="thumb" src="${mediaUrl}" loading="lazy"><br><a href="${mediaUrl}" target="_blank">View full</a>`
                        : `<br><a href="${mediaUrl}" target="_blank">View attachment</a>`;
                }
                return `<div class="msg ${cls}" data-ts="${m.timestamp}"><b>${name}:</b> ${linkify(escapeHtml(m.body || ''))}${mediaHtml}<span class="time">${time}</span></div>`;
            }).reverse().join('')
        );
    } catch (e) {
        console.error('older error:', e);
        res.status(500).send('');
    }
});

app.post('/chat/:id/send', requireAuth, async (req, res) => {
    try {
        const chat = await wa.getChatById(req.params.id);
        const text = (req.body.text || '').trim();
        if (text) {
            const sent = await chat.sendMessage(text);
            if (req.xhr || req.headers.accept?.includes('application/json')) {
                const time = formatTime(sent.timestamp);
                return res.send(
                    `<div class="msg out" data-ts="${sent.timestamp}"><b>You:</b> ${linkify(escapeHtml(text))}<span class="time">${time}</span></div>`
                );
            }
        }
        res.redirect(`/chat/${req.params.id}?token=${req.cookies.token || ''}`);
    } catch (e) {
        console.error('send error:', e);
        res.status(500).send('Send failed: ' + (e?.message || e));
    }
});

app.get('/chat/:id/search', requireAuth, async (req, res) => {
    try {
        const q = req.query.q || '';
        const results = q
            ? await wa.searchMessages(q, { chatId: req.params.id, limit: 20 })
            : [];

        res.render('search', {
            chatId: req.params.id,
            query: q,
            results: results.map(m => ({
                fromMe: m.fromMe,
                text: m.body || '[media]'
            }))
        });
    } catch (e) {
        console.error('search error:', e);
        res.status(500).send('Search failed: ' + (e?.message || e));
    }
});

app.get('/chat/:id/who', requireAuth, async (req, res) => {
    try {
        const chat = await wa.getChatById(req.params.id);
        if (!chat.isGroup) return res.send('<p>Not a group.</p>');

        const participants = chat.groupMetadata?.participants || [];
        const resolved = await Promise.all(
            participants.map(async p => {
                const id = serializedId(p.id) || p.id?.user || 'unknown';
                const name = await getContactName(id);
                const role = p.isSuperAdmin ? ' (owner)' : (p.isAdmin ? ' (admin)' : '');
                return `<div>${escapeHtml(name)}${role}</div>`;
            })
        );

        res.send(resolved.join(''));
    } catch (e) {
        console.error('who error:', e);
        res.status(500).send('');
    }
});

app.get('/media/:msgId/:chatId', requireAuth, async (req, res) => {
    try {
        const { data: dataPath, meta: metaPath } = mediaCachePaths(req.params.msgId);

        if (fs.existsSync(dataPath) && fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            res.set('Content-Type', meta.mimetype);
            res.set('Cache-Control', 'private, max-age=31536000, immutable');
            return res.sendFile(dataPath);
        }

        const chat = await wa.getChatById(req.params.chatId);
        const messages = await chat.fetchMessages({ limit: 50 });
        const msg = messages.find(m => (m.id?._serialized || m.id?.$1) === req.params.msgId);

        if (!msg || !msg.hasMedia) return res.status(404).send('Not found');

        const media = await msg.downloadMedia();
        const buffer = Buffer.from(media.data, 'base64');

        // cache to disk so repeat views (or a poll re-rendering the same <img>) don't
        // re-download/re-decrypt the same media from WhatsApp every time
        fs.writeFile(dataPath, buffer, () => {});
        fs.writeFile(metaPath, JSON.stringify({ mimetype: media.mimetype }), () => {});

        res.set('Content-Type', media.mimetype);
        res.set('Cache-Control', 'private, max-age=31536000, immutable');
        res.send(buffer);
    } catch (e) {
        console.error('media error:', e);
        res.status(500).send('Media error');
    }
});

function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`wa-web listening on http://localhost:${PORT}`);
});

wa.initialize().catch(err => {
    console.error('WhatsApp initialize failed:', err);
});
