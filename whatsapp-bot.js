require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode-terminal');
const mongoose = require('mongoose');

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

// ── Cliente WhatsApp ─────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', (qr) => {
  console.log('\n📱 Escanea este QR con tu WhatsApp:\n');
  QRCode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ Bot SST conectado a WhatsApp!');
});

client.on('disconnected', () => {
  console.log('❌ Bot desconectado. Reiniciando...');
  client.initialize();
});

// ── Estado de conversación ───────────────────────────────────
const sesiones = {};

// ── Mensajes ──────────────────────────────────────────────────
client.on('message', async msg => {
  if (msg.fromMe) return;

  const texto  = msg.body.trim().toLowerCase();
  const nombre = msg._data.notifyName || 'Trabajador';
  const waId   = msg.from;

  console.log(`Mensaje: "${texto}" De: ${nombre}`);

  if (texto === '!ayuda' || texto === '!help') {
    await msg.reply(
      `🦺 *Sistema SST — I.D.E. Refinería*\n\n` +
      `📋 *Comandos disponibles:*\n\n` +
      `*!reporte* — Registrar nuevo incidente\n` +
      `*!misreportes* — Ver mis últimos reportes\n` +
      `*!stats* — Ver estadísticas generales\n` +
      `*!ayuda* — Ver esta lista\n\n` +
      `🌐 *Panel web:*\nhttps://proyecto-sst-i8zu.onrender.com`
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
      await msg.reply(
        `📊 *Estadísticas SST*\n\n` +
        `Total incidentes: *${total}*\n` +
        `🔴 Críticos: *${criticos}*\n` +
        `🟠 Alta severidad: *${altos}*\n` +
        `🟡 Media severidad: *${medios}*\n` +
        `🟢 Baja severidad: *${bajos}*\n\n` +
        `Ver más en:\nhttps://proyecto-sst-i8zu.onrender.com`
      );
    } catch {
      await msg.reply('❌ Error al obtener estadísticas.');
    }
    return;
  }

  if (texto === '!misreportes') {
    try {
      const reportes = await Incidente.find({ usuarioWa: waId }).sort({ fecha: -1 }).limit(5);
      if (!reportes.length) {
        await msg.reply(`📋 No tienes reportes aún.\n\nUsa *!reporte* para registrar uno.`);
        return;
      }
      const meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
      let r = `📋 *Tus últimos reportes:*\n\n`;
      reportes.forEach((rep, i) => {
        const f = new Date(rep.fecha);
        r += `*${i+1}. ${rep.titulo}*\n`;
        r += `   Tipo: ${rep.tipo} | Severidad: ${rep.severidad}\n`;
        r += `   Área: ${rep.area}\n`;
        r += `   Fecha: ${f.getDate()} ${meses[f.getMonth()]} ${f.getFullYear()}\n\n`;
      });
      await msg.reply(r);
    } catch {
      await msg.reply('❌ Error al obtener reportes.');
    }
    return;
  }

  if (texto === '!reporte') {
    sesiones[waId] = { paso: 1, data: { usuarioNombre: nombre, usuarioWa: waId } };
    await msg.reply(
      `⚠️ *Nuevo Reporte de Incidente*\n\n` +
      `*Paso 1/5* — ¿Cuál es el título del incidente?\n\n` +
      `_Ejemplo: Derrame de aceite en caldera 2_`
    );
    return;
  }

  if (sesiones[waId]) {
    const sesion = sesiones[waId];

    if (sesion.paso === 1) {
      sesion.data.titulo = msg.body.trim();
      sesion.paso = 2;
      await msg.reply(
        `*Paso 2/5* — ¿Qué tipo de incidente es?\n\n` +
        `1️⃣ Accidente\n2️⃣ Casi accidente\n3️⃣ Condición insegura\n4️⃣ Otro\n\n` +
        `_Responde con el número_`
      );
      return;
    }

    if (sesion.paso === 2) {
      const tipos = { '1': 'accidente', '2': 'casi-accidente', '3': 'condicion-insegura', '4': 'otro' };
      sesion.data.tipo = tipos[texto] || 'otro';
      sesion.paso = 3;
      await msg.reply(
        `*Paso 3/5* — ¿Cuál es la severidad?\n\n` +
        `1️⃣ Baja\n2️⃣ Media\n3️⃣ Alta\n4️⃣ Crítica\n\n` +
        `_Responde con el número_`
      );
      return;
    }

    if (sesion.paso === 3) {
      const sevs = { '1': 'baja', '2': 'media', '3': 'alta', '4': 'critica' };
      sesion.data.severidad = sevs[texto] || 'media';
      sesion.paso = 4;
      await msg.reply(`*Paso 4/5* — ¿En qué área ocurrió?\n\n_Ejemplo: Planta de esterilización_`);
      return;
    }

    if (sesion.paso === 4) {
      sesion.data.area = msg.body.trim();
      sesion.paso = 5;
      await msg.reply(`*Paso 5/5* — Describe brevemente qué ocurrió:`);
      return;
    }

    if (sesion.paso === 5) {
      sesion.data.descripcion = msg.body.trim();
      try {
        await Incidente.create(sesion.data);
        delete sesiones[waId];
        await msg.reply(
          `✅ *Incidente registrado correctamente*\n\n` +
          `📌 *${sesion.data.titulo}*\n` +
          `Tipo: ${sesion.data.tipo}\n` +
          `Severidad: ${sesion.data.severidad}\n` +
          `Área: ${sesion.data.area}\n\n` +
          `Ver reportes en:\nhttps://proyecto-sst-i8zu.onrender.com`
        );
      } catch {
        await msg.reply('❌ Error al guardar. Intenta con *!reporte*');
        delete sesiones[waId];
      }
      return;
    }
  }

  if (texto.startsWith('!')) {
    await msg.reply(`❓ Comando no reconocido.\n\nEscribe *!ayuda* para ver los comandos.`);
  }
});

client.initialize();
