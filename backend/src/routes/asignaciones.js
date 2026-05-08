const router = require('express').Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');

// POST /api/asignaciones — registrar movimiento
router.post('/', auth, async (req, res) => {
  const { equipo_id, funcionario_id, tipo, observacion } = req.body;
  if (!equipo_id || !tipo)
    return res.status(400).json({ error: 'equipo_id y tipo son requeridos' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Registrar en auditoría
    await client.query(
      `INSERT INTO asignaciones (equipo_id, funcionario_id, usuario_id, tipo, observacion)
       VALUES ($1,$2,$3,$4,$5)`,
      [equipo_id, funcionario_id || null, req.user.id, tipo, observacion]
    );

    // Actualizar estado del equipo
    const estadoMap = {
      asignacion: 'asignado',
      devolucion: 'disponible',
      mantencion: 'mantencion',
      baja: 'baja'
    };
    const nuevoEstado = estadoMap[tipo];
    const areaId = tipo === 'devolucion' || tipo === 'baja' ? null : undefined;

    if (areaId === null) {
      await client.query(
        `UPDATE equipos SET estado=$1, area_id=NULL, actualizado_en=NOW() WHERE id=$2`,
        [nuevoEstado, equipo_id]
      );
    } else {
      await client.query(
        `UPDATE equipos SET estado=$1, actualizado_en=NOW() WHERE id=$2`,
        [nuevoEstado, equipo_id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ ok: true, mensaje: `Movimiento registrado: ${tipo}` });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Error al registrar movimiento' });
  } finally {
    client.release();
  }
});

// GET /api/asignaciones — historial de auditoría
router.get('/', auth, async (req, res) => {
  const { equipo_id, limit = 50 } = req.query;
  let sql = `
    SELECT
      asig.id, asig.tipo, asig.observacion, asig.fecha,
      e.numero_serie, e.modelo,
      f.nombre AS funcionario,
      u.nombre AS registrado_por
    FROM asignaciones asig
    JOIN equipos e ON e.id = asig.equipo_id
    LEFT JOIN funcionarios f ON f.id = asig.funcionario_id
    JOIN usuarios u ON u.id = asig.usuario_id
    WHERE 1=1
  `;
  const params = [];

  if (equipo_id) {
    params.push(equipo_id);
    sql += ` AND asig.equipo_id = $${params.length}`;
  }

  params.push(Number(limit));
  sql += ` ORDER BY asig.fecha DESC LIMIT $${params.length}`;

  try {
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Error al obtener auditoría' });
  }
});

module.exports = router;
