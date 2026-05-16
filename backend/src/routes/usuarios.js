const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const bcrypt = require('bcryptjs');

// Middleware solo admin
function soloAdmin(req, res, next) {
  if (req.usuario.rol !== 'admin')
    return res.status(403).json({ error: 'Solo administradores pueden realizar esta acción' });
  next();
}

// GET /api/usuarios
router.get('/', auth, soloAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.nombre, u.email, u.rol, u.activo, u.area_id, u.created_at,
             a.nombre as area_nombre
      FROM usuarios u
      LEFT JOIN areas a ON u.area_id = a.id
      ORDER BY u.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

// POST /api/usuarios - crear usuario
router.post('/', auth, soloAdmin, async (req, res) => {
  try {
    const { nombre, email, password, rol, area_id } = req.body;
    if (!nombre || !email || !password || !rol)
      return res.status(400).json({ error: 'Todos los campos son requeridos' });

    const rolesValidos = ['admin', 'auditor', 'supervisor'];
    if (!rolesValidos.includes(rol))
      return res.status(400).json({ error: 'Rol inválido' });

    if (rol === 'supervisor' && !area_id)
      return res.status(400).json({ error: 'El supervisor debe tener un área asignada' });

    const existe = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (existe.rows.length > 0)
      return res.status(400).json({ error: 'Ya existe un usuario con ese email' });

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(`
      INSERT INTO usuarios (nombre, email, password, rol, area_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, nombre, email, rol, activo, area_id, created_at
    `, [nombre, email, hash, rol, area_id || null]);

    res.json({ ok: true, usuario: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear usuario' });
  }
});

// PUT /api/usuarios/:id - editar usuario
router.put('/:id', auth, soloAdmin, async (req, res) => {
  try {
    const { nombre, email, rol, activo, area_id } = req.body;

    if (rol) {
      const rolesValidos = ['admin', 'auditor', 'supervisor'];
      if (!rolesValidos.includes(rol))
        return res.status(400).json({ error: 'Rol inválido' });
    }

    const result = await pool.query(`
      UPDATE usuarios SET
        nombre   = COALESCE($1, nombre),
        email    = COALESCE($2, email),
        rol      = COALESCE($3, rol),
        activo   = COALESCE($4, activo),
        area_id  = $5
      WHERE id = $6
      RETURNING id, nombre, email, rol, activo, area_id
    `, [nombre, email, rol, activo, area_id || null, req.params.id]);

    if (!result.rows.length)
      return res.status(404).json({ error: 'Usuario no encontrado' });

    res.json({ ok: true, usuario: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar usuario' });
  }
});

// PUT /api/usuarios/:id/password
router.put('/:id/password', auth, soloAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6)
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE usuarios SET password = $1 WHERE id = $2', [hash, req.params.id]);
    res.json({ ok: true, mensaje: 'Contraseña actualizada' });
  } catch (err) {
    res.status(500).json({ error: 'Error al cambiar contraseña' });
  }
});

// DELETE /api/usuarios/:id - desactivar
router.delete('/:id', auth, soloAdmin, async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.usuario.id)
      return res.status(400).json({ error: 'No puedes desactivar tu propio usuario' });
    await pool.query('UPDATE usuarios SET activo = false WHERE id = $1', [req.params.id]);
    res.json({ ok: true, mensaje: 'Usuario desactivado' });
  } catch (err) {
    res.status(500).json({ error: 'Error al desactivar usuario' });
  }
});

module.exports = router;
