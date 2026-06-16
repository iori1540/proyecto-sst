require('dotenv').config();
const mongoose = require('mongoose');

const Incidente = mongoose.model('Incidente', new mongoose.Schema({
  numeroRegistro: Number,
  fecha: Date
}, { strict: false }));

const Contador = mongoose.model('Contador', new mongoose.Schema({
  _id: String,
  seq: { type: Number, default: 0 }
}));

async function migrar() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Conectado a MongoDB Atlas');

  const sinNumero = await Incidente.find({ numeroRegistro: { $exists: false } }).sort({ fecha: 1 });
  console.log(`📋 Incidentes sin número de registro: ${sinNumero.length}`);

  if (!sinNumero.length) {
    console.log('✅ Nada que migrar.');
    await mongoose.disconnect();
    return;
  }

  // Obtener el máximo número ya asignado para no pisar los existentes
  const maxDoc = await Incidente.findOne({ numeroRegistro: { $exists: true } }).sort({ numeroRegistro: -1 });
  let contador = maxDoc ? maxDoc.numeroRegistro : 0;

  for (const inc of sinNumero) {
    contador++;
    await Incidente.findByIdAndUpdate(inc._id, { numeroRegistro: contador });
    console.log(`  #${contador} → ${inc.titulo || inc._id}`);
  }

  // Sincronizar el contador en Mongo para que los nuevos registros continúen desde aquí
  await Contador.findByIdAndUpdate(
    'incidentes',
    { seq: contador },
    { upsert: true }
  );

  console.log(`\n✅ Migración completada. ${sinNumero.length} incidentes actualizados.`);
  console.log(`📌 Contador sincronizado en ${contador}. El próximo registro será #${contador + 1}.`);
  await mongoose.disconnect();
}

migrar().catch(err => {
  console.error('❌ Error en migración:', err.message);
  process.exit(1);
});
