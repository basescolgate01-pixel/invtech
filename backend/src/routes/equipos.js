const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const multer = require('multer');
const xlsx = require('xlsx');

const upload = multer({ storage: multer.memoryStorage() });

function soloAdmin(req, res, next) {
  if (!req.usuario || req.usuario.rol !== 'admin') {
    return res.status(403).json({ error: 'Solo administradores' });
  }
  next();
}

// GET /api/equipos
router.get('/', auth, async (req, res) => {
  try {
    const { q, estado } = req.query;
    let query = `
      SELECT e.*, a.nombre as area, t.nombre as tipo, t.icono as tipo_icono,
        f.nombre as asignado_a
      FROM equipos e
      LEFT JOIN areas a ON e.area_id = a.id
      LEFT JOIN tipos_equipo t ON e.tipo_id = t.id
      LEFT JOIN asignaciones asig ON asig.equipo_id = e.id
        AND asig.tipo = 'asignacion'
        AND asig.id = (SELECT MAX(id) FROM asignaciones WHERE equipo_id = e.id AND tipo = 'asignacion')
      LEFT JOIN funcionarios f ON asig.funcionario_id = f.id
      WHERE 1=1
    `;
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      query += ` AND (e.imei1 ILIKE $${params.length} OR e.imei2 ILIKE $${params.length} OR e.numero_serie ILIKE $${params.length} OR e.modelo ILIKE $${params.length} OR e.marca ILIKE $${params.length})`;
    }
    if (estado) { params.push(estado); query += ` AND e.estado = $${params.length}`; }
    query += ' ORDER BY e.created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener equipos' });
  }
});

