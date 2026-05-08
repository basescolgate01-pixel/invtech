const router = require('express').Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');

// GET /api/funcionarios
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT f.*, a.nombre AS area
      FROM funcionarios f
      LEFT JOIN areas a ON a.id = f.area_id
      WHERE f.activo = true
      ORDER BY f.nombre
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Error al obtener funcionarios' });
  }
});

// POST /api/funcionarios
router.post('/', auth, async (req, res) => {
  const { nombre, rut, area_id } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO funcionarios (nombre, rut, area_id) VALUES ($1,$2,$3) RETURNING *',
      [nombre, rut || null, area_id || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'RUT ya existe' });
    res.status(500).json({ error: 'Error al crear funcionario' });
  }
});

module.exports = router;
