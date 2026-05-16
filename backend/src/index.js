const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/equipos', require('./routes/equipos'));
app.use('/api/asignaciones', require('./routes/asignaciones'));
app.use('/api/funcionarios', require('./routes/funcionarios'));
app.use('/api/usuarios', require('./routes/usuarios'));
app.use('/api/tipos', require('./routes/tipos'));
app.use('/api/bajas', require('./routes/bajas'));
app.use('/api/areas', require('./routes/areas'));

app.use(express.static(path.join(__dirname, '../../frontend/public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`InvTech corriendo en puerto ${PORT}`));
