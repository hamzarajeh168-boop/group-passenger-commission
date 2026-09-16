const http = require('http');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, useMultiFileAuthState, initAuthCreds, initQueryCache } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { Pool } = require('pg');
const fs = require('fs');

// السيرفر والبوت بنفس الحاوية على Railway → الوبوك محلي
const WEBHOOK_URL = process.env.SHAHM_WEBHOOK_URL || `http://127.0.0.1:${Number(process.env.PORT || 4000)}/webhook/group`;
const CONTROL_PORT = Number(process.env.BAILEYS_CONTROL_PORT || 4101);
const CONTROL_KEY = process.env.BAILEYS_CONTROL_KEY || 'shahm-local';

// ============ جلسة واتساب محفوظة في Postgres (لا تضيع أبدًا) ============
const authPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false });

async function useDbAuthState() {
  await authPool.query(`CREATE TABLE IF NOT EXISTS baileys_auth (key TEXT PRIMARY KEY, value JSONB NOT NULL)`);
  const readAll = async () => {
    const r = await authPool.query(`SELECT key, value FROM baileys_auth`);
    const out = {};
    r.rows.forEach(row => { out[row.key] = row.value; });
    return out;
  };
  const write = async (key, value) => {
    if (value === null || value === undefined) {
      await authPool.query(`DELETE FROM baileys_auth WHERE key = $1`, [key]);
      return;
    }
    await authPool.query(`INSERT INTO baileys_auth (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [key, JSON.parse(JSON.stringify(value))]);
  };
  let stored = await readAll();
  // إذا الجلسة المخزنة فاسدة (بدون noiseKey) نمسحها لتبدأ نظيفة وتظهر QR
  if (!stored.creds || !stored.creds.noiseKey) {
    console.log('الجلسة المخزنة غير صالحة — يتم إعادة التعيين...');
    await authPool.query(`DELETE FROM baileys_auth`);
    stored = {};
  }
  // جلسة جديدة ← نستخدم المولّد الرسمي حتى تكون كل المفاتيح موجودة
  const state = { creds: stored.creds || initAuthCreds(), keys: stored.keys && typeof stored.keys === 'object' ? stored.keys : {} };
  const saveState = async () => {
    try {
      await write('creds', state.creds);
      await write('keys', state.keys);
    } catch (err) { console.error('تعذر حفظ جلسة الواتساب في قاعدة البيانات:', err.message); }
  };
  return { state, saveCreds: saveState };
}

let socket;

function phoneFromJid(jid) {
  return String(jid || '').split('@')[0].replace(/\D/g, '');
}

function messageText(message) {
  return message?.conversation
    || message?.extendedTextMessage?.text
    || message?.imageMessage?.caption
    || message?.videoMessage?.caption
    || '';
}

function quotedId(message) {
  return message?.extendedTextMessage?.contextInfo?.stanzaId
    || message?.imageMessage?.contextInfo?.stanzaId
    || message?.videoMessage?.contextInfo?.stanzaId
    || '';
}

async function forward(event) {
  const body = JSON.stringify(event);
  await new Promise((resolve, reject) => {
    const request = http.request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, response => {
      response.resume();
      response.on('end', resolve);
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function removeParticipant(groupId, phone) {
  if (!socket) throw new Error('Baileys غير متصل');
  const participant = `${phoneFromJid(phone)}@s.whatsapp.net`;
  await socket.groupParticipantsUpdate(groupId, [participant], 'remove');
  return { attempted: true, performed: true };
}

// تحويل رابط دعوة الجروب (https://chat.whatsapp.com/XXXX) إلى معرف جروب حقيقي
async function resolveGroupFromLink(link) {
  if (!socket) throw new Error('Baileys غير متصل');
  const match = String(link || '').match(/chat\.whatsapp\.com\/(?:join\?invite=)?([A-Za-z0-9_-]+)/);
  if (!match) throw new Error('رابط الجروب غير صالح');
  const info = await socket.groupGetInviteInfo(match[1]);
  if (!info || !info.id) throw new Error('تعذر قراءة معرف الجروب من الرابط');
  return { groupId: info.id, subject: info.subject || '' };
}

// فحص أن معرف الجروب ما زال صالحًا/موجودًا
async function checkGroup(groupId) {
  if (!socket) throw new Error('Baileys غير متصل');
  const meta = await socket.groupMetadata(groupId);
  return { groupId: meta.id, subject: meta.subject || '', participants: (meta.participants || []).length };
}

function startControlServer() {
  http.createServer((request, response) => {
    const url = request.url.split('?')[0];
    if (request.method !== 'POST' || !['/remove-participant', '/resolve-group', '/check-group'].includes(url) || request.headers['x-baileys-key'] !== CONTROL_KEY) {
      response.writeHead(404);
      response.end();
      return;
    }
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
        if (url === '/resolve-group') {
          const result = await resolveGroupFromLink(body.link);
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ ok: true, ...result }));
          return;
        }
        if (url === '/check-group') {
          const result = await checkGroup(body.groupId);
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ ok: true, ...result }));
          return;
        }
        await removeParticipant(body.groupId, body.phone);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
      } catch (error) {
        response.writeHead(502, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: error.message }));
      }
    });
  }).listen(CONTROL_PORT, '127.0.0.1');
}

let onQRCallback = null;
let onConnectedCallback = null;

async function startBot() {
  console.log('تشغيل بوت Baileys...');
  // نستخدم قاعدة البيانات أولاً (دائمة)، وإذا ما في DATABASE_URL نرجع للملفات المحلية
  const { state, saveCreds } = process.env.DATABASE_URL
    ? await useDbAuthState()
    : await useMultiFileAuthState(process.env.BAILEYS_AUTH_DIR || 'auth_info');
  console.log('جلسة الواتساب جاهزة' + (process.env.DATABASE_URL ? ' (محفوظة في قاعدة البيانات)' : ' (ملفات محلية)'));
  socket = makeWASocket({
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false,
    browser: ['Shahm Bot', 'Chrome', '1.0.0'],
    syncFullHistory: false
  });
  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('connection.update', update => {
    const { connection, lastDisconnect, qr } = update;
    console.log('حدث الاتصال:', connection, lastDisconnect?.error?.message || (qr ? 'QR جديد' : ''));
    if (qr) {
      console.log('امسح رمز QR التالي لربط WhatsApp مع شهم:');
      qrcode.generate(qr, { small: true });
      if (typeof onQRCallback === 'function') onQRCallback(qr);
    }
    if (connection === 'open') {
      console.log('Baileys متصل بـ WhatsApp');
      if (typeof onConnectedCallback === 'function') onConnectedCallback();
    }
    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log('انفصل Baileys، رمز الحالة:', statusCode, lastDisconnect?.error?.message || '');
      if (statusCode !== DisconnectReason.loggedOut) {
        socket = undefined;
        setTimeout(() => startBot().catch(error => console.error('تعذر إعادة اتصال Baileys:', error.message)), 3000);
      } else {
        console.error('تم تسجيل خروج Baileys؛ نمسح الجلسة القديمة من قاعدة البيانات لإظهار QR جديد...');
        (async () => {
          try { await authPool.query(`DELETE FROM baileys_auth`); } catch { }
          try { fs.rmSync(process.env.BAILEYS_AUTH_DIR || 'auth_info', { recursive: true, force: true }); } catch { }
          socket = undefined;
          setTimeout(() => startBot().catch(error => console.error('تعذر إعادة تشغيل Baileys:', error.message)), 3000);
        })();
      }
    }
  });
  socket.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      const groupId = msg.key.remoteJid;
      if (!groupId?.endsWith('@g.us') || !msg.message) continue;
      const sender = msg.key.participant || msg.key.remoteJid;
      const reaction = msg.message.reactionMessage;
      try {
        if (reaction) {
          await forward({
            type: 'like',
            id: msg.key.id,
            groupId,
            from: phoneFromJid(sender),
            replyId: reaction.key?.id || '',
            emoji: reaction.text || ''
          });
          continue;
        }
        const text = messageText(msg.message);
        if (!text) continue;
        await forward({
          type: 'message',
          id: msg.key.id,
          groupId,
          from: phoneFromJid(sender),
          text,
          replyTo: quotedId(msg.message)
        });
      } catch (error) {
        console.error('تعذر تمرير حدث WhatsApp إلى شهم:', error.message);
      }
    }
  });
}

startControlServer();
startBot().catch(error => {
  console.error('تعذر تشغيل Baileys:', error);
});

module.exports = { removeParticipant, set onQR(fn) { onQRCallback = fn; }, set onConnected(fn) { onConnectedCallback = fn; } };
