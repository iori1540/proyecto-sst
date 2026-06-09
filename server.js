require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── MongoDB ──────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Conectado a MongoDB Atlas'))
  .catch(err => console.error('❌ Error:', err.message));

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
  titulo:        { type: String, required: true },
  tipo:          { type: String, required: true },
  area:          { type: String, required: true },
  descripcion:   { type: String, required: true },
  severidad:     { type: String, required: true },
  usuarioId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  usuarioNombre: { type: String },
  fecha:         { type: Date, default: Date.now }
});
const Incidente = mongoose.model('Incidente', incidenteSchema);

// ── AUTH ─────────────────────────────────────────────────────
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

// ── INCIDENTES ───────────────────────────────────────────────
app.post('/api/incidentes', async (req, res) => {
  try {
    const { titulo, tipo, area, descripcion, severidad, usuarioId, usuarioNombre } = req.body;
    if (!titulo || !tipo || !area || !descripcion || !severidad)
      return res.status(400).json({ ok: false, mensaje: 'Completa todos los campos.' });
    const inc = await Incidente.create({ titulo, tipo, area, descripcion, severidad, usuarioId, usuarioNombre });
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

// ── ADMIN ─────────────────────────────────────────────────────
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

app.get('/api/estadisticas', async (req, res) => {
  try {
    const total = await Incidente.countDocuments();
    const porSeveridad = await Incidente.aggregate([{ $group: { _id: '$severidad', count: { $sum: 1 } } }]);
    const porTipo      = await Incidente.aggregate([{ $group: { _id: '$tipo',      count: { $sum: 1 } } }]);
    const porMes       = await Incidente.aggregate([
      { $group: { _id: { mes: { $month: '$fecha' }, anio: { $year: '$fecha' } }, count: { $sum: 1 } } },
      { $sort: { '_id.anio': 1, '_id.mes': 1 } },
      { $limit: 6 }
    ]);
    res.json({ ok: true, total, porSeveridad, porTipo, porMes });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: 'Error del servidor.' });
  }
});

app.listen(PORT, () => console.log('Servidor SST en http://localhost:' + PORT));
