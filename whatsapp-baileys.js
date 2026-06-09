require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const mongoose = require('mongoose');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

// ── Conexión MongoDB ─────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Conectado a MongoDB Atlas'))
  .catch(err => console.error('❌ Error MongoDB:', err.message));

// ── Modelo Incidente ─────────────────────────────────────────
const Incidente = mongoose.model('Incidente', new mongoose.Schema({
  titulo:        String,
  tipo:          String,
  area:          String,
  descripcion:   String,
  severidad:     String,
  usuarioNombre: String,
  usuarioWa:     String,
  fecha:         { type: Date, default: Date.now }
}));

const sesiones = {};

async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Bot SST', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 Escanea este QR con tu WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reconnect = code !== DisconnectReason.loggedOut;
      console.log('❌ Desconectado. Reconectando:', reconnect);
      if (reconnect) iniciarBot();
    }
    if (connection === 'open') {
      console.log('✅ Bot SST conectado a WhatsApp!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe) return;

    const texto  = (
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ''
    ).trim().toLowerCase();

    const from   = msg.key.remoteJid;
    const waId   = msg.key.participant || from;
    const nombre = msg.pushName || 'Trabajador';

    if (!texto) return;

    console.log(`📩 "${texto}" de ${nombre}`);

    const reply = async (text) => {
      await sock.sendMessage(from, { text }, { quoted: msg });
    };

    // ── Comandos ────────────────────────────────────────────
    if (texto === '!ayuda' || texto === '!help') {
      await reply(
        `🦺 *Sistema SST — I.D.E. Refinería*\n\n` +
        `📋 *Comandos:*\n\n` +
        `*!reporte* — Registrar incidente\n` +
        `*!misreportes* — Ver mis reportes\n` +
        `*!stats* — Estadísticas\n` +
        `*!ayuda* — Esta lista\n\n` +
        `🌐 https://proyecto-sst-i8zu.onrender.com`
      );
      return;
    }

    if (texto === '!stats') {
      try {
        const total    = await Incidente.countDocuments();
        const criticos = await Incidente.countDocuments({ severidad: 'critica' });
        const altos    = await Incidente.countDocuments({ severidad: 'alta' });
        const medios   = await Incidente.countDocuments({ severidad: 'media' });
        const bajos    = await Incidente.countDocuments({ severidad: 'baja' });
        await reply(
          `📊 *Estadísticas SST*\n\n` +
          `Total: *${total}*\n` +
          `🔴 Críticos: *${criticos}*\n` +
          `🟠 Altos: *${altos}*\n` +
          `🟡 Medios: *${medios}*\n` +
          `🟢 Bajos: *${bajos}*\n\n` +
          `🌐 https://proyecto-sst-i8zu.onrender.com`
        );
      } catch { await reply('❌ Error al obtener estadísticas.'); }
      return;
    }

    if (texto === '!misreportes') {
      try {
        const reportes = await Incidente.find({ usuarioWa: waId }).sort({ fecha: -1 }).limit(5);
        if (!reportes.length) {
          await reply(`📋 No tienes reportes aún.\n\nUsa *!reporte* para crear uno.`);
          return;
        }
        const meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
        let r = `📋 *Tus últimos reportes:*\n\n`;
        reportes.forEach((rep, i) => {
          const f = new Date(rep.fecha);
          r += `*${i+1}. ${rep.titulo}*\n`;
          r += `   ${rep.tipo} | ${rep.severidad}\n`;
          r += `   ${rep.area}\n`;
          r += `   ${f.getDate()} ${meses[f.getMonth()]} ${f.getFullYear()}\n\n`;
        });
        await reply(r);
      } catch { await reply('❌ Error al obtener reportes.'); }
      return;
    }

    if (texto === '!reporte') {
      sesiones[waId] = { paso: 1, data: { usuarioNombre: nombre, usuarioWa: waId } };
      await reply(
        `⚠️ *Nuevo Reporte SST*\n\n` +
        `*Paso 1/5* — Título del incidente:\n\n` +
        `_Ej: Derrame de aceite en caldera 2_`
      );
      return;
    }

    if (sesiones[waId]) {
      const s = sesiones[waId];
      const raw = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

      if (s.paso === 1) {
        s.data.titulo = raw;
        s.paso = 2;
        await reply(`*Paso 2/5* — Tipo de incidente:\n\n1️⃣ Accidente\n2️⃣ Casi accidente\n3️⃣ Condición insegura\n4️⃣ Otro\n\n_Responde con el número_`);
        return;
      }
      if (s.paso === 2) {
        const tipos = { '1': 'accidente', '2': 'casi-accidente', '3': 'condicion-insegura', '4': 'otro' };
        s.data.tipo = tipos[texto] || 'otro';
        s.paso = 3;
        await reply(`*Paso 3/5* — Severidad:\n\n1️⃣ Baja\n2️⃣ Media\n3️⃣ Alta\n4️⃣ Crítica\n\n_Responde con el número_`);
        return;
      }
      if (s.paso === 3) {
        const sevs = { '1': 'baja', '2': 'media', '3': 'alta', '4': 'critica' };
        s.data.severidad = sevs[texto] || 'media';
        s.paso = 4;
        await reply(`*Paso 4/5* — Área donde ocurrió:\n\n_Ej: Planta de esterilización_`);
        return;
      }
      if (s.paso === 4) {
        s.data.area = raw;
        s.paso = 5;
        await reply(`*Paso 5/5* — Descripción de lo ocurrido:`);
        return;
      }
      if (s.paso === 5) {
        s.data.descripcion = raw;
        try {
          await Incidente.create(s.data);
          delete sesiones[waId];
          await reply(
            `✅ *Incidente registrado*\n\n` +
            `📌 *${s.data.titulo}*\n` +
            `Tipo: ${s.data.tipo}\n` +
            `Severidad: ${s.data.severidad}\n` +
            `Área: ${s.data.area}\n\n` +
            `🌐 https://proyecto-sst-i8zu.onrender.com`
          );
        } catch {
          await reply('❌ Error. Intenta con *!reporte*');
          delete sesiones[waId];
        }
        return;
      }
    }

    if (texto.startsWith('!')) {
      await reply(`❓ Comando no reconocido.\n\nEscribe *!ayuda* para ver los comandos.`);
    }
  });
}

iniciarBot();
