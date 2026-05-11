const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const multer = require('multer');
const xlsx = require('xlsx');

const upload = multer({ storage: multer.memoryStorage() });

// GET /api/asignaciones
router.get('/', auth, async (req, res) => {
  try {
    const { q, tipo, desde, hasta, limit = 200 } = req.query;
    let query = `
      SELECT a.id, a.tipo, a.observacion, a.fecha,
        e.imei1, e.imei2, e.numero_serie, e.modelo, e.marca,
        ar.nombre as area, f.nombre as funcionario, u.nombre as registrado_por
      FROM asignaciones a
      JOIN equipos e ON a.equipo_id = e.id
      LEFT JOIN areas ar ON e.area_id = ar.id
      LEFT JOIN funcionarios f ON a.funcionario_id = f.id
      LEFT JOIN usuarios u ON a.usuario_id = u.id
      WHERE 1=1
    `;
    const params = [];
    if (q) { params.push(`%${q}%`); query += ` AND (e.imei1 ILIKE $${params.length} OR e.imei2 ILIKE $${params.length} OR e.numero_serie ILIKE $${params.length} OR e.modelo ILIKE $${params.length})`; }
    if (tipo) { params.push(tipo); query += ` AND a.tipo = $${params.length}`; }
    if (desde) { params.push(desde); query += ` AND a.fecha >= $${params.length}`; }
    if (hasta) { params.push(hasta + ' 23:59:59'); query += ` AND a.fecha <= $${params.length}`; }
    params.push(limit);
    query += ` ORDER BY a.fecha DESC LIMIT $${params.length}`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener movimientos' });
  }
});

