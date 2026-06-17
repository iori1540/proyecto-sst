require('dotenv').config();
const express    = require('express');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const path       = require('path');
const multer     = require('multer');
const cloudinary = require('cloudinary').v2;
const fs         = require('fs');

// ── WhatsApp Baileys ─────────────────────────────────────────
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage, Browsers, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const pino   = require('pino');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Cloudinary ───────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── MongoDB ──────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ Conectado a MongoDB Atlas');
    iniciarBot();
  })
  .catch(err => console.error('❌ Error MongoDB:', err.message));

// ── Modelos ──────────────────────────────────────────────────
const usuarioSchema = new mongoose.Schema({
  nombre:     { type: String, required: true },
  correo:     { type: String, required: true, unique: true, lowercase: true },
  contrasena: { type: String, required: true },
  rol:        { type: String, default: 'trabajador' },
  creado:     { type: Date, default: Date.now }
});
const Usuario = mongoose.model('Usuario', usuarioSchema);

const incidenteSchema = new mongoose.Schema({
  numeroRegistro: { type: Number, unique: true },
  titulo:        String,
  tipo:          String,
  area:          String,
  descripcion:   String,
  severidad:     String,
  usuarioId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  usuarioNombre: String,
  usuarioWa:     String,
  fotoUrl:       String,
  fecha:         { type: Date, default: Date.now }
});
const Incidente = mongoose.model('Incidente', incidenteSchema);

const contadorSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });
const Contador = mongoose.model('Contador', contadorSchema);

async function siguienteNumero() {
  const doc = await Contador.findByIdAndUpdate(
    'incidentes',
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );
  return doc.seq;
}

// ── Sesión de WhatsApp (persistida en Mongo para sobrevivir reinicios en Render) ──
const baileysAuthSchema = new mongoose.Schema({
  _id:   String,
  value: String
});
const BaileysAuth = mongoose.model('BaileysAuth', baileysAuthSchema, 'baileys_auth');

async function useMongoAuthState() {
  const writeData = async (id, data) => {
    const value = JSON.stringify(data, BufferJSON.replacer);
    await BaileysAuth.findByIdAndUpdate(id, { value }, { upsert: true });
  };
  const readData = async (id) => {
    const doc = await BaileysAuth.findById(id).lean();
    if (!doc) return null;
    return JSON.parse(doc.value, BufferJSON.reviver);
  };
  const removeData = async (id) => {
    await BaileysAuth.findByIdAndDelete(id);
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const docId = `${category}-${id}`;
              tasks.push(value ? writeData(docId, value) : removeData(docId));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => writeData('creds', creds)
  };
}

// ── RUTAS API ────────────────────────────────────────────────
app.post('/api/registro', async (req, res) => {
  try {
    const { nombre, correo, contrasena } = req.body;
    if (!nombre || !correo || !contrasena)
      return res.status(400).json({ ok: false, mensaje: 'Completa todos los campos.' });
    const existe = await Usuario.findOne({ correo });
    if (existe)
      return res.status(409).json({ ok: false, mensaje: 'El correo ya esta registrado.' });
    const hash = await bcrypt.hash(contrasena, 10);
    await Usuario.create({ nombre, correo, contrasena: hash });
    res.status(201).json({ ok: true, mensaje: 'Usuario registrado correctamente.' });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: 'Error del servidor.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { correo, contrasena } = req.body;
    if (!correo || !contrasena)
      return res.status(400).json({ ok: false, mensaje: 'Completa todos los campos.' });
    const usuario = await Usuario.findOne({ correo });
    if (!usuario)
      return res.status(401).json({ ok: false, mensaje: 'Correo o contrasena incorrectos.' });
    const valido = await bcrypt.compare(contrasena, usuario.contrasena);
    if (!valido)
      return res.status(401).json({ ok: false, mensaje: 'Correo o contrasena incorrectos.' });
    res.json({ ok: true, mensaje: 'Bienvenido, ' + usuario.nombre + '!', nombre: usuario.nombre, id: usuario._id, rol: usuario.rol });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: 'Error del servidor.' });
  }
});