// GET /api/equipos/stats/resumen
router.get('/stats/resumen', auth, async (req, res) => {
  try {
    const kpis = await pool.query(`
      SELECT COUNT(*) as total,
        COUNT(*) FILTER (WHERE estado = 'asignado') as asignados,
        COUNT(*) FILTER (WHERE estado = 'disponible') as disponibles,
        COUNT(*) FILTER (WHERE estado = 'mantencion') as mantencion
      FROM equipos
    `);
    const porArea = await pool.query(`
      SELECT COALESCE(a.nombre, 'Sin área') as area, COUNT(e.id) as cantidad
      FROM equipos e LEFT JOIN areas a ON e.area_id = a.id
      GROUP BY a.nombre ORDER BY cantidad DESC
    `);
    const porTipo = await pool.query(`
      SELECT COALESCE(t.icono,'📱') as icono, COALESCE(t.nombre,'Sin tipo') as tipo, COUNT(e.id) as cantidad
      FROM equipos e LEFT JOIN tipos_equipo t ON e.tipo_id = t.id
      GROUP BY t.nombre, t.icono ORDER BY cantidad DESC
    `);
    res.json({ kpis: kpis.rows[0], por_area: porArea.rows, por_tipo: porTipo.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// GET /api/equipos/buscar
router.get('/buscar', auth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Parámetro requerido' });
    const result = await pool.query(`
      SELECT e.*, a.nombre as area, t.nombre as tipo, t.icono as tipo_icono, f.nombre as asignado_a
      FROM equipos e
      LEFT JOIN areas a ON e.area_id = a.id
      LEFT JOIN tipos_equipo t ON e.tipo_id = t.id
      LEFT JOIN asignaciones asig ON asig.equipo_id = e.id
        AND asig.tipo = 'asignacion'
        AND asig.id = (SELECT MAX(id) FROM asignaciones WHERE equipo_id = e.id AND tipo = 'asignacion')
      LEFT JOIN funcionarios f ON asig.funcionario_id = f.id
      WHERE e.imei1 = $1 OR e.imei2 = $1 OR e.numero_serie = $1 LIMIT 1
    `, [q]);
    if (!result.rows.length) return res.status(404).json({ error: 'Equipo no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al buscar equipo' });
  }
});

// GET /api/equipos/plantilla
router.get('/plantilla', auth, (req, res) => {
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet([
    ['imei1', 'imei2', 'numero_serie', 'modelo', 'marca', 'notas'],
    ['351234567890123', '351234567890124', 'SN-001', 'Samsung Galaxy S23', 'Samsung', 'Equipo nuevo'],
  ]);
  xlsx.utils.book_append_sheet(wb, ws, 'Equipos');
  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=plantilla_equipos.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

// GET /api/equipos/ficha/:imei1
router.get('/ficha/:imei1', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.*, a.nombre as area, t.nombre as tipo,
        f.nombre as funcionario_nombre, f.rut as funcionario_rut,
        asig.fecha as fecha_asignacion, asig.observacion, u.nombre as registrado_por
      FROM equipos e
      LEFT JOIN areas a ON e.area_id = a.id
      LEFT JOIN tipos_equipo t ON e.tipo_id = t.id
      LEFT JOIN asignaciones asig ON asig.equipo_id = e.id
        AND asig.id = (SELECT MAX(id) FROM asignaciones WHERE equipo_id = e.id AND tipo = 'asignacion')
      LEFT JOIN funcionarios f ON asig.funcionario_id = f.id
      LEFT JOIN usuarios u ON asig.usuario_id = u.id
      WHERE e.imei1 = $1
    `, [req.params.imei1]);
    if (!result.rows.length) return res.status(404).json({ error: 'Equipo no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener ficha' });
  }
});

// POST /api/equipos
router.post('/', auth, async (req, res) => {
  try {
    const { imei1, imei2, numero_serie, modelo, marca, notas, area_id, tipo_id } = req.body;
    if (!imei1 || !modelo) return res.status(400).json({ error: 'IMEI 1 y modelo son requeridos' });
    const exists = await pool.query('SELECT id FROM equipos WHERE imei1 = $1', [imei1]);
    if (exists.rows.length > 0) return res.status(400).json({ error: 'Ya existe un equipo con ese IMEI 1' });
    const result = await pool.query(`
      INSERT INTO equipos (imei1, imei2, numero_serie, modelo, marca, notas, area_id, tipo_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [imei1, imei2||null, numero_serie||null, modelo, marca||null, notas||null, area_id||null, tipo_id||null]);
    const equipo = result.rows[0];
    await pool.query(`INSERT INTO asignaciones (equipo_id, usuario_id, tipo, observacion) VALUES ($1,$2,'ingreso',$3)`,
      [equipo.id, req.usuario.id, notas || 'Ingreso inicial al sistema']);
    res.json({ ok: true, equipo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear equipo' });
  }
});

// POST /api/equipos/importar
router.post('/importar', auth, upload.single('archivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const filas = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    if (!filas.length) return res.status(400).json({ error: 'Archivo vacío' });
    const resultados = { exitosos: 0, errores: [], total: filas.length };
    for (const fila of filas) {
      const imei1 = String(fila['imei1'] || fila['IMEI1'] || '').trim();
      const modelo = String(fila['modelo'] || fila['MODELO'] || '').trim();
      if (!imei1 || !modelo) { resultados.errores.push('Fila sin IMEI1 o modelo'); continue; }
      try {
        const exists = await pool.query('SELECT id FROM equipos WHERE imei1 = $1', [imei1]);
        if (exists.rows.length > 0) { resultados.errores.push(`IMEI1 ${imei1} ya existe`); continue; }
        const r = await pool.query(`INSERT INTO equipos (imei1, imei2, numero_serie, modelo, marca, notas) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [imei1, String(fila['imei2']||'').trim()||null, String(fila['numero_serie']||'').trim()||null, modelo, String(fila['marca']||'').trim()||null, String(fila['notas']||'').trim()||null]);
        await pool.query(`INSERT INTO asignaciones (equipo_id, usuario_id, tipo, observacion) VALUES ($1,$2,'ingreso','Importación masiva')`, [r.rows[0].id, req.usuario.id]);
        resultados.exitosos++;
      } catch (e) { resultados.errores.push(`Error en ${imei1}: ${e.message}`); }
    }
    res.json({ ok: true, resultados });
  } catch (err) {
    res.status(500).json({ error: 'Error al importar' });
  }
});

// POST /api/equipos/masivo
router.post('/masivo', auth, async (req, res) => {
  try {
    const { equipos } = req.body;
    if (!equipos?.length) return res.status(400).json({ error: 'Lista requerida' });
    const resultados = { exitosos: 0, errores: [], total: equipos.length };
    for (const eq of equipos) {
      if (!eq.imei1 || !eq.modelo) { resultados.errores.push('Equipo sin IMEI1 o modelo'); continue; }
      try {
        const exists = await pool.query('SELECT id FROM equipos WHERE imei1 = $1', [eq.imei1]);
        if (exists.rows.length > 0) { resultados.errores.push(`IMEI1 ${eq.imei1} ya existe`); continue; }
        const r = await pool.query(`INSERT INTO equipos (imei1, imei2, numero_serie, modelo, marca, notas, area_id, tipo_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [eq.imei1, eq.imei2||null, eq.numero_serie||null, eq.modelo, eq.marca||null, eq.notas||null, eq.area_id||null, eq.tipo_id||null]);
        await pool.query(`INSERT INTO asignaciones (equipo_id, usuario_id, tipo, observacion) VALUES ($1,$2,'ingreso','Ingreso masivo')`, [r.rows[0].id, req.usuario.id]);
        resultados.exitosos++;
      } catch (e) { resultados.errores.push(`Error en ${eq.imei1}: ${e.message}`); }
    }
    res.json({ ok: true, resultados });
  } catch (err) {
    res.status(500).json({ error: 'Error en ingreso masivo' });
  }
});

// PUT /api/equipos/:id - solo admin
router.put('/:id', auth, soloAdmin, async (req, res) => {
  try {
    const { imei1, imei2, numero_serie, modelo, marca, notas, area_id, estado, tipo_id } = req.body;
    const result = await pool.query(`
      UPDATE equipos SET
        imei1 = COALESCE($1, imei1), imei2 = $2, numero_serie = $3,
        modelo = COALESCE($4, modelo), marca = $5, notas = $6,
        area_id = $7, estado = COALESCE($8, estado), tipo_id = $9,
        updated_at = NOW()
      WHERE id = $10 RETURNING *
    `, [imei1, imei2||null, numero_serie||null, modelo, marca||null, notas||null, area_id||null, estado, tipo_id||null, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Equipo no encontrado' });
    res.json({ ok: true, equipo: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar equipo' });
  }
});

// DELETE /api/equipos/:id - solo admin
router.delete('/:id', auth, soloAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM asignaciones WHERE equipo_id = $1', [req.params.id]);
    const result = await pool.query('DELETE FROM equipos WHERE id = $1 RETURNING imei1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Equipo no encontrado' });
    res.json({ ok: true, mensaje: `Equipo ${result.rows[0].imei1} eliminado` });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar equipo' });
  }
});

module.exports = router;