// POST /api/asignaciones - movimiento individual
router.post('/', auth, async (req, res) => {
  try {
    const { equipo_id, funcionario_id, tipo, observacion } = req.body;
    if (!equipo_id || !tipo) return res.status(400).json({ error: 'Equipo y tipo son requeridos' });

    const estadoMap = { asignacion:'asignado', devolucion:'disponible', mantencion:'mantencion', baja:'baja' };
    if (estadoMap[tipo]) {
      const ubicacionUpdate = tipo === 'devolucion' ? ", ubicacion = COALESCE(ubicacion, 'Bodega principal')" : '';
      await pool.query(`UPDATE equipos SET estado=$1${ubicacionUpdate}, updated_at=NOW() WHERE id=$2`, [estadoMap[tipo], equipo_id]);
    }
    await pool.query(
      `INSERT INTO asignaciones (equipo_id, funcionario_id, usuario_id, tipo, observacion) VALUES ($1,$2,$3,$4,$5)`,
      [equipo_id, funcionario_id||null, req.usuario.id, tipo, observacion||null]
    );
    res.json({ ok: true, mensaje: 'Movimiento registrado correctamente' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar movimiento' });
  }
});

// POST /api/asignaciones/masivo - movimientos masivos desde Excel
router.post('/masivo', auth, upload.single('archivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const filas = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    if (!filas.length) return res.status(400).json({ error: 'Archivo vacío' });

    const estadoMap = { asignacion:'asignado', devolucion:'disponible', mantencion:'mantencion', baja:'baja' };
    const resultados = { exitosos: 0, errores: [], total: filas.length };

    for (const fila of filas) {
      const imei = String(fila['imei1'] || fila['IMEI1'] || fila['imei'] || fila['IMEI'] || '').trim();
      const rut = String(fila['rut'] || fila['RUT'] || fila['Rut'] || '').trim();
      const tipo = String(fila['tipo'] || fila['TIPO'] || fila['movimiento'] || 'asignacion').trim().toLowerCase();
      const observacion = String(fila['observacion'] || fila['OBSERVACION'] || fila['obs'] || '').trim();

      if (!imei) { resultados.errores.push(`Fila sin IMEI`); continue; }
      if (!['asignacion','devolucion','mantencion','baja','ingreso'].includes(tipo)) {
        resultados.errores.push(`IMEI ${imei}: tipo inválido "${tipo}"`); continue;
      }

      try {
        // Buscar equipo por IMEI
        const eqResult = await pool.query(
          'SELECT id FROM equipos WHERE imei1=$1 OR imei2=$1 OR numero_serie=$1 LIMIT 1', [imei]
        );
        if (!eqResult.rows.length) { resultados.errores.push(`IMEI ${imei}: equipo no encontrado`); continue; }
        const equipoId = eqResult.rows[0].id;

        // Buscar funcionario por RUT (solo si es asignación)
        let funcionarioId = null;
        if (rut && tipo === 'asignacion') {
          const fResult = await pool.query(
            'SELECT id FROM funcionarios WHERE rut ILIKE $1 AND activo=true LIMIT 1', [rut]
          );
          if (!fResult.rows.length) { resultados.errores.push(`IMEI ${imei}: RUT ${rut} no encontrado`); continue; }
          funcionarioId = fResult.rows[0].id;
        }

        // Actualizar estado del equipo
        if (estadoMap[tipo]) {
          await pool.query('UPDATE equipos SET estado=$1, updated_at=NOW() WHERE id=$2', [estadoMap[tipo], equipoId]);
        }

        // Registrar movimiento
        await pool.query(
          `INSERT INTO asignaciones (equipo_id, funcionario_id, usuario_id, tipo, observacion) VALUES ($1,$2,$3,$4,$5)`,
          [equipoId, funcionarioId, req.usuario.id, tipo, observacion||'Movimiento masivo']
        );

        resultados.exitosos++;
      } catch (e) {
        resultados.errores.push(`IMEI ${imei}: ${e.message}`);
      }
    }

    res.json({ ok: true, resultados });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al procesar archivo' });
  }
});

// GET /api/asignaciones/plantilla-masivo - plantilla Excel para movimientos masivos
router.get('/plantilla-masivo', auth, (req, res) => {
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet([
    ['imei1', 'rut', 'tipo', 'observacion'],
    ['350000000000001', '12.345.678-9', 'asignacion', 'Entrega masiva mayo 2026'],
    ['350000000000002', '9.876.543-2', 'asignacion', ''],
    ['350000000000003', '', 'devolucion', 'Fin de contrato'],
    ['350000000000004', '', 'mantencion', 'Pantalla rota'],
    ['350000000000005', '', 'baja', 'Equipo obsoleto'],
  ]);
  // Ancho de columnas
  ws['!cols'] = [{wch:20},{wch:16},{wch:14},{wch:30}];
  xlsx.utils.book_append_sheet(wb, ws, 'Movimientos');

  // Hoja de instrucciones
  const wsInfo = xlsx.utils.aoa_to_sheet([
    ['INSTRUCCIONES'],
    [''],
    ['Columnas requeridas:'],
    ['imei1', 'IMEI del equipo (obligatorio)'],
    ['rut', 'RUT del funcionario (solo para asignación)'],
    ['tipo', 'Tipo de movimiento (obligatorio)'],
    ['observacion', 'Notas adicionales (opcional)'],
    [''],
    ['Tipos válidos:'],
    ['asignacion', 'Asigna el equipo a un funcionario (requiere RUT)'],
    ['devolucion', 'Devuelve el equipo al inventario'],
    ['mantencion', 'Envía el equipo a mantención'],
    ['baja', 'Da de baja el equipo'],
  ]);
  xlsx.utils.book_append_sheet(wb, wsInfo, 'Instrucciones');

  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=plantilla_movimientos_masivos.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

// GET /api/asignaciones/export/excel
router.get('/export/excel', auth, async (req, res) => {
  try {
    const { q, tipo, desde, hasta } = req.query;
    let query = `
      SELECT TO_CHAR(a.fecha, 'DD/MM/YYYY HH24:MI') as fecha, a.tipo,
        e.imei1, e.imei2, e.numero_serie, e.modelo, e.marca,
        ar.nombre as area, f.nombre as funcionario, u.nombre as registrado_por, a.observacion
      FROM asignaciones a
      JOIN equipos e ON a.equipo_id = e.id
      LEFT JOIN areas ar ON e.area_id = ar.id
      LEFT JOIN funcionarios f ON a.funcionario_id = f.id
      LEFT JOIN usuarios u ON a.usuario_id = u.id
      WHERE 1=1
    `;
    const params = [];
    if (q) { params.push(`%${q}%`); query += ` AND (e.imei1 ILIKE $${params.length} OR e.modelo ILIKE $${params.length})`; }
    if (tipo) { params.push(tipo); query += ` AND a.tipo = $${params.length}`; }
    if (desde) { params.push(desde); query += ` AND a.fecha >= $${params.length}`; }
    if (hasta) { params.push(hasta + ' 23:59:59'); query += ` AND a.fecha <= $${params.length}`; }
    query += ' ORDER BY a.fecha DESC LIMIT 5000';

    const result = await pool.query(query, params);
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(result.rows, {
      header: ['fecha','tipo','imei1','imei2','numero_serie','modelo','marca','area','funcionario','registrado_por','observacion']
    });
    xlsx.utils.book_append_sheet(wb, ws, 'Auditoría');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=auditoria.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Error al exportar' });
  }
});

module.exports = router;
