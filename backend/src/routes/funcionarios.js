const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const multer = require('multer');
const xlsx = require('xlsx');

const upload = multer({ storage: multer.memoryStorage() });

// GET /api/funcionarios
router.get('/', auth, async (req, res) => {
  try {
    const { q } = req.query;
    let query = `SELECT f.*, a.nombre as area FROM funcionarios f LEFT JOIN areas a ON f.area_id = a.id WHERE f.activo = true`;
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      query += ` AND (f.nombre ILIKE $1 OR f.rut ILIKE $1 OR f.cargo ILIKE $1)`;
    }
    query += ' ORDER BY f.nombre';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener funcionarios' });
  }
});

// POST /api/funcionarios
router.post('/', auth, async (req, res) => {
  try {
    const { nombre, rut, cargo, area_id, email, telefono } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    const result = await pool.query(
      `INSERT INTO funcionarios (nombre, rut, cargo, area_id, email, telefono)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [nombre, rut || null, cargo || null, area_id || null, email || null, telefono || null]
    );
    res.json({ ok: true, funcionario: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Error al crear funcionario' });
  }
});

// PUT /api/funcionarios/:id
router.put('/:id', auth, async (req, res) => {
  try {
    const { nombre, rut, cargo, area_id, email, telefono, activo } = req.body;
    const result = await pool.query(
      `UPDATE funcionarios SET nombre=COALESCE($1,nombre), rut=$2, cargo=$3, area_id=$4, email=$5, telefono=$6, activo=COALESCE($7,activo)
       WHERE id=$8 RETURNING *`,
      [nombre, rut || null, cargo || null, area_id || null, email || null, telefono || null, activo, req.params.id]
    );
    res.json({ ok: true, funcionario: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar funcionario' });
  }
});

// DELETE /api/funcionarios/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    await pool.query('UPDATE funcionarios SET activo = false WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al desactivar funcionario' });
  }
});

// POST /api/funcionarios/masivo - carga masiva
router.post('/masivo', auth, async (req, res) => {
  try {
    const { funcionarios } = req.body;
    if (!funcionarios || !Array.isArray(funcionarios) || !funcionarios.length) {
      return res.status(400).json({ error: 'Lista requerida' });
    }
    const resultados = { exitosos: 0, errores: [], total: funcionarios.length };
    for (const f of funcionarios) {
      if (!f.nombre) { resultados.errores.push('Fila sin nombre'); continue; }
      try {
        // Buscar área por nombre si se proporciona
        let area_id = null;
        if (f.area) {
          const areaResult = await pool.query('SELECT id FROM areas WHERE nombre ILIKE $1', [f.area]);
          if (areaResult.rows.length > 0) area_id = areaResult.rows[0].id;
        }
        await pool.query(
          `INSERT INTO funcionarios (nombre, rut, cargo, area_id, email, telefono)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [f.nombre, f.rut || null, f.cargo || null, area_id, f.email || null, f.telefono || null]
        );
        resultados.exitosos++;
      } catch (e) {
        resultados.errores.push(`Error en ${f.nombre}: ${e.message}`);
      }
    }
    res.json({ ok: true, resultados });
  } catch (err) {
    res.status(500).json({ error: 'Error en carga masiva' });
  }
});

// POST /api/funcionarios/importar - desde Excel
router.post('/importar', auth, upload.single('archivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const filas = xlsx.utils.sheet_to_json(sheet);
    if (!filas.length) return res.status(400).json({ error: 'Archivo vacío' });
    const resultados = { exitosos: 0, errores: [], total: filas.length };
    for (const fila of filas) {
      const nombre = String(fila['nombre'] || fila['NOMBRE'] || fila['Nombre'] || '').trim();
      const rut = String(fila['rut'] || fila['RUT'] || fila['Rut'] || '').trim();
      const cargo = String(fila['cargo'] || fila['CARGO'] || fila['Cargo'] || '').trim();
      const area = String(fila['area'] || fila['AREA'] || fila['Área'] || '').trim();
      const email = String(fila['email'] || fila['EMAIL'] || '').trim();
      const telefono = String(fila['telefono'] || fila['TELEFONO'] || '').trim();
      if (!nombre) { resultados.errores.push('Fila sin nombre'); continue; }
      try {
        let area_id = null;
        if (area) {
          const areaResult = await pool.query('SELECT id FROM areas WHERE nombre ILIKE $1', [area]);
          if (areaResult.rows.length > 0) area_id = areaResult.rows[0].id;
        }
        await pool.query(
          `INSERT INTO funcionarios (nombre, rut, cargo, area_id, email, telefono) VALUES ($1,$2,$3,$4,$5,$6)`,
          [nombre, rut || null, cargo || null, area_id, email || null, telefono || null]
        );
        resultados.exitosos++;
      } catch (e) {
        resultados.errores.push(`Error en ${nombre}: ${e.message}`);
      }
    }
    res.json({ ok: true, resultados });
  } catch (err) {
    res.status(500).json({ error: 'Error al importar' });
  }
});

// GET /api/funcionarios/plantilla
router.get('/plantilla', auth, (req, res) => {
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet([
    ['nombre', 'rut', 'cargo', 'area', 'email', 'telefono'],
    ['Juan Pérez', '12.345.678-9', 'Técnico', 'TI', 'juan@empresa.cl', '+56912345678'],
    ['María González', '9.876.543-2', 'Vendedor', 'Ventas', 'maria@empresa.cl', ''],
  ]);
  xlsx.utils.book_append_sheet(wb, ws, 'Funcionarios');
  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=plantilla_funcionarios.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

module.exports = router;
