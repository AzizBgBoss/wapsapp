#!/usr/bin/env node
'use strict';

// Re-applies our workaround for the whatsapp-web.js "r: r" / opaque
// downloadMedia() crash (see wwebjs/whatsapp-web.js issues #201828,
// #201833, #201844) after every `npm install`, since it patches files
// inside node_modules directly.
//
// Safe to run multiple times: each patch checks whether it has already
// been applied before touching the file.

const fs = require('fs');
const path = require('path');

const utilsPath = path.join(
    __dirname,
    '..',
    'node_modules',
    'whatsapp-web.js',
    'src',
    'util',
    'Injected',
    'Utils.js'
);

const messagePath = path.join(
    __dirname,
    '..',
    'node_modules',
    'whatsapp-web.js',
    'src',
    'structures',
    'Message.js'
);

function patchUtils() {
    if (!fs.existsSync(utilsPath)) {
        console.warn('[patch-wwebjs] Utils.js not found, skipping. Did npm install run?');
        return;
    }

    let content = fs.readFileSync(utilsPath, 'utf8');

    if (content.includes('window.WWebJS.getMessageById')) {
        console.log('[patch-wwebjs] Utils.js already patched.');
        return;
    }

    const anchor = `    window.WWebJS.injectToFunction(
        { module: 'WAWebE2EProtoUtils', function: 'typeAttributeFromProtobuf' },
        (module, func, ...args) => {
            const [proto] = args;
            return proto.locationMessage || proto.groupInviteMessage
                ? 'text'
                : func(...args);
        },
    );`;

    if (!content.includes(anchor)) {
        console.warn('[patch-wwebjs] Could not find anchor in Utils.js — whatsapp-web.js may have changed. Skipping this patch.');
        return;
    }

    const helper = `

    // Robust message lookup used by downloadMedia() and friends.
    // Passing only `+ '`id._serialized`' + ` to Msg.get()/getMessagesById() has become
    // unreliable on some WWeb versions (throws or returns nothing), so this
    // tries several candidate shapes before giving up.
    window.WWebJS.getMessageById = async (msgId) => {
        const Msg = window.require('WAWebCollections').Msg;
        const { createWid } = window.require('WAWebWidFactory');

        const candidates = [];
        const addCandidate = (c) => {
            if (c !== undefined && c !== null) candidates.push(c);
        };

        addCandidate(msgId);
        if (msgId && msgId._serialized) addCandidate(msgId._serialized);
        if (typeof msgId === 'string') addCandidate(msgId);
        if (msgId && msgId.id) addCandidate(msgId.id);

        if (msgId && typeof msgId === 'object') {
            try {
                const rebuilt = {
                    ...msgId,
                    remote:
                        typeof msgId.remote === 'string'
                            ? createWid(msgId.remote)
                            : msgId.remote,
                    participant:
                        typeof msgId.participant === 'string'
                            ? createWid(msgId.participant)
                            : msgId.participant,
                };
                addCandidate(rebuilt);
            } catch (ignoredError) {
                /* malformed id, skip this candidate */
            }
        }

        for (const candidate of candidates) {
            try {
                const found = Msg.get(candidate);
                if (found) return found;
            } catch (ignoredError) {
                /* try next candidate */
            }
        }

        for (const candidate of candidates) {
            try {
                const result = await Msg.getMessagesById([candidate]);
                if (result?.messages?.[0]) return result.messages[0];
            } catch (ignoredError) {
                /* try next candidate */
            }
        }

        // last resort: scan in-memory models for a matching serialized id
        try {
            const wanted =
                (msgId && msgId._serialized) ||
                (typeof msgId === 'string' ? msgId : undefined);
            if (wanted) {
                const models =
                    (Msg.getModelsArray && Msg.getModelsArray()) ||
                    Msg.models ||
                    Msg._models ||
                    [];
                const match = models.find((m) => m.id?._serialized === wanted);
                if (match) return match;
            }
        } catch (ignoredError) {
            /* give up */
        }

        return null;
    };`;

    content = content.replace(anchor, anchor + helper);
    fs.writeFileSync(utilsPath, content, 'utf8');
    console.log('[patch-wwebjs] Patched Utils.js (added window.WWebJS.getMessageById).');
}

function patchMessage() {
    if (!fs.existsSync(messagePath)) {
        console.warn('[patch-wwebjs] Message.js not found, skipping. Did npm install run?');
        return;
    }

    let content = fs.readFileSync(messagePath, 'utf8');

    if (content.includes('window.WWebJS.getMessageById(msgId)')) {
        console.log('[patch-wwebjs] Message.js already patched.');
        return;
    }

    const oldLookup = `            const msg =
                window.require('WAWebCollections').Msg.get(msgId) ||
                (
                    await window
                        .require('WAWebCollections')
                        .Msg.getMessagesById([msgId])
                )?.messages?.[0];

            // REUPLOADING mediaStage means the media is expired and the download button is spinning, cannot be downloaded now`;

    const newLookup = `            const msg = await window.WWebJS.getMessageById(msgId);

            // REUPLOADING mediaStage means the media is expired and the download button is spinning, cannot be downloaded now`;

    if (!content.includes(oldLookup)) {
        console.warn('[patch-wwebjs] Could not find downloadMedia lookup in Message.js — whatsapp-web.js may have changed. Skipping this patch.');
        return;
    }

    content = content.replace(oldLookup, newLookup);
    content = content.replace('}, this.id._serialized);\n\n        if (!result) return undefined;', '}, this.id);\n\n        if (!result) return undefined;');

    fs.writeFileSync(messagePath, content, 'utf8');
    console.log('[patch-wwebjs] Patched Message.js (downloadMedia uses getMessageById with full id).');
}

patchUtils();
patchMessage();
