const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');

function soloAdmin(req, res, next) {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  next();
}

// GET /api/areas
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM areas ORDER BY nombre');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener áreas' });
  }
});

// POST /api/areas
router.post('/', auth, soloAdmin, async (req, res) => {
  try {
    const { nombre, descripcion } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    const result = await pool.query(
      'INSERT INTO areas (nombre, descripcion) VALUES ($1, $2) RETURNING *',
      [nombre.trim(), descripcion?.trim() || null]
    );
    res.json({ ok: true, area: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ya existe un área con ese nombre' });
    res.status(500).json({ error: 'Error al crear área' });
  }
});

// PUT /api/areas/:id
router.put('/:id', auth, soloAdmin, async (req, res) => {
  try {
    const { nombre, descripcion } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    const result = await pool.query(
      'UPDATE areas SET nombre=$1, descripcion=$2 WHERE id=$3 RETURNING *',
      [nombre.trim(), descripcion?.trim() || null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Área no encontrada' });
    res.json({ ok: true, area: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ya existe un área con ese nombre' });
    res.status(500).json({ error: 'Error al actualizar área' });
  }
});

// DELETE /api/areas/:id
router.delete('/:id', auth, soloAdmin, async (req, res) => {
  try {
    // Desasignar el área de equipos y funcionarios antes de eliminar
    await pool.query('UPDATE equipos SET area_id = NULL WHERE area_id = $1', [req.params.id]);
    await pool.query('UPDATE funcionarios SET area_id = NULL WHERE area_id = $1', [req.params.id]);
    await pool.query('DELETE FROM areas WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar área' });
  }
});

module.exports = router;
