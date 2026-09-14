const http = require('http');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const WEBHOOK_URL = process.env.SHAHM_WEBHOOK_URL || 'http://127.0.0.1:4000/webhook/group';
const CONTROL_PORT = Number(process.env.BAILEYS_CONTROL_PORT || 4101);
const CONTROL_KEY = process.env.BAILEYS_CONTROL_KEY || 'shahm-local';
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

function startControlServer() {
  http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/remove-participant' || request.headers['x-baileys-key'] !== CONTROL_KEY) {
      response.writeHead(404);
      response.end();
      return;
    }
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
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

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(process.env.BAILEYS_AUTH_DIR || 'auth_info');
  socket = makeWASocket({
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false
  });
  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('connection.update', update => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('امسح رمز QR التالي لربط WhatsApp مع شهم:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') console.log('Baileys متصل بـ WhatsApp');
    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) {
        socket = undefined;
        setTimeout(() => startBot().catch(error => console.error('تعذر إعادة اتصال Baileys:', error.message)), 3000);
      } else {
        console.error('تم تسجيل خروج Baileys؛ احذف مجلد auth_info وأعد التشغيل لعرض QR جديد.');
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
  process.exitCode = 1;
});

module.exports = { removeParticipant };
