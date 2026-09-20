const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

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

// Proactively cache media as it arrives. WhatsApp only mirrors media for a
// limited window, and messages pulled later via fetchMessages() can't be
// looked up in the live message store for decryption (see /media route),
// so we grab it now while `msg` is still the real live model.
wa.on('message_create', async msg => {
    if (!msg.hasMedia) return;
    try {
        const msgId = msg.id?._serialized || msg.id?.$1;
        if (!msgId) return;
        const { data: dataPath, meta: metaPath } = mediaCachePaths(msgId);
        if (fs.existsSync(dataPath)) return; // already cached

        const media = await msg.downloadMedia();
        if (!media || !media.data) {
            console.log('[auto-cache] could not download media for', msgId);
            return;
        }
        const transcoded = await maybeTranscodeToMp3(media, msg.type);
        const buffer = Buffer.from(transcoded.data, 'base64');
        fs.writeFile(dataPath, buffer, () => {});
        fs.writeFile(metaPath, JSON.stringify({ mimetype: transcoded.mimetype }), () => {});
        console.log('[auto-cache] cached media for', msgId);
    } catch (e) {
        console.log('[auto-cache] error:', e && e.message || e);
    }
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

// For group chats, the sender's own name (not the group's name). Falls back to
// notifyName, then resolves the participant's contact name from m.author.
async function messageSenderName(m, chat) {
    if (m.fromMe) return 'You';
    if (chat.isGroup) {
        if (m._data?.notifyName) return m._data.notifyName;
        const authorId = typeof m.author === 'string' ? m.author : serializedId(m.author);
        if (authorId) return await getContactName(authorId);
        return 'Unknown';
    }
    return m._data?.notifyName || chat.name || 'Unknown';
}

function mediaCachePaths(msgId, quality) {
    const key = crypto.createHash('sha1').update(msgId + (quality ? ':' + quality : '')).digest('hex');
    return {
        data: path.join(MEDIA_CACHE_DIR, key + '.bin'),
        meta: path.join(MEDIA_CACHE_DIR, key + '.json')
    };
}

let ffmpegMissingLogged = false;

// Transcodes WhatsApp voice notes (Opus/OGG) to MP3 so older devices without
// Opus support (e.g. the PSP's NetFront browser) can play them. Fully
// optional: if ffmpeg isn't installed, this logs once and the caller keeps
// serving the original media untouched.
function maybeTranscodeToMp3(media, type) {
    const isVoiceNote = type === 'ptt' || (media.mimetype && media.mimetype.includes('ogg'));
    if (!isVoiceNote) return Promise.resolve(media);

    return new Promise(resolve => {
        const inputBuffer = Buffer.from(media.data, 'base64');
        let ff;
        try {
            ff = spawn('ffmpeg', ['-i', 'pipe:0', '-f', 'mp3', '-codec:a', 'libmp3lame', '-qscale:a', '4', 'pipe:1']);
        } catch (e) {
            if (!ffmpegMissingLogged) {
                console.log('[transcode] ffmpeg not found, cannot transcode media, displaying media as is');
                ffmpegMissingLogged = true;
            }
            return resolve(media);
        }

        const chunks = [];
        let settled = false;
        ff.stdout.on('data', c => chunks.push(c));
        ff.stderr.on('data', () => {}); // discard ffmpeg's own logging
        ff.on('error', (e) => {
            if (settled) return;
            settled = true;
            if (e.code === 'ENOENT' && !ffmpegMissingLogged) {
                console.log('[transcode] ffmpeg not found, cannot transcode media, displaying media as is');
                ffmpegMissingLogged = true;
            } else {
                console.log('[transcode] ffmpeg error, displaying media as is:', e.message);
            }
            resolve(media);
        });
        ff.on('close', code => {
            if (settled) return;
            settled = true;
            if (code === 0 && chunks.length) {
                const mp3Buffer = Buffer.concat(chunks);
                resolve({ data: mp3Buffer.toString('base64'), mimetype: 'audio/mpeg', filename: media.filename, filesize: mp3Buffer.length });
            } else {
                console.log('[transcode] ffmpeg exited with code', code, '- displaying media as is');
                resolve(media);
            }
        });
        ff.stdin.write(inputBuffer);
        ff.stdin.end();
    });
}

// Downscales video to a target height (480 or 360) so slower devices/connections
// can play it. Written to a real temp file rather than piped to stdout: piping
// can't seek back to place the moov atom up front, so ffmpeg was forced to use
// a fragmented MP4 (empty_moov), which old browsers like the BB's can't play at
// all. A temp file lets us produce a classic faststart MP4 in Baseline/yuv420p,
// which ancient hardware decoders actually understand. Optional: if ffmpeg is
// missing, logs once and returns null so the caller falls back to serving the
// original file.
function transcodeVideo(inputBuffer, targetHeight) {
    return new Promise(resolve => {
        const tmpOut = path.join(os.tmpdir(), `wapsapp-${crypto.randomBytes(8).toString('hex')}.mp4`);
        const cleanup = () => fs.unlink(tmpOut, () => {});
        let ff;
        try {
            ff = spawn('ffmpeg', [
                '-i', 'pipe:0',
                '-vf', `scale=-2:${targetHeight}`,
                '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0', '-pix_fmt', 'yuv420p',
                '-preset', 'veryfast', '-crf', '28',
                '-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '44100', '-b:a', '96k',
                '-movflags', '+faststart',
                '-f', 'mp4',
                '-y', tmpOut
            ]);
        } catch (e) {
            if (!ffmpegMissingLogged) {
                console.log('[transcode] ffmpeg not found, cannot transcode media, displaying media as is');
                ffmpegMissingLogged = true;
            }
            return resolve(null);
        }

        let settled = false;
        ff.stderr.on('data', () => {});
        ff.on('error', (e) => {
            if (settled) return;
            settled = true;
            if (e.code === 'ENOENT' && !ffmpegMissingLogged) {
                console.log('[transcode] ffmpeg not found, cannot transcode media, displaying media as is');
                ffmpegMissingLogged = true;
            } else {
                console.log('[transcode] ffmpeg error, displaying media as is:', e.message);
            }
            cleanup();
            resolve(null);
        });
        ff.on('close', code => {
            if (settled) return;
            settled = true;
            if (code === 0 && fs.existsSync(tmpOut)) {
                fs.readFile(tmpOut, (err, buf) => {
                    cleanup();
                    resolve(err ? null : buf);
                });
            } else {
                console.log('[transcode] ffmpeg exited with code', code, '- displaying media as is');
                cleanup();
                resolve(null);
            }
        });
        ff.stdin.write(inputBuffer);
        ff.stdin.end();
    });
}

// Downscales a JPEG/PNG image to a small, low-quality preview so slow/old
// devices (like the BB) aren't stuck downloading full-res photos just to
// show a thumbnail. Same optional-ffmpeg pattern as the other transcoders:
// if ffmpeg is missing, resolves null and the caller falls back to the original.
function transcodeImageThumb(inputBuffer) {
    return new Promise(resolve => {
        let ff;
        try {
            ff = spawn('ffmpeg', [
                '-i', 'pipe:0',
                '-vf', 'scale=-1:240',
                '-q:v', '12',
                '-f', 'mjpeg',
                'pipe:1'
            ]);
        } catch (e) {
            if (!ffmpegMissingLogged) {
                console.log('[transcode] ffmpeg not found, cannot transcode media, displaying media as is');
                ffmpegMissingLogged = true;
            }
            return resolve(null);
        }

        const chunks = [];
        let settled = false;
        ff.stdout.on('data', c => chunks.push(c));
        ff.stderr.on('data', () => {});
        ff.on('error', (e) => {
            if (settled) return;
            settled = true;
            if (e.code === 'ENOENT' && !ffmpegMissingLogged) {
                console.log('[transcode] ffmpeg not found, cannot transcode media, displaying media as is');
                ffmpegMissingLogged = true;
            } else {
                console.log('[transcode] ffmpeg error, displaying media as is:', e.message);
            }
            resolve(null);
        });
        ff.on('close', code => {
            if (settled) return;
            settled = true;
            if (code === 0 && chunks.length) {
                resolve(Buffer.concat(chunks));
            } else {
                console.log('[transcode] ffmpeg exited with code', code, '- displaying media as is');
                resolve(null);
            }
        });
        ff.stdin.write(inputBuffer);
        ff.stdin.end();
    });
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
        const messages = await chat.fetchMessages({ limit: 10 });
        const avatar = await getAvatarUrl(req.params.id);

        const view = await Promise.all(messages.map(async m => ({
            id: m.id?._serialized || m.id?.$1,
            fromMe: m.fromMe,
            name: await messageSenderName(m, chat),
            text: linkify(escapeHtml(m.body || '')),
            hasMedia: m.hasMedia,
            mediaType: m.type,
            mimetype: m._data?.mimetype,
            timestamp: m.timestamp
        })));

        res.render('chat', {
            chatId: req.params.id,
            title: chatTitle(chat),
            avatar,
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
        const rendered = await Promise.all(fresh.map(async m => {
                const name = await messageSenderName(m, chat);
                const cls = m.fromMe ? 'out' : 'in';
                const msgId = m.id?._serialized || m.id?.$1;
                const time = formatTime(m.timestamp);
                let mediaHtml = '';
                if (m.hasMedia) {
                    const mediaUrl = `/media/${encodeURIComponent(msgId)}/${encodeURIComponent(chatIdSerialized)}`;
                    if (m.type === 'image') {
                        mediaHtml = `<br><img class="thumb" src="${mediaUrl}?quality=thumb" loading="lazy"><br><a href="${mediaUrl}" target="_blank">View full</a>`;
                    } else if (m.type === 'ptt' || m.type === 'audio') {
                        mediaHtml = `<br><audio controls src="${mediaUrl}">Your browser does not support audio playback.</audio><br><a href="${mediaUrl}" target="_blank">View full</a>`;
                    } else if (m.type === 'video') {
                        mediaHtml = `<br><a href="${mediaUrl}" target="_blank">View full</a> | <a href="${mediaUrl}?quality=480" target="_blank">480p</a> | <a href="${mediaUrl}?quality=360" target="_blank">360p</a>`;
                    } else {
                        mediaHtml = `<br><a href="${mediaUrl}" target="_blank">View attachment${m._data?.mimetype ? ' (' + escapeHtml(m._data.mimetype) + ')' : ''}</a>`;
                    }
                }
                return `<div class="msg ${cls}" data-ts="${m.timestamp}"><b>${name}:</b> ${linkify(escapeHtml(m.body || ''))}${mediaHtml}<span class="time">${time}</span></div>`;
            }));
        res.send(rendered.join(''));
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
        const rendered = await Promise.all(older.map(async m => {
                const name = await messageSenderName(m, chat);
                const cls = m.fromMe ? 'out' : 'in';
                const msgId = m.id?._serialized || m.id?.$1;
                const time = formatTime(m.timestamp);
                let mediaHtml = '';
                if (m.hasMedia) {
                    const mediaUrl = `/media/${encodeURIComponent(msgId)}/${encodeURIComponent(chatIdSerialized)}`;
                    if (m.type === 'image') {
                        mediaHtml = `<br><img class="thumb" src="${mediaUrl}?quality=thumb" loading="lazy"><br><a href="${mediaUrl}" target="_blank">View full</a>`;
                    } else if (m.type === 'ptt' || m.type === 'audio') {
                        mediaHtml = `<br><audio controls src="${mediaUrl}">Your browser does not support audio playback.</audio><br><a href="${mediaUrl}" target="_blank">View full</a>`;
                    } else if (m.type === 'video') {
                        mediaHtml = `<br><a href="${mediaUrl}" target="_blank">View full</a> | <a href="${mediaUrl}?quality=480" target="_blank">480p</a> | <a href="${mediaUrl}?quality=360" target="_blank">360p</a>`;
                    } else {
                        mediaHtml = `<br><a href="${mediaUrl}" target="_blank">View attachment${m._data?.mimetype ? ' (' + escapeHtml(m._data.mimetype) + ')' : ''}</a>`;
                    }
                }
                return `<div class="msg ${cls}" data-ts="${m.timestamp}"><b>${name}:</b> ${linkify(escapeHtml(m.body || ''))}${mediaHtml}<span class="time">${time}</span></div>`;
            }));
        res.send(rendered.reverse().join(''));
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

app.get('/chat/:id/about', requireAuth, async (req, res) => {
    try {
        const chat = await wa.getChatById(req.params.id);
        const avatar = await getAvatarUrl(req.params.id);

        let number = null;
        let participants = [];

        if (chat.isGroup) {
            const raw = chat.participants || chat.groupMetadata?.participants || [];
            participants = await Promise.all(
                raw.map(async p => {
                    const id = serializedId(p.id) || p.id?.user || 'unknown';
                    const name = await getContactName(id);
                    const role = p.isSuperAdmin ? 'owner' : (p.isAdmin ? 'admin' : '');
                    return { name, role, number: id.split('@')[0] };
                })
            );
        } else {
            try {
                const contact = await wa.getContactById(req.params.id);
                number = (await contact.getFormattedNumber()) || contact?.number || chat.id?.user || null;
            } catch (e) {
                number = chat.id?.user || null;
            }
        }

        res.render('about', {
            chatId: req.params.id,
            title: chatTitle(chat),
            avatar,
            number,
            isGroup: chat.isGroup,
            participants
        });
    } catch (e) {
        console.error('about error:', e);
        res.status(500).send('Error loading info: ' + (e?.message || e));
    }
});

app.get('/chat/:id/who', requireAuth, async (req, res) => {
    try {
        const chat = await wa.getChatById(req.params.id);
        if (!chat.isGroup) return res.send('<p>Not a group.</p>');

        const participants = chat.participants || chat.groupMetadata?.participants || [];
        console.log('[who debug] isGroup=%s participantCount=%d', chat.isGroup, participants.length);
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
        const quality = ['480', '360', 'thumb'].includes(req.query.quality) ? req.query.quality : null;
        const { data: dataPath, meta: metaPath } = mediaCachePaths(req.params.msgId, quality);

        if (fs.existsSync(dataPath) && fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            res.set('Content-Type', meta.mimetype);
            res.set('Cache-Control', 'private, max-age=31536000, immutable');
            return res.sendFile(dataPath);
        }

        const chat = await wa.getChatById(req.params.chatId);
        let messages;
        try {
            messages = await chat.fetchMessages({ limit: 50 });
        } catch (e) {
            if (e?.name === 'ProtocolError') {
                messages = await chat.fetchMessages({ limit: 50 }); // retry once: puppeteer context can get collected under concurrent evaluate calls
            } else {
                throw e;
            }
        }
        const msg = messages.find(m => (m.id?._serialized || m.id?.$1) === req.params.msgId);

        if (!msg || !msg.hasMedia) return res.status(404).send('Not found');

        console.log('[media debug] msgId=%s type=%s timestamp=%s ageSec=%s', req.params.msgId, msg.type, msg.timestamp, Math.floor(Date.now() / 1000) - msg.timestamp);

        // whatsapp-web.js's built-in downloadMedia() looks the message up inside
        // the page's live Msg collection, but messages returned by fetchMessages()
        // are never inserted into that collection, so the lookup always fails here
        // (confirmed via debug logging). We already have everything downloadMedia()
        // needs on the raw message data, so decrypt directly instead of relying on
        // that lookup.
        // whatsapp-web.js's built-in downloadMedia() looks the message up inside
        // the page's live Msg collection. That lookup was broken for LID-style ids
        // (WhatsApp's 2026-07 web update renamed id._serialized -> id.$1, which the
        // patch's lookup didn't try) - now patched in patch-wwebjs.js, so try the
        // real path first since it handles video's streaming sidecar correctly.
        // Fall back to a manual raw-field decrypt (which works for images/audio/docs
        // but not video) if the real path still comes back empty.
        const raw = msg.rawData || msg._data || {};
        let media = null;
        try {
            media = await msg.downloadMedia();
            console.log('[media debug] built-in downloadMedia result:', media ? ('ok dataLen=' + (media.data ? media.data.length : 0)) : 'null/undefined');
        } catch (builtInErr) {
            console.log('[media debug] built-in downloadMedia threw:', builtInErr && builtInErr.stack || builtInErr);
        }
        if (!media || !media.data) {
            try {
                const result = await wa.pupPage.evaluate(async (fields) => {
                    try {
                        const mockQpl = {
                            addAnnotations: function () { return this; },
                            addPoint: function () { return this; }
                        };
                        let mediaType = fields.type;
                        try {
                            mediaType = window.require('WAWebMmsMediaTypes').msgToMediaType({ type: fields.type, isGif: false });
                        } catch (mapErr) { /* fall back to raw string type */ }
                        const decryptedMedia = await window.require('WAWebDownloadManager')
                            .downloadManager.downloadAndMaybeDecrypt({
                                directPath: fields.directPath,
                                encFilehash: fields.encFilehash,
                                filehash: fields.filehash,
                                mediaKey: fields.mediaKey,
                                mediaKeyTimestamp: fields.mediaKeyTimestamp,
                                type: mediaType,
                                signal: new AbortController().signal,
                                downloadQpl: mockQpl
                            });
                        const data = await window.WWebJS.arrayBufferToBase64Async(decryptedMedia);
                        return { data, mimetype: fields.mimetype, filesize: fields.filesize };
                    } catch (e) {
                        return { error: (e && e.message) || String(e) };
                    }
                }, {
                    directPath: raw.directPath,
                    encFilehash: raw.encFilehash,
                    filehash: raw.filehash,
                    mediaKey: raw.mediaKey,
                    mediaKeyTimestamp: raw.mediaKeyTimestamp,
                    type: raw.type,
                    mimetype: raw.mimetype,
                    filesize: raw.size
                });
                console.log('[media debug] direct decrypt result:', result && result.error ? ('error: ' + result.error) : ('ok dataLen=' + (result?.data?.length || 0)), 'rawType=', raw.type, 'rawMimetype=', raw.mimetype);
                if (result && !result.error && result.data) {
                    media = result;
                }
            } catch (mediaErr) {
                console.log('[media debug] direct decrypt threw:', mediaErr && mediaErr.stack || mediaErr);
            }
        }
        if (!media || !media.data) {
            return res.status(410).send(`Media not available yet (type: ${raw.type || 'unknown'}, mimetype: ${raw.mimetype || 'unknown'}). Open WhatsApp on your phone and view this media there once, then try again here.`);
        }
        media = await maybeTranscodeToMp3(media, raw.type);
        if (quality === 'thumb' && (raw.type === 'image' || (media.mimetype || '').startsWith('image'))) {
            const originalBuffer = Buffer.from(media.data, 'base64');
            const thumbBuffer = await transcodeImageThumb(originalBuffer);
            if (thumbBuffer) {
                media = { data: thumbBuffer.toString('base64'), mimetype: 'image/jpeg' };
            } // else: ffmpeg missing/failed, fall through and serve original quality
        } else if (quality && (raw.type === 'video' || (media.mimetype || '').startsWith('video'))) {
            const originalBuffer = Buffer.from(media.data, 'base64');
            const scaledBuffer = await transcodeVideo(originalBuffer, quality);
            if (scaledBuffer) {
                media = { data: scaledBuffer.toString('base64'), mimetype: 'video/mp4' };
            } // else: ffmpeg missing/failed, fall through and serve original quality
        }
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

// Ctrl+C (or a process manager stopping us) leaves the Puppeteer/Chrome
// process running otherwise, which then locks wa-session/session and blocks
// the next start with "browser is already running".
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, closing WhatsApp session...`);
    try {
        await wa.destroy();
        console.log('Closed cleanly.');
    } catch (e) {
        console.log('Error while closing:', e && e.message || e);
    }
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
