const router = require('express').Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');

// GET /api/equipos — listar con filtros opcionales
router.get('/', auth, async (req, res) => {
  const { q, estado } = req.query;
  let sql = `SELECT * FROM vista_equipos WHERE 1=1`;
  const params = [];

  if (q) {
    params.push(`%${q}%`);
    sql += ` AND (numero_serie ILIKE $${params.length}
              OR modelo ILIKE $${params.length}
              OR asignado_a ILIKE $${params.length})`;
  }
  if (estado) {
    params.push(estado);
    sql += ` AND estado = $${params.length}`;
  }
  sql += ` ORDER BY ultimo_movimiento DESC NULLS LAST`;

  try {
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al obtener equipos' });
  }
});

// GET /api/equipos/ficha/:serie — ficha pública para QR (sin auth)
router.get('/ficha/:serie', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.numero_serie, e.modelo, e.marca, e.imei, e.estado, e.notas,
              a.nombre AS area,
              f.nombre AS asignado_a, f.rut,
              asig.fecha AS fecha_asignacion,
              asig.observacion,
              u.nombre AS registrado_por
       FROM equipos e
       LEFT JOIN areas a ON a.id = e.area_id
       LEFT JOIN asignaciones asig ON asig.equipo_id = e.id
         AND asig.id = (SELECT id FROM asignaciones WHERE equipo_id = e.id ORDER BY fecha DESC LIMIT 1)
       LEFT JOIN funcionarios f ON f.id = asig.funcionario_id
       LEFT JOIN usuarios u ON u.id = asig.usuario_id
       WHERE e.numero_serie = $1`,
      [req.params.serie.toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Equipo no encontrado' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/equipos/:serie — buscar por número de serie (para pistola)
router.get('/serie/:serie', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM vista_equipos WHERE numero_serie = $1',
      [req.params.serie.toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Equipo no encontrado' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /api/equipos — crear equipo nuevo
router.post('/', auth, async (req, res) => {
  const { numero_serie, modelo, marca, imei, area_id, notas } = req.body;
  if (!numero_serie || !modelo)
    return res.status(400).json({ error: 'Serie y modelo son requeridos' });

  try {
    const { rows } = await pool.query(
      `INSERT INTO equipos (numero_serie, modelo, marca, imei, area_id, notas)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [numero_serie.toUpperCase(), modelo, marca, imei, area_id || null, notas]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505')
      return res.status(409).json({ error: 'Número de serie ya existe' });
    res.status(500).json({ error: 'Error al crear equipo' });
  }
});

// GET /api/equipos/stats — KPIs para el dashboard
router.get('/stats/resumen', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE estado = 'disponible')  AS disponibles,
        COUNT(*) FILTER (WHERE estado = 'asignado')    AS asignados,
        COUNT(*) FILTER (WHERE estado = 'mantencion')  AS mantencion,
        COUNT(*) FILTER (WHERE estado = 'baja')        AS baja,
        COUNT(*)                                        AS total
      FROM equipos
    `);

    const { rows: porArea } = await pool.query(`
      SELECT a.nombre AS area, COUNT(e.id) AS cantidad
      FROM equipos e
      JOIN areas a ON a.id = e.area_id
      WHERE e.estado = 'asignado'
      GROUP BY a.nombre
      ORDER BY cantidad DESC
    `);

    res.json({ kpis: rows[0], por_area: porArea });
  } catch (e) {
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

module.exports = router;
