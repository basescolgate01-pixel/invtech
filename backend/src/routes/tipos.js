const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');

function soloAdmin(req, res, next) {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  next();
}

// GET /api/tipos
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tipos_equipo WHERE activo = true ORDER BY nombre');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener tipos' });
  }
});

// POST /api/tipos
router.post('/', auth, soloAdmin, async (req, res) => {
  try {
    const { nombre, icono, descripcion } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    const result = await pool.query(
      'INSERT INTO tipos_equipo (nombre, icono, descripcion) VALUES ($1, $2, $3) RETURNING *',
      [nombre, icono || '📱', descripcion || null]
    );
    res.json({ ok: true, tipo: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ya existe un tipo con ese nombre' });
    res.status(500).json({ error: 'Error al crear tipo' });
  }
});

// PUT /api/tipos/:id
router.put('/:id', auth, soloAdmin, async (req, res) => {
  try {
    const { nombre, icono, descripcion } = req.body;
    const result = await pool.query(
      'UPDATE tipos_equipo SET nombre=$1, icono=$2, descripcion=$3 WHERE id=$4 RETURNING *',
      [nombre, icono || '📱', descripcion || null, req.params.id]
    );
    res.json({ ok: true, tipo: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar tipo' });
  }
});

// DELETE /api/tipos/:id
router.delete('/:id', auth, soloAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE tipos_equipo SET activo = false WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar tipo' });
  }
});

module.exports = router;
