const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const xlsx = require('xlsx');

// GET /api/asignaciones
router.get('/', auth, async (req, res) => {
  try {
    const { q, tipo, desde, hasta, limit = 200 } = req.query;
    let query = `
      SELECT 
        a.id, a.tipo, a.observacion, a.fecha,
        e.imei1, e.imei2, e.numero_serie, e.modelo, e.marca,
        ar.nombre as area,
        f.nombre as funcionario,
        u.nombre as registrado_por
      FROM asignaciones a
      JOIN equipos e ON a.equipo_id = e.id
      LEFT JOIN areas ar ON e.area_id = ar.id
      LEFT JOIN funcionarios f ON a.funcionario_id = f.id
      LEFT JOIN usuarios u ON a.usuario_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (q) {
      params.push(`%${q}%`);
      query += ` AND (e.imei1 ILIKE $${params.length} OR e.imei2 ILIKE $${params.length} OR e.numero_serie ILIKE $${params.length} OR e.modelo ILIKE $${params.length})`;
    }
    if (tipo) {
      params.push(tipo);
      query += ` AND a.tipo = $${params.length}`;
    }
    if (desde) {
      params.push(desde);
      query += ` AND a.fecha >= $${params.length}`;
    }
    if (hasta) {
      params.push(hasta + ' 23:59:59');
      query += ` AND a.fecha <= $${params.length}`;
    }

    params.push(limit);
    query += ` ORDER BY a.fecha DESC LIMIT $${params.length}`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener movimientos' });
  }
});

// POST /api/asignaciones
router.post('/', auth, async (req, res) => {
  try {
    const { equipo_id, funcionario_id, tipo, observacion } = req.body;

    if (!equipo_id || !tipo) {
      return res.status(400).json({ error: 'Equipo y tipo son requeridos' });
    }

    // Actualizar estado del equipo según tipo
    const estadoMap = {
      asignacion: 'asignado',
      devolucion: 'disponible',
      mantencion: 'mantencion',
      baja: 'baja'
    };

    if (estadoMap[tipo]) {
      await pool.query('UPDATE equipos SET estado = $1, updated_at = NOW() WHERE id = $2', [estadoMap[tipo], equipo_id]);
    }

    await pool.query(`
      INSERT INTO asignaciones (equipo_id, funcionario_id, usuario_id, tipo, observacion)
      VALUES ($1, $2, $3, $4, $5)
    `, [equipo_id, funcionario_id || null, req.usuario.id, tipo, observacion || null]);

    res.json({ ok: true, mensaje: 'Movimiento registrado correctamente' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar movimiento' });
  }
});

// GET /api/asignaciones/export/excel
router.get('/export/excel', auth, async (req, res) => {
  try {
    const { q, tipo, desde, hasta } = req.query;
    let query = `
      SELECT 
        TO_CHAR(a.fecha, 'DD/MM/YYYY HH24:MI') as fecha,
        a.tipo,
        e.imei1, e.imei2, e.numero_serie,
        e.modelo, e.marca,
        ar.nombre as area,
        f.nombre as funcionario,
        u.nombre as registrado_por,
        a.observacion
      FROM asignaciones a
      JOIN equipos e ON a.equipo_id = e.id
      LEFT JOIN areas ar ON e.area_id = ar.id
      LEFT JOIN funcionarios f ON a.funcionario_id = f.id
      LEFT JOIN usuarios u ON a.usuario_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (q) { params.push(`%${q}%`); query += ` AND (e.imei1 ILIKE $${params.length} OR e.modelo ILIKE $${params.length})`; }
    if (tipo) { params.push(tipo); query += ` AND a.tipo = $${params.length}`; }
    if (desde) { params.push(desde); query += ` AND a.fecha >= $${params.length}`; }
    if (hasta) { params.push(hasta + ' 23:59:59'); query += ` AND a.fecha <= $${params.length}`; }

    query += ' ORDER BY a.fecha DESC LIMIT 5000';

    const result = await pool.query(query, params);

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(result.rows, {
      header: ['fecha','tipo','imei1','imei2','numero_serie','modelo','marca','area','funcionario','registrado_por','observacion']
    });
    xlsx.utils.book_append_sheet(wb, ws, 'Auditoría');

    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=auditoria.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Error al exportar' });
  }
});

module.exports = router;
