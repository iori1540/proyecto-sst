require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const mongoose = require('mongoose');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Conectado a MongoDB Atlas'))
  .catch(err => console.error('❌ Error MongoDB:', err.message));

const Incidente = mongoose.model('Incidente', new mongoose.Schema({
  titulo: String, tipo: String, area: String, descripcion: String,
  severidad: String, usuarioNombre: String, usuarioWa: String,
  fecha: { type: Date, default: Date.now }
}));

const sesiones = {};

async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_bot_nuevo');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['SST Bot', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 Escanea este QR con WhatsApp del numero 51938862381:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('Codigo desconexion:', code);
      if (code !== DisconnectReason.loggedOut && code !== 401) {
        setTimeout(iniciarBot, 3000);
      }
    }
    if (connection === 'open') {
      console.log('✅ Bot SST conectado!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe) return;

    const texto = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim().toLowerCase();
    const from  = msg.key.remoteJid;
    const waId  = msg.key.participant || from;
    const nombre = msg.pushName || 'Trabajador';

    if (!texto) return;

    const reply = async (text) => {
      await sock.sendMessage(from, { text }, { quoted: msg });
    };

    if (texto === '!ayuda' || texto === '!help') {
      await reply(`🦺 *Sistema SST — I.D.E. Refinería*\n\n📋 *Comandos:*\n\n*!reporte* — Registrar incidente\n*!misreportes* — Ver mis reportes\n*!stats* — Estadísticas\n*!ayuda* — Esta lista\n\n🌐 https://proyecto-sst-i8zu.onrender.com`);
      return;
    }

    if (texto === '!stats') {
      try {
        const total    = await Incidente.countDocuments();
        const criticos = await Incidente.countDocuments({ severidad: 'critica' });
        const altos    = await Incidente.countDocuments({ severidad: 'alta' });
        await reply(`📊 *Estadísticas SST*\n\nTotal: *${total}*\n🔴 Críticos: *${criticos}*\n🟠 Altos: *${altos}*\n\n🌐 https://proyecto-sst-i8zu.onrender.com`);
      } catch { await reply('❌ Error.'); }
      return;
    }

    if (texto === '!misreportes') {
      try {
        const reportes = await Incidente.find({ usuarioWa: waId }).sort({ fecha: -1 }).limit(5);
        if (!reportes.length) { await reply('📋 No tienes reportes.\n\nUsa *!reporte*'); return; }
        const M = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
        let r = '📋 *Tus reportes:*\n\n';
        reportes.forEach((rep, i) => {
          const f = new Date(rep.fecha);
          r += `*${i+1}. ${rep.titulo}*\n${rep.tipo} | ${rep.severidad}\n${rep.area}\n${f.getDate()} ${M[f.getMonth()]} ${f.getFullYear()}\n\n`;
        });
        await reply(r);
      } catch { await reply('❌ Error.'); }
      return;
    }

    if (texto === '!reporte') {
      sesiones[waId] = { paso: 1, data: { usuarioNombre: nombre, usuarioWa: waId } };
      await reply('⚠️ *Nuevo Reporte SST*\n\n*Paso 1/5* — Título del incidente:');
      return;
    }

    if (sesiones[waId]) {
      const s = sesiones[waId];
      const raw = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      if (s.paso === 1) { s.data.titulo = raw; s.paso = 2; await reply('*Paso 2/5* — Tipo:\n\n1️⃣ Accidente\n2️⃣ Casi accidente\n3️⃣ Condición insegura\n4️⃣ Otro'); return; }
      if (s.paso === 2) { s.data.tipo = {'1':'accidente','2':'casi-accidente','3':'condicion-insegura','4':'otro'}[texto]||'otro'; s.paso = 3; await reply('*Paso 3/5* — Severidad:\n\n1️⃣ Baja\n2️⃣ Media\n3️⃣ Alta\n4️⃣ Crítica'); return; }
      if (s.paso === 3) { s.data.severidad = {'1':'baja','2':'media','3':'alta','4':'critica'}[texto]||'media'; s.paso = 4; await reply('*Paso 4/5* — Área:'); return; }
      if (s.paso === 4) { s.data.area = raw; s.paso = 5; await reply('*Paso 5/5* — Descripción:'); return; }
      if (s.paso === 5) {
        s.data.descripcion = raw;
        try {
          await Incidente.create(s.data);
          delete sesiones[waId];
          await reply(`✅ *Incidente registrado*\n\n📌 *${s.data.titulo}*\nTipo: ${s.data.tipo}\nSeveridad: ${s.data.severidad}\nÁrea: ${s.data.area}\n\n🌐 https://proyecto-sst-i8zu.onrender.com`);
        } catch { await reply('❌ Error. Intenta con *!reporte*'); delete sesiones[waId]; }
        return;
      }
    }

    if (texto.startsWith('!')) await reply('❓ Comando no reconocido.\n\nEscribe *!ayuda*');
  });
}

iniciarBot();
