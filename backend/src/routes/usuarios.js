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

// GET /api/usuarios/plantilla - descargar plantilla Excel
router.get('/plantilla', auth, soloAdmin, (req, res) => {
  const xlsx = require('xlsx');
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet([
    ['nombre', 'email', 'password', 'rol', 'area'],
    ['Juan Pérez', 'juan@empresa.cl', 'password123', 'supervisor', 'TI'],
    ['María González', 'maria@empresa.cl', 'password456', 'auditor', ''],
    ['Pedro Silva', 'pedro@empresa.cl', 'password789', 'admin', ''],
  ]);
  ws['!cols'] = [{wch:20},{wch:25},{wch:15},{wch:12},{wch:15}];

  const wsInfo = xlsx.utils.aoa_to_sheet([
    ['INSTRUCCIONES'],
    [''],
    ['Columnas requeridas:'],
    ['nombre', 'Nombre completo del usuario (obligatorio)'],
    ['email', 'Email único (obligatorio)'],
    ['password', 'Contraseña mínimo 6 caracteres (obligatorio)'],
    ['rol', 'admin, auditor o supervisor (obligatorio)'],
    ['area', 'Nombre del área (obligatorio solo para supervisor)'],
    [''],
    ['Roles disponibles:'],
    ['admin', 'Administrador - acceso total'],
    ['auditor', 'Auditor - puede registrar movimientos y dar de baja con evidencia'],
    ['supervisor', 'Supervisor - solo visualiza equipos de su área (requiere área)'],
  ]);

  xlsx.utils.book_append_sheet(wb, ws, 'Usuarios');
  xlsx.utils.book_append_sheet(wb, wsInfo, 'Instrucciones');

  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=plantilla_usuarios.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

// POST /api/usuarios/importar - carga masiva desde Excel
router.post('/importar', auth, soloAdmin, async (req, res) => {
  const multer = require('multer');
  const upload = multer({ storage: multer.memoryStorage() });
  
  upload.single('archivo')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'Error al subir archivo' });
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });

    try {
      const xlsx = require('xlsx');
      const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
      const filas = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
      
      if (!filas.length) return res.status(400).json({ error: 'Archivo vacío' });

      const rolesValidos = ['admin', 'auditor', 'supervisor'];
      const resultados = { exitosos: 0, errores: [], total: filas.length };

      for (const fila of filas) {
        const nombre = String(fila['nombre'] || fila['NOMBRE'] || '').trim();
        const email = String(fila['email'] || fila['EMAIL'] || '').trim().toLowerCase();
        const password = String(fila['password'] || fila['PASSWORD'] || fila['contraseña'] || '').trim();
        const rol = String(fila['rol'] || fila['ROL'] || '').trim().toLowerCase();
        const areaNombre = String(fila['area'] || fila['AREA'] || fila['área'] || '').trim();

        // Validaciones
        if (!nombre || !email || !password || !rol) {
          resultados.errores.push(`Fila ${resultados.exitosos + resultados.errores.length + 1}: faltan campos obligatorios`);
          continue;
        }

        if (!rolesValidos.includes(rol)) {
          resultados.errores.push(`Email ${email}: rol inválido "${rol}"`);
          continue;
        }

        if (password.length < 6) {
          resultados.errores.push(`Email ${email}: contraseña debe tener al menos 6 caracteres`);
          continue;
        }

        if (rol === 'supervisor' && !areaNombre) {
          resultados.errores.push(`Email ${email}: supervisor requiere área asignada`);
          continue;
        }

        try {
          // Verificar email duplicado
          const existe = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
          if (existe.rows.length > 0) {
            resultados.errores.push(`Email ${email}: ya existe`);
            continue;
          }

          // Buscar área por nombre
          let area_id = null;
          if (areaNombre) {
            const areaResult = await pool.query(
              'SELECT id FROM areas WHERE nombre ILIKE $1 LIMIT 1',
              [areaNombre]
            );
            if (!areaResult.rows.length) {
              resultados.errores.push(`Email ${email}: área "${areaNombre}" no encontrada`);
              continue;
            }
            area_id = areaResult.rows[0].id;
          }

          // Crear usuario
          const hash = await bcrypt.hash(password, 10);
          await pool.query(
            `INSERT INTO usuarios (nombre, email, password, rol, area_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [nombre, email, hash, rol, area_id]
          );

          resultados.exitosos++;
        } catch (e) {
          resultados.errores.push(`Email ${email}: ${e.message}`);
        }
      }

      res.json({ ok: true, resultados });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Error al procesar archivo' });
    }
  });
});