// ── Subir foto ───────────────────────────────────────────────
app.post('/api/upload', upload.single('foto'), async (req, res) => {
  try {
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'sst_incidentes'
    });
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, url: result.secure_url });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: 'Error al subir imagen.' });
  }
});

app.post('/api/incidentes', async (req, res) => {
  try {
    const { titulo, tipo, area, descripcion, severidad, usuarioId, usuarioNombre, fotoUrl } = req.body;
    if (!titulo || !tipo || !area || !descripcion || !severidad)
      return res.status(400).json({ ok: false, mensaje: 'Completa todos los campos.' });
    const numeroRegistro = await siguienteNumero();
    const inc = await Incidente.create({ numeroRegistro, titulo, tipo, area, descripcion, severidad, usuarioId, usuarioNombre, fotoUrl });
    res.status(201).json({ ok: true, mensaje: 'Incidente registrado.', incidente: inc });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: 'Error del servidor.' });
  }
});

app.get('/api/incidentes', async (req, res) => {
  try {
    const { usuarioId } = req.query;
    const filtro = usuarioId ? { usuarioId } : {};
    const incidentes = await Incidente.find(filtro).sort({ fecha: -1 });
    res.json({ ok: true, incidentes });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: 'Error del servidor.' });
  }
});

app.delete('/api/incidentes/:id', async (req, res) => {
  try {
    await Incidente.findByIdAndDelete(req.params.id);
    res.json({ ok: true, mensaje: 'Incidente eliminado.' });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: 'Error del servidor.' });
  }
});

app.get('/api/admin/usuarios', async (req, res) => {
  try {
    const usuarios = await Usuario.find({}, '-contrasena').sort({ creado: -1 });
    res.json({ ok: true, usuarios });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: 'Error del servidor.' });
  }
});

app.put('/api/admin/usuarios/:id/rol', async (req, res) => {
  try {
    const { rol } = req.body;
    await Usuario.findByIdAndUpdate(req.params.id, { rol });
    res.json({ ok: true, mensaje: 'Rol actualizado.' });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: 'Error del servidor.' });
  }
});

app.delete('/api/admin/usuarios/:id', async (req, res) => {
  try {
    await Usuario.findByIdAndDelete(req.params.id);
    res.json({ ok: true, mensaje: 'Usuario eliminado.' });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: 'Error del servidor.' });
  }
});

