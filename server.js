require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middlewares ──────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Conexión MongoDB Atlas ───────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Conectado a MongoDB Atlas'))
  .catch(err => console.error('❌ Error de conexión:', err.message));

// ── Modelo Usuario ───────────────────────────────────────────
const usuarioSchema = new mongoose.Schema({
  nombre:    { type: String, required: true },
  correo:    { type: String, required: true, unique: true, lowercase: true },
  contrasena:{ type: String, required: true },
  rol:       { type: String, default: 'trabajador' }, // trabajador | admin
  creado:    { type: Date,   default: Date.now }
});

const Usuario = mongoose.model('Usuario', usuarioSchema);

// ── RUTA: Registro ───────────────────────────────────────────
app.post('/api/registro', async (req, res) => {
  try {
    const { nombre, correo, contrasena } = req.body;

    if (!nombre || !correo || !contrasena)
      return res.status(400).json({ ok: false, mensaje: 'Completa todos los campos.' });

    const existe = await Usuario.findOne({ correo });
    if (existe)
      return res.status(409).json({ ok: false, mensaje: 'El correo ya está registrado.' });

    const hash = await bcrypt.hash(contrasena, 10);
    await Usuario.create({ nombre, correo, contrasena: hash });

    res.status(201).json({ ok: true, mensaje: 'Usuario registrado correctamente.' });

  } catch (err) {
    res.status(500).json({ ok: false, mensaje: 'Error del servidor.' });
  }
});

// ── RUTA: Login ──────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { correo, contrasena } = req.body;

    if (!correo || !contrasena)
      return res.status(400).json({ ok: false, mensaje: 'Completa todos los campos.' });

    const usuario = await Usuario.findOne({ correo });
    if (!usuario)
      return res.status(401).json({ ok: false, mensaje: 'Correo o contraseña incorrectos.' });

    const valido = await bcrypt.compare(contrasena, usuario.contrasena);
    if (!valido)
      return res.status(401).json({ ok: false, mensaje: 'Correo o contraseña incorrectos.' });

    res.json({ ok: true, mensaje: `Bienvenido, ${usuario.nombre}!`, rol: usuario.rol });

  } catch (err) {
    res.status(500).json({ ok: false, mensaje: 'Error del servidor.' });
  }
});

// ── Iniciar servidor ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor SST en http://localhost:${PORT}`);
});
