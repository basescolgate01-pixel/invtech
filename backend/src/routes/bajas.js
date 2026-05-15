const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Crear carpeta de uploads si no existe
const uploadDir = path.join(__dirname, '../../uploads/bajas');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ts = Date.now();
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext).replace(/[^a-z0-9]/gi, '_').toLowerCase();
    cb(null, `${ts}_${name}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const permitidos = [
      'image/jpeg','image/png','image/gif','image/webp',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'message/rfc822', // .eml
      'text/plain'
    ];
    if (permitidos.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
  }
});

// POST /api/bajas — dar de baja con evidencia
router.post('/', auth, upload.single('archivo'), async (req, res) => {
  try {
    const { equipo_id, tipo_baja, nombre_receptor, fecha_regalo, descripcion } = req.body;

    if (!equipo_id) return res.status(400).json({ error: 'equipo_id requerido' });
    if (!tipo_baja) return res.status(400).json({ error: 'tipo_baja requerido' });

    const tiposValidos = ['regalo','desecho','robo','obsoleto','otro'];
    if (!tiposValidos.includes(tipo_baja)) return res.status(400).json({ error: 'Tipo de baja inválido' });

    // Verificar equipo existe
    const eq = await pool.query('SELECT id, estado FROM equipos WHERE id=$1', [equipo_id]);
    if (!eq.rows.length) return res.status(404).json({ error: 'Equipo no encontrado' });

    // Validaciones por tipo
    if (tipo_baja === 'regalo') {
      if (!nombre_receptor) return res.status(400).json({ error: 'Nombre del receptor es obligatorio' });
      if (!fecha_regalo) return res.status(400).json({ error: 'Fecha de entrega es obligatoria' });
    }
    if (['desecho','robo'].includes(tipo_baja) && !req.file) {
      return res.status(400).json({ error: `El archivo es obligatorio para ${tipo_baja}` });
    }

    // Guardar evidencia en DB
    const archivoNombre = req.file ? req.file.originalname : null;
    const archivoRuta = req.file ? req.file.filename : null;
    const archivoTipo = req.file ? req.file.mimetype : null;
    const archivoTamano = req.file ? req.file.size : null;

    const evResult = await pool.query(
      `INSERT INTO evidencias_baja
        (equipo_id, usuario_id, tipo_baja, nombre_receptor, fecha_regalo,
         descripcion, archivo_nombre, archivo_ruta, archivo_tipo, archivo_tamano)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [equipo_id, req.usuario.id, tipo_baja, nombre_receptor||null, fecha_regalo||null,
       descripcion||null, archivoNombre, archivoRuta, archivoTipo, archivoTamano]
    );

    const evidenciaId = evResult.rows[0].id;

    // Dar de baja el equipo
    await pool.query('UPDATE equipos SET estado=$1, updated_at=NOW() WHERE id=$2', ['baja', equipo_id]);

    // Registrar en auditoría
    const obsMap = {
      regalo: `Regalo a: ${nombre_receptor}`,
      desecho: `Desecho/Reciclaje${descripcion?' - '+descripcion:''}`,
      robo: `Robo/Pérdida${descripcion?' - '+descripcion:''}`,
      obsoleto: `Obsoleto${descripcion?' - '+descripcion:''}`,
      otro: descripcion || 'Baja'
    };
    await pool.query(
      `INSERT INTO asignaciones (equipo_id, usuario_id, tipo, observacion)
       VALUES ($1,$2,$3,$4)`,
      [equipo_id, req.usuario.id, 'baja', obsMap[tipo_baja]]
    );

    res.json({ ok: true, evidencia_id: evidenciaId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Error al procesar baja' });
  }
});

// GET /api/bajas/:equipo_id — obtener evidencias de un equipo
router.get('/:equipo_id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.id, e.tipo_baja, e.nombre_receptor,
              TO_CHAR(e.fecha_regalo, 'DD/MM/YYYY') as fecha_regalo,
              e.descripcion, e.archivo_nombre, e.archivo_tipo, e.archivo_tamano,
              TO_CHAR(e.fecha, 'DD/MM/YYYY HH24:MI') as fecha,
              u.nombre as usuario
       FROM evidencias_baja e
       JOIN usuarios u ON e.usuario_id = u.id
       WHERE e.equipo_id = $1
       ORDER BY e.fecha DESC`,
      [req.params.equipo_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener evidencias' });
  }
});

// GET /api/bajas/archivo/:id — descargar archivo de evidencia
router.get('/archivo/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT archivo_ruta, archivo_nombre, archivo_tipo FROM evidencias_baja WHERE id=$1',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Evidencia no encontrada' });

    const ev = result.rows[0];
    if (!ev.archivo_ruta) return res.status(404).json({ error: 'Sin archivo adjunto' });

    const filePath = path.join(uploadDir, ev.archivo_ruta);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado en servidor' });

    res.setHeader('Content-Disposition', `inline; filename="${ev.archivo_nombre}"`);
    res.setHeader('Content-Type', ev.archivo_tipo || 'application/octet-stream');
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: 'Error al descargar archivo' });
  }
});

// GET /api/bajas — listado de todas las bajas (para reporte)
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.id, e.tipo_baja, e.nombre_receptor,
              TO_CHAR(e.fecha_regalo, 'DD/MM/YYYY') as fecha_regalo,
              e.descripcion, e.archivo_nombre,
              TO_CHAR(e.fecha, 'DD/MM/YYYY HH24:MI') as fecha,
              u.nombre as usuario,
              eq.imei1, eq.modelo, eq.marca
       FROM evidencias_baja e
       JOIN usuarios u ON e.usuario_id = u.id
       JOIN equipos eq ON e.equipo_id = eq.id
       ORDER BY e.fecha DESC
       LIMIT 500`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener bajas' });
  }
});

module.exports = router;
