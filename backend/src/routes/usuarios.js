const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const auth = require('../middleware/auth');

// Middleware: solo admins
const soloAdmin = (req, res, next) => {
  if (req.user.rol !== 'admin')
    return res.status(403).json({ error: 'Solo administradores' });
  next();
};

// GET /api/usuarios
router.get('/', auth, soloAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nombre, email, rol, activo, creado_en FROM usuarios ORDER BY creado_en DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

// POST /api/usuarios — crear usuario
router.post('/', auth, soloAdmin, async (req, res) => {
  const { nombre, email, password, rol } = req.body;
  if (!nombre || !email || !password || !rol)
    return res.status(400).json({ error: 'Todos los campos son requeridos' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO usuarios (nombre, email, password, rol)
       VALUES ($1,$2,$3,$4)
       RETURNING id, nombre, email, rol, activo, creado_en`,
      [nombre, email, hash, rol]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email ya existe' });
    res.status(500).json({ error: 'Error al crear usuario' });
  }
});

// PUT /api/usuarios/:id — editar usuario
router.put('/:id', auth, soloAdmin, async (req, res) => {
  const { nombre, email, rol, activo } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE usuarios SET nombre=$1, email=$2, rol=$3, activo=$4
       WHERE id=$5
       RETURNING id, nombre, email, rol, activo, creado_en`,
      [nombre, email, rol, activo, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email ya existe' });
    res.status(500).json({ error: 'Error al actualizar usuario' });
  }
});

// PUT /api/usuarios/:id/password — cambiar contraseña
router.put('/:id/password', auth, async (req, res) => {
  const { password_actual, password_nuevo } = req.body;
  // Admin puede cambiar cualquiera, usuario solo la suya
  if (req.user.rol !== 'admin' && req.user.id !== parseInt(req.params.id))
    return res.status(403).json({ error: 'Sin permiso' });

  try {
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Si no es admin, verificar contraseña actual
    if (req.user.rol !== 'admin') {
      const ok = await bcrypt.compare(password_actual, rows[0].password);
      if (!ok) return res.status(401).json({ error: 'Contraseña actual incorrecta' });
    }

    const hash = await bcrypt.hash(password_nuevo, 10);
    await pool.query('UPDATE usuarios SET password=$1 WHERE id=$2', [hash, req.params.id]);
    res.json({ ok: true, mensaje: 'Contraseña actualizada' });
  } catch (e) {
    res.status(500).json({ error: 'Error al cambiar contraseña' });
  }
});

// DELETE /api/usuarios/:id — desactivar usuario
router.delete('/:id', auth, soloAdmin, async (req, res) => {
  if (req.user.id === parseInt(req.params.id))
    return res.status(400).json({ error: 'No puedes desactivarte a ti mismo' });
  try {
    await pool.query('UPDATE usuarios SET activo=false WHERE id=$1', [req.params.id]);
    res.json({ ok: true, mensaje: 'Usuario desactivado' });
  } catch (e) {
    res.status(500).json({ error: 'Error al desactivar usuario' });
  }
});

module.exports = router;
