const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const multer = require('multer');

// Guardar en memoria (no en disco — Railway no tiene storage persistente)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const permitidos = [
      'image/jpeg','image/png','image/gif','image/webp',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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

    const eq = await pool.query('SELECT id FROM equipos WHERE id=$1', [equipo_id]);
    if (!eq.rows.length) return res.status(404).json({ error: 'Equipo no encontrado' });

    if (tipo_baja === 'regalo') {
      if (!nombre_receptor) return res.status(400).json({ error: 'Nombre del receptor es obligatorio' });
      if (!fecha_regalo) return res.status(400).json({ error: 'Fecha de entrega es obligatoria' });
    }
    if (['desecho','robo'].includes(tipo_baja) && !req.file) {
      return res.status(400).json({ error: `El archivo es obligatorio para ${tipo_baja}` });
    }

    // Guardar archivo como base64 en DB
    const archivoNombre = req.file ? req.file.originalname : null;
    const archivoTipo = req.file ? req.file.mimetype : null;
    const archivoTamano = req.file ? req.file.size : null;
    const archivoData = req.file ? req.file.buffer.toString('base64') : null;

    const evResult = await pool.query(
      `INSERT INTO evidencias_baja
        (equipo_id, usuario_id, tipo_baja, nombre_receptor, fecha_regalo,
         descripcion, archivo_nombre, archivo_tipo, archivo_tamano, archivo_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [equipo_id, req.usuario.id, tipo_baja, nombre_receptor||null, fecha_regalo||null,
       descripcion||null, archivoNombre, archivoTipo, archivoTamano, archivoData]
    );

    await pool.query('UPDATE equipos SET estado=$1, updated_at=NOW() WHERE id=$2', ['baja', equipo_id]);

    const obsMap = {
      regalo: `Regalo a: ${nombre_receptor}`,
      desecho: `Desecho/Reciclaje${descripcion?' - '+descripcion:''}`,
      robo: `Robo/Pérdida${descripcion?' - '+descripcion:''}`,
      obsoleto: `Obsoleto${descripcion?' - '+descripcion:''}`,
      otro: descripcion || 'Baja'
    };
    await pool.query(
      `INSERT INTO asignaciones (equipo_id, usuario_id, tipo, observacion) VALUES ($1,$2,$3,$4)`,
      [equipo_id, req.usuario.id, 'baja', obsMap[tipo_baja]]
    );

    res.json({ ok: true, evidencia_id: evResult.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Error al procesar baja' });
  }
});

// GET /api/bajas/:equipo_id — evidencias de un equipo (sin data binaria)
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

// GET /api/bajas/archivo/:id — descargar archivo desde DB
router.get('/archivo/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT archivo_nombre, archivo_tipo, archivo_data FROM evidencias_baja WHERE id=$1',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Evidencia no encontrada' });
    const ev = result.rows[0];
    if (!ev.archivo_data) return res.status(404).json({ error: 'Sin archivo adjunto' });

    const buffer = Buffer.from(ev.archivo_data, 'base64');
    res.setHeader('Content-Disposition', `attachment; filename="${ev.archivo_nombre}"`);
    res.setHeader('Content-Type', ev.archivo_tipo || 'application/octet-stream');
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Error al descargar archivo' });
  }
});

// GET /api/bajas — listado con filtros
router.get('/', auth, async (req, res) => {
  try {
    const { tipo_baja, desde, hasta } = req.query;
    let query = `
      SELECT e.id, e.tipo_baja, e.nombre_receptor,
             TO_CHAR(e.fecha_regalo, 'DD/MM/YYYY') as fecha_regalo,
             e.descripcion, e.archivo_nombre, e.archivo_tipo, e.archivo_tamano,
             TO_CHAR(e.fecha, 'DD/MM/YYYY HH24:MI') as fecha,
             u.nombre as usuario, eq.imei1, eq.modelo, eq.marca
      FROM evidencias_baja e
      JOIN usuarios u ON e.usuario_id = u.id
      JOIN equipos eq ON e.equipo_id = eq.id
      WHERE 1=1`;
    const params = [];
    if (tipo_baja) { params.push(tipo_baja); query += ` AND e.tipo_baja=$${params.length}`; }
    if (desde) { params.push(desde); query += ` AND e.fecha >= $${params.length}`; }
    if (hasta) { params.push(hasta+' 23:59:59'); query += ` AND e.fecha <= $${params.length}`; }
    query += ' ORDER BY e.fecha DESC LIMIT 500';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener bajas' });
  }
});

// GET /api/bajas/export/excel
router.get('/export/excel', auth, async (req, res) => {
  try {
    const xlsx = require('xlsx');
    const { tipo_baja, desde, hasta } = req.query;
    let query = `
      SELECT TO_CHAR(e.fecha,'DD/MM/YYYY HH24:MI') as fecha,
             eq.imei1, eq.modelo, eq.marca,
             e.tipo_baja, e.nombre_receptor,
             TO_CHAR(e.fecha_regalo,'DD/MM/YYYY') as fecha_regalo,
             e.descripcion, e.archivo_nombre, u.nombre as usuario
      FROM evidencias_baja e
      JOIN usuarios u ON e.usuario_id = u.id
      JOIN equipos eq ON e.equipo_id = eq.id
      WHERE 1=1`;
    const params = [];
    if (tipo_baja) { params.push(tipo_baja); query += ` AND e.tipo_baja=$${params.length}`; }
    if (desde) { params.push(desde); query += ` AND e.fecha >= $${params.length}`; }
    if (hasta) { params.push(hasta+' 23:59:59'); query += ` AND e.fecha <= $${params.length}`; }
    query += ' ORDER BY e.fecha DESC';
    const result = await pool.query(query, params);
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(result.rows);
    ws['!cols'] = [{wch:18},{wch:18},{wch:20},{wch:14},{wch:14},{wch:20},{wch:14},{wch:30},{wch:25},{wch:16}];
    xlsx.utils.book_append_sheet(wb, ws, 'Bajas');
    const buffer = xlsx.write(wb, { type:'buffer', bookType:'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=bajas.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch(err) {
    res.status(500).json({ error: 'Error al exportar' });
  }
});

module.exports = router;