app.get('/api/estadisticas', async (req, res) => {
  try {
    const total        = await Incidente.countDocuments();
    const porSeveridad = await Incidente.aggregate([{ $group: { _id: '$severidad', count: { $sum: 1 } } }]);
    const porTipo      = await Incidente.aggregate([{ $group: { _id: '$tipo',      count: { $sum: 1 } } }]);
    res.json({ ok: true, total, porSeveridad, porTipo });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: 'Error del servidor.' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.listen(PORT, () => {
  console.log('🚀 Servidor SST en http://localhost:' + PORT);
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://proyecto-sst-i8zu.onrender.com';
  setInterval(() => {
    fetch(SELF_URL + '/health')
      .then(r => r.json())
      .then(() => console.log('🏓 Keep-alive ping OK'))
      .catch(e => console.warn('⚠️ Keep-alive ping falló:', e.message));
  }, 10 * 60 * 1000);
});

// ── BOT WHATSAPP ─────────────────────────────────────────────
   const sesiones = {};
   const procesados = new Set();
   let botIniciado    = false;
   let reconectando   = false;
   let reconexionTimer = null;
   let delaReconexion = 5000;   // empieza en 5 s, sube hasta MAX_DELAY
   const MAX_DELAY    = 60000;
   let sockActivo     = null;   // única instancia del socket activo
   let codigoSolicitado = false;
   let codigoVinculacion = null;
   let waConectado = false;

function programarReconexion() {
  if (reconectando) return;           // ya hay una reconexión programada
  reconectando = true;
  botIniciado  = false;
  if (sockActivo) {
    try { sockActivo.end(undefined); } catch {}
    sockActivo = null;
  }
  console.log(`⏳ Reconectando en ${delaReconexion / 1000}s...`);
  clearTimeout(reconexionTimer);
  reconexionTimer = setTimeout(() => {
    reconectando   = false;
    reconexionTimer = null;
    iniciarBot();
  }, delaReconexion);
  delaReconexion = Math.min(delaReconexion * 2, MAX_DELAY);
}

// Estado de vinculación: GET /api/whatsapp/estado?token=ADMIN_TOKEN
app.get('/api/whatsapp/estado', (req, res) => {
  if (process.env.ADMIN_TOKEN && req.query.token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ ok: false, mensaje: 'No autorizado.' });
  }
  res.json({ ok: true, conectado: waConectado, codigo: codigoVinculacion });
});

 async function iniciarBot() {
   if (botIniciado) return;
   botIniciado = true;
  try {
    const { state, saveCreds } = await useMongoAuthState();
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
    });

    sockActivo = sock;
    sock.ev.on('creds.update', saveCreds);

    // Vincular por número en vez de QR
    if (!sock.authState.creds.registered && !codigoSolicitado) {
      codigoSolicitado = true;
      const numeroEnv = process.env.WA_PHONE_NUMBER;

      const pedirCodigo = async (numero) => {
        await new Promise(r => setTimeout(r, 8000));
        try {
          const code = await sock.requestPairingCode(numero.trim());
          codigoVinculacion = code;
          console.log(`\n🔑 Tu código: ${code}`);
          console.log('WhatsApp → Dispositivos vinculados → Vincular con número\n');
        } catch (e) {
          console.error('Error al pedir código:', e.message, e.stack);
          codigoSolicitado = false;
        }
      };

      if (numeroEnv) {
        // Producción (Render): número configurado por variable de entorno, sin consola interactiva
        setTimeout(() => pedirCodigo(numeroEnv), 10000);
      } else {
        // Desarrollo local: pedir el número por consola
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question('📱 Ingresa tu número (ej: 51987654321): ', async (numero) => {
          rl.close();
          await pedirCodigo(numero);
        });
      }
    }

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'close') {
        waConectado = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) {
          programarReconexion();
        } else {
          // sesión cerrada intencionalmente — no reconectar
          botIniciado = false;
          sockActivo  = null;
          codigoSolicitado  = false;
          codigoVinculacion = null;
        }
      }
      if (connection === 'open') {
        delaReconexion    = 5000; // reset backoff al conectar con éxito
        codigoSolicitado  = false;
        codigoVinculacion = null;
        waConectado = true;
        console.log('✅ Bot WhatsApp conectado!');
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      const msg = messages[0];
      const msgId = msg.key.id;
      if (procesados.has(msgId)) return;
      procesados.add(msgId);
      setTimeout(() => procesados.delete(msgId), 30000);
      if (!msg?.message || msg.key.fromMe) return;

      const texto  = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim().toLowerCase();
      const from   = msg.key.remoteJid;
      const esGrupo = from.endsWith('@g.us');
      const waId   = msg.key.participant || from;
      const nombre = msg.pushName || 'Trabajador';

      const reply = async (text) => {
        if (esGrupo) {
          await sock.sendMessage(from, { text: `@${waId.split('@')[0]} ${text}`, mentions: [waId] }, { quoted: msg });
        } else {
          await sock.sendMessage(from, { text }, { quoted: msg });
        }
      };

      // Manejo de foto en paso 6
      if (sesiones[waId] && sesiones[waId].paso === 6) {
        const sesion = sesiones[waId];

        // Si envía imagen
        if (msg.message.imageMessage) {
          try {
            await reply('📤 Subiendo foto...');
           const buffer = await downloadMediaMessage(msg, 'buffer', {});
            const result = await cloudinary.uploader.upload(
              `data:image/jpeg;base64,${buffer.toString('base64')}`,
              { folder: 'sst_incidentes' }
            );
            sesion.data.fotoUrl = result.secure_url;
          } catch (err) {
              console.error('❌ Error Cloudinary:', err.message);
              sesion.data.fotoUrl = null;
          }
        } else {
          // Si escribe "sin foto"
          sesion.data.fotoUrl = null;
        }

        try {
          const numeroRegistro = await siguienteNumero();
          await Incidente.create({ ...sesion.data, numeroRegistro });
          delete sesiones[waId];
          await reply(
            `✅ *Incidente registrado*\n\n` +
            `📌 *${sesion.data.titulo}*\n` +
            `Tipo: ${sesion.data.tipo}\n` +
            `Severidad: ${sesion.data.severidad}\n` +
            `Área: ${sesion.data.area}\n` +
            (sesion.data.fotoUrl ? `📸 Foto adjunta\n` : '') +
            `\n🌐 https://proyecto-sst-i8zu.onrender.com`
          );
        } catch {
          await reply('❌ Error al guardar. Intenta con *!reporte*');
          delete sesiones[waId];
        }
        return;
      }

      if (!texto) return;

      if (texto === '!ayuda' || texto === '!help') {
        await reply(
          `🦺 *IDE - Mantenimiento Envasado*\n\n` +
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
          await reply(`📊 *Estadísticas SST*\n\nTotal: *${total}*\n🔴 Críticos: *${criticos}*\n🟠 Altos: *${altos}*\n🟡 Medios: *${medios}*\n🟢 Bajos: *${bajos}*\n\n🌐 https://proyecto-sst-i8zu.onrender.com`);
        } catch { await reply('❌ Error.'); }
        return;
      }

      if (texto === '!misreportes') {
        try {
          const reportes = await Incidente.find({ usuarioWa: waId }).sort({ fecha: -1 }).limit(5);
          if (!reportes.length) { await reply(`📋 No tienes reportes.\n\nUsa *!reporte* para crear uno.`); return; }
          const meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
          let r = `📋 *Tus reportes:*\n\n`;
          reportes.forEach((rep, i) => {
            const f = new Date(rep.fecha);
            r += `*${i+1}. ${rep.titulo}*\n${rep.tipo} | ${rep.severidad}\n${rep.area}\n${f.getDate()} ${meses[f.getMonth()]} ${f.getFullYear()}\n\n`;
          });
          await reply(r);
        } catch { await reply('❌ Error.'); }
        return;
      }

      if (texto === '!reporte') {
        sesiones[waId] = { paso: 1, data: { usuarioNombre: nombre, usuarioWa: waId } };
        await reply(`⚠️ *Nuevo Reporte SST*\n\n*Paso 1/6* — Título del incidente:\n\n_Ej: Derrame de aceite en caldera 2_`);
        return;
      }

      if (sesiones[waId]) {
        const s   = sesiones[waId];
        const raw = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        if (s.paso === 1) { s.data.titulo = raw; s.paso = 2; await reply(`*Paso 2/6* — Tipo:\n\n1️⃣ Accidente\n2️⃣ Casi accidente\n3️⃣ Condición insegura\n4️⃣ Otro`); return; }
        if (s.paso === 2) { s.data.tipo = {'1':'accidente','2':'casi-accidente','3':'condicion-insegura','4':'otro'}[texto]||'otro'; s.paso = 3; await reply(`*Paso 3/6* — Severidad:\n\n1️⃣ Baja\n2️⃣ Media\n3️⃣ Alta\n4️⃣ Crítica`); return; }
        if (s.paso === 3) { s.data.severidad = {'1':'baja','2':'media','3':'alta','4':'critica'}[texto]||'media'; s.paso = 4; await reply(`*Paso 4/6* — Área:`); return; }
        if (s.paso === 4) { s.data.area = raw; s.paso = 5; await reply(`*Paso 5/6* — Descripción:`); return; }
        if (s.paso === 5) { s.data.descripcion = raw; s.paso = 6; await reply(`*Paso 6/6* — 📸 Envía una foto del incidente\n\n_O escribe "sin foto" para omitir_`); return; }
      }

      if (texto.startsWith('!')) await reply(`❓ Comando no reconocido.\n\nEscribe *!ayuda* para ver los comandos.`);
    });

  } catch (err) {
    console.error('Error bot:', err.message);
    botIniciado = false;
    programarReconexion();
  }
}
