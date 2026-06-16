require('dotenv').config();
const mongoose = require('mongoose');

const Contador = mongoose.model('Contador', new mongoose.Schema({
  _id: String,
  seq: { type: Number, default: 0 }
}));

async function resetear() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Conectado a MongoDB Atlas');

  await Contador.findByIdAndUpdate(
    'incidentes',
    { seq: 0 },
    { upsert: true }
  );

  console.log('✅ Contador reiniciado a 0. El próximo incidente será #1.');
  await mongoose.disconnect();
}

resetear().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
