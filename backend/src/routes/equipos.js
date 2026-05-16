const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const multer = require('multer');
const xlsx = require('xlsx');

const upload = multer({ storage: multer.memoryStorage() });

// ── Middlewares de rol ──
function soloAdmin(req, res, next) {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  next();
}
function adminOAuditor(req, res, next) {
  if (!['admin','auditor'].includes(req.usuario.rol))
    return res.status(403).json({ error: 'Sin permisos para esta acción' });
  next();
}

// GET /api/equipos
router.get('/', auth, async (req, res) => {
  try {
    const { q, estado } = req.query;
    const rol = req.usuario.rol;
    const area_id = req.usuario.area_id;

    let query = `
      SELECT e.*, a.nombre as area, t.nombre as tipo, t.icono as tipo_icono,
        f.nombre as asignado_a
      FROM equipos e
      LEFT JOIN areas a ON e.area_id = a.id
      LEFT JOIN tipos_equipo t ON e.tipo_id = t.id
      LEFT JOIN asignaciones asig ON asig.equipo_id = e.id
        AND asig.tipo = 'asignacion'
        AND asig.id = (SELECT MAX(id) FROM asignaciones WHERE equipo_id = e.id AND tipo = 'asignacion')
      LEFT JOIN funcionarios f ON asig.funcionario_id = f.id
      WHERE 1=1
    `;
    const params = [];

    // Supervisor solo ve equipos de su área
    if (rol === 'supervisor' && area_id) {
      params.push(area_id);
      query += ` AND e.area_id = $${params.length}`;
    }

    if (q) {
      params.push(`%${q}%`);
      query += ` AND (e.imei1 ILIKE $${params.length} OR e.imei2 ILIKE $${params.length} OR e.numero_serie ILIKE $${params.length} OR e.modelo ILIKE $${params.length} OR e.marca ILIKE $${params.length})`;
    }
    if (estado) { params.push(estado); query += ` AND e.estado = $${params.length}`; }

    query += ' ORDER BY e.created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener equipos' });
  }
});

