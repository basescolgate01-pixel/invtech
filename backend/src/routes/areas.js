const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');

// Middleware solo admin
function soloAdmin(req, res, next) {
  if (req.usuario.rol !== 'admin')
    return res.status(403).json({ error: 'Solo administradores' });
  next();
}

// GET /api/areas - listar todas
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, nombre, descripcion, created_at
      FROM areas
      ORDER BY nombre ASC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener áreas' });
  }
});

// POST /api/areas - crear área
router.post('/', auth, soloAdmin, async (req, res) => {
  try {
    const { nombre, descripcion } = req.body;
    
    if (!nombre || !nombre.trim())
      return res.status(400).json({ error: 'El nombre es obligatorio' });

    // Verificar duplicado
    const existe = await pool.query('SELECT id FROM areas WHERE nombre ILIKE $1', [nombre]);
    if (existe.rows.length > 0)
      return res.status(400).json({ error: 'Ya existe un área con ese nombre' });

    const result = await pool.query(`
      INSERT INTO areas (nombre, descripcion)
      VALUES ($1, $2)
      RETURNING id, nombre, descripcion, created_at
    `, [nombre.trim(), descripcion?.trim() || null]);

    res.json({ ok: true, area: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear área' });
  }
});

// PUT /api/areas/:id - editar área
router.put('/:id', auth, soloAdmin, async (req, res) => {
  try {
    const { nombre, descripcion } = req.body;
    
    if (!nombre || !nombre.trim())
      return res.status(400).json({ error: 'El nombre es obligatorio' });

    const result = await pool.query(`
      UPDATE areas SET
        nombre = $1,
        descripcion = $2
      WHERE id = $3
      RETURNING id, nombre, descripcion
    `, [nombre.trim(), descripcion?.trim() || null, req.params.id]);

    if (!result.rows.length)
      return res.status(404).json({ error: 'Área no encontrada' });

    res.json({ ok: true, area: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar área' });
  }
});

// DELETE /api/areas/:id - eliminar área
router.delete('/:id', auth, soloAdmin, async (req, res) => {
  try {
    // Desvincular usuarios y equipos de esta área
    await pool.query('UPDATE usuarios SET area_id = NULL WHERE area_id = $1', [req.params.id]);
    await pool.query('UPDATE equipos SET area_id = NULL WHERE area_id = $1', [req.params.id]);
    await pool.query('UPDATE funcionarios SET area_id = NULL WHERE area_id = $1', [req.params.id]);

    const result = await pool.query('DELETE FROM areas WHERE id = $1 RETURNING nombre', [req.params.id]);
    
    if (!result.rows.length)
      return res.status(404).json({ error: 'Área no encontrada' });

    res.json({ ok: true, mensaje: `Área "${result.rows[0].nombre}" eliminada` });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar área' });
  }
});

module.exports = router;