// GET /api/equipos/stats/resumen
router.get('/stats/resumen', auth, async (req, res) => {
  try {
    const rol = req.usuario.rol;
    const area_id = req.usuario.area_id;

    // Supervisor: stats solo de su área + sus asignaciones
    if (rol === 'supervisor' && area_id) {
      const kpis = await pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE estado = 'asignado') as asignados,
          COUNT(*) FILTER (WHERE estado = 'disponible') as disponibles,
          COUNT(*) FILTER (WHERE estado = 'mantencion') as mantencion,
          COUNT(*) FILTER (WHERE estado = 'baja') as baja,
          0 as regalados,
          0 as bajas_reales
        FROM equipos WHERE area_id = $1
      `, [area_id]);

      const porTipo = await pool.query(`
        SELECT COALESCE(t.icono,'📱') as icono, COALESCE(t.nombre,'Sin tipo') as tipo, COUNT(e.id) as cantidad
        FROM equipos e LEFT JOIN tipos_equipo t ON e.tipo_id = t.id
        WHERE e.area_id = $1
        GROUP BY t.nombre, t.icono ORDER BY cantidad DESC
      `, [area_id]);

      // Equipos asignados con detalle de funcionario
      const asignados = await pool.query(`
        SELECT e.imei1, e.modelo, e.marca, f.nombre as funcionario, f.rut,
               TO_CHAR(asig.fecha,'DD/MM/YYYY') as fecha_asignacion
        FROM equipos e
        JOIN asignaciones asig ON asig.equipo_id = e.id
          AND asig.tipo = 'asignacion'
          AND asig.id = (SELECT MAX(id) FROM asignaciones WHERE equipo_id = e.id AND tipo = 'asignacion')
        JOIN funcionarios f ON asig.funcionario_id = f.id
        WHERE e.area_id = $1 AND e.estado = 'asignado'
        ORDER BY asig.fecha DESC
      `, [area_id]);

      return res.json({
        kpis: kpis.rows[0],
        por_area: [],
        por_tipo: porTipo.rows,
        asignados_detalle: asignados.rows
      });
    }

    // Admin / Auditor: stats globales
    const kpis = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE estado = 'asignado') as asignados,
        COUNT(*) FILTER (WHERE estado = 'disponible') as disponibles,
        COUNT(*) FILTER (WHERE estado = 'mantencion') as mantencion,
        COUNT(*) FILTER (WHERE estado = 'baja') as baja,
        (SELECT COUNT(*) FROM evidencias_baja WHERE tipo_baja = 'regalo') as regalados,
        (SELECT COUNT(*) FROM evidencias_baja WHERE tipo_baja IN ('desecho','robo','obsoleto','otro')) as bajas_reales
      FROM equipos
    `);
    const porArea = await pool.query(`
      SELECT COALESCE(a.nombre, 'Sin área') as area, COUNT(e.id) as cantidad
      FROM equipos e LEFT JOIN areas a ON e.area_id = a.id
      GROUP BY a.nombre ORDER BY cantidad DESC
    `);
    const porTipo = await pool.query(`
      SELECT COALESCE(t.icono,'📱') as icono, COALESCE(t.nombre,'Sin tipo') as tipo, COUNT(e.id) as cantidad
      FROM equipos e LEFT JOIN tipos_equipo t ON e.tipo_id = t.id
      GROUP BY t.nombre, t.icono ORDER BY cantidad DESC
    `);
    res.json({ kpis: kpis.rows[0], por_area: porArea.rows, por_tipo: porTipo.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// GET /api/equipos/buscar
router.get('/buscar', auth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Parámetro requerido' });
    const result = await pool.query(`
      SELECT e.*, a.nombre as area, t.nombre as tipo, t.icono as tipo_icono, f.nombre as asignado_a
      FROM equipos e
      LEFT JOIN areas a ON e.area_id = a.id
      LEFT JOIN tipos_equipo t ON e.tipo_id = t.id
      LEFT JOIN asignaciones asig ON asig.equipo_id = e.id
        AND asig.tipo = 'asignacion'
        AND asig.id = (SELECT MAX(id) FROM asignaciones WHERE equipo_id = e.id AND tipo = 'asignacion')
      LEFT JOIN funcionarios f ON asig.funcionario_id = f.id
      WHERE e.imei1 = $1 OR e.imei2 = $1 OR e.numero_serie = $1 LIMIT 1
    `, [q]);
    if (!result.rows.length) return res.status(404).json({ error: 'Equipo no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al buscar equipo' });
  }
});

// GET /api/equipos/plantilla
router.get('/plantilla', auth, adminOAuditor, (req, res) => {
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet([
    ['imei1','imei2','numero_serie','modelo','marca','tipo','notas'],
    ['351234567890123','351234567890124','SN-001','Samsung Galaxy S23','Samsung','Celular','Equipo nuevo'],
  ]);
  xlsx.utils.book_append_sheet(wb, ws, 'Equipos');
  const buffer = xlsx.write(wb, { type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Disposition','attachment; filename=plantilla_equipos.xlsx');
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

// GET /api/equipos/ficha/:imei1
router.get('/ficha/:imei1', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.*, a.nombre as area, t.nombre as tipo,
        f.nombre as funcionario_nombre, f.rut as funcionario_rut,
        asig.fecha as fecha_asignacion, asig.observacion, u.nombre as registrado_por
      FROM equipos e
      LEFT JOIN areas a ON e.area_id = a.id
      LEFT JOIN tipos_equipo t ON e.tipo_id = t.id
      LEFT JOIN asignaciones asig ON asig.equipo_id = e.id
        AND asig.id = (SELECT MAX(id) FROM asignaciones WHERE equipo_id = e.id AND tipo = 'asignacion')
      LEFT JOIN funcionarios f ON asig.funcionario_id = f.id
      LEFT JOIN usuarios u ON asig.usuario_id = u.id
      WHERE e.imei1 = $1
    `, [req.params.imei1]);
    if (!result.rows.length) return res.status(404).json({ error: 'Equipo no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener ficha' });
  }
});

// GET /api/equipos/historial/:id
router.get('/historial/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.id, a.tipo, a.observacion,
             TO_CHAR(a.fecha,'DD/MM/YYYY HH24:MI') as fecha,
             f.nombre as funcionario, f.rut,
             u.nombre as registrado_por
      FROM asignaciones a
      LEFT JOIN funcionarios f ON a.funcionario_id = f.id
      LEFT JOIN usuarios u ON a.usuario_id = u.id
      WHERE a.equipo_id = $1
      ORDER BY a.fecha DESC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener historial' });
  }
});

// POST /api/equipos - solo admin y auditor
router.post('/', auth, adminOAuditor, async (req, res) => {
  try {
    const { imei1, imei2, numero_serie, modelo, marca, notas, area_id, tipo_id, ubicacion } = req.body;
    if (!imei1 || !modelo) return res.status(400).json({ error: 'IMEI 1 y modelo son requeridos' });
    const exists = await pool.query('SELECT id FROM equipos WHERE imei1 = $1', [imei1]);
    if (exists.rows.length > 0) return res.status(400).json({ error: 'Ya existe un equipo con ese IMEI 1' });
    const result = await pool.query(`
      INSERT INTO equipos (imei1, imei2, numero_serie, modelo, marca, notas, area_id, tipo_id, ubicacion)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [imei1, imei2||null, numero_serie||null, modelo, marca||null, notas||null, area_id||null, tipo_id||null, ubicacion||null]);
    const equipo = result.rows[0];
    await pool.query(`INSERT INTO asignaciones (equipo_id, usuario_id, tipo, observacion) VALUES ($1,$2,'ingreso',$3)`,
      [equipo.id, req.usuario.id, notas || 'Ingreso inicial al sistema']);
    res.json({ ok: true, equipo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear equipo' });
  }
});

// POST /api/equipos/importar - solo admin y auditor
router.post('/importar', auth, adminOAuditor, upload.single('archivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const filas = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    if (!filas.length) return res.status(400).json({ error: 'Archivo vacío' });
    const resultados = { exitosos: 0, errores: [], total: filas.length };
    for (const fila of filas) {
      const imei1 = String(fila['imei1'] || fila['IMEI1'] || '').trim();
      const modelo = String(fila['modelo'] || fila['MODELO'] || '').trim();
      if (!imei1 || !modelo) { resultados.errores.push('Fila sin IMEI1 o modelo'); continue; }
      try {
        const exists = await pool.query('SELECT id FROM equipos WHERE imei1 = $1', [imei1]);
        if (exists.rows.length > 0) { resultados.errores.push(`IMEI1 ${imei1} ya existe`); continue; }
        const tipoNombreImp = String(fila['tipo'] || fila['TIPO'] || '').trim();
        let tipo_id_imp = null;
        if (tipoNombreImp) {
          const tRes = await pool.query('SELECT id FROM tipos_equipo WHERE nombre ILIKE $1 AND activo=true LIMIT 1', [tipoNombreImp]);
          if (tRes.rows.length) tipo_id_imp = tRes.rows[0].id;
        }
        const r = await pool.query(`INSERT INTO equipos (imei1, imei2, numero_serie, modelo, marca, notas, tipo_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [imei1, String(fila['imei2']||'').trim()||null, String(fila['numero_serie']||'').trim()||null, modelo, String(fila['marca']||'').trim()||null, String(fila['notas']||'').trim()||null, tipo_id_imp]);
        await pool.query(`INSERT INTO asignaciones (equipo_id, usuario_id, tipo, observacion) VALUES ($1,$2,'ingreso','Importación masiva')`, [r.rows[0].id, req.usuario.id]);
        resultados.exitosos++;
      } catch (e) { resultados.errores.push(`Error en ${imei1}: ${e.message}`); }
    }
    res.json({ ok: true, resultados });
  } catch (err) {
    res.status(500).json({ error: 'Error al importar' });
  }
});

// PUT /api/equipos/:id - solo admin
router.put('/:id', auth, soloAdmin, async (req, res) => {
  try {
    const { imei1, imei2, numero_serie, modelo, marca, notas, area_id, estado, tipo_id, ubicacion } = req.body;
    const result = await pool.query(`
      UPDATE equipos SET
        imei1 = COALESCE($1, imei1), imei2 = $2, numero_serie = $3,
        modelo = COALESCE($4, modelo), marca = $5, notas = $6,
        area_id = $7, estado = COALESCE($8, estado), tipo_id = $9,
        ubicacion = $10, updated_at = NOW()
      WHERE id = $11 RETURNING *
    `, [imei1, imei2||null, numero_serie||null, modelo, marca||null, notas||null, area_id||null, estado, tipo_id||null, ubicacion||null, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Equipo no encontrado' });
    res.json({ ok: true, equipo: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar equipo' });
  }
});

// DELETE /api/equipos/:id - solo admin
router.delete('/:id', auth, soloAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM asignaciones WHERE equipo_id = $1', [req.params.id]);
    const result = await pool.query('DELETE FROM equipos WHERE id = $1 RETURNING imei1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Equipo no encontrado' });
    res.json({ ok: true, mensaje: `Equipo ${result.rows[0].imei1} eliminado` });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar equipo' });
  }
});

// GET /api/equipos/plantilla-modif
router.get('/plantilla-modif', auth, adminOAuditor, (req, res) => {
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet([
    ['imei1','estado','tipo','ubicacion'],
    ['350000000000001','asignado','Celular','Bodega principal'],
    ['350000000000002','mantencion','Parlante','Oficina 2'],
    ['350000000000003','disponible','','Bodega secundaria'],
  ]);
  ws['!cols'] = [{wch:20},{wch:14},{wch:14},{wch:22}];
  const wsInfo = xlsx.utils.aoa_to_sheet([
    ['INSTRUCCIONES'],[''],
    ['imei1','IMEI del equipo (obligatorio)'],
    ['estado','disponible / asignado / mantencion / baja (dejar vacío para no cambiar)'],
    ['tipo','Nombre del tipo: Celular, Parlante, Audífono (dejar vacío para no cambiar)'],
    ['ubicacion','Ej: Bodega principal, Oficina 3 (dejar vacío para no cambiar)'],
  ]);
  xlsx.utils.book_append_sheet(wb, ws, 'Modificaciones');
  xlsx.utils.book_append_sheet(wb, wsInfo, 'Instrucciones');
  const buffer = xlsx.write(wb, { type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Disposition','attachment; filename=plantilla_modificacion_masiva.xlsx');
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

// POST /api/equipos/modificar-masivo - solo admin
router.post('/modificar-masivo', auth, soloAdmin, upload.single('archivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const filas = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    if (!filas.length) return res.status(400).json({ error: 'Archivo vacío' });
    const estadosValidos = ['disponible','asignado','mantencion','baja'];
    const resultados = { exitosos: 0, errores: [], total: filas.length };
    for (const fila of filas) {
      const imei = String(fila['imei1'] || fila['IMEI1'] || fila['imei'] || '').trim();
      const estado = String(fila['estado'] || fila['ESTADO'] || '').trim().toLowerCase();
      const tipoNombre = String(fila['tipo'] || fila['TIPO'] || '').trim();
      const ubicacion = String(fila['ubicacion'] || fila['UBICACION'] || '').trim();
      if (!imei) { resultados.errores.push('Fila sin IMEI'); continue; }
      if (estado && !estadosValidos.includes(estado)) {
        resultados.errores.push(`IMEI ${imei}: estado inválido "${estado}"`); continue;
      }
      try {
        const eq = await pool.query('SELECT id FROM equipos WHERE imei1=$1 OR imei2=$1 LIMIT 1', [imei]);
        if (!eq.rows.length) { resultados.errores.push(`IMEI ${imei}: no encontrado`); continue; }
        const equipoId = eq.rows[0].id;
        let tipo_id = undefined;
        if (tipoNombre) {
          const t = await pool.query('SELECT id FROM tipos_equipo WHERE nombre ILIKE $1 AND activo=true LIMIT 1', [tipoNombre]);
          if (!t.rows.length) { resultados.errores.push(`IMEI ${imei}: tipo "${tipoNombre}" no encontrado`); continue; }
          tipo_id = t.rows[0].id;
        }
        const sets = []; const params = [];
        if (estado) { params.push(estado); sets.push(`estado=$${params.length}`); }
        if (tipo_id !== undefined) { params.push(tipo_id); sets.push(`tipo_id=$${params.length}`); }
        if (ubicacion) { params.push(ubicacion); sets.push(`ubicacion=$${params.length}`); }
        if (!sets.length) { resultados.errores.push(`IMEI ${imei}: sin datos para actualizar`); continue; }
        sets.push('updated_at=NOW()');
        params.push(equipoId);
        await pool.query(`UPDATE equipos SET ${sets.join(',')} WHERE id=$${params.length}`, params);
        resultados.exitosos++;
      } catch(e) { resultados.errores.push(`IMEI ${imei}: ${e.message}`); }
    }
    res.json({ ok: true, resultados });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Error al procesar modificaciones' });
  }
});

module.exports = router;
