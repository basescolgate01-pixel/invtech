const router = require('express').Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const XLSX = require('xlsx');

// POST /api/asignaciones — registrar movimiento
router.post('/', auth, async (req, res) => {
  const { equipo_id, funcionario_id, tipo, observacion } = req.body;
  if (!equipo_id || !tipo)
    return res.status(400).json({ error: 'equipo_id y tipo son requeridos' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Registrar en auditoría
    await client.query(
      `INSERT INTO asignaciones (equipo_id, funcionario_id, usuario_id, tipo, observacion)
       VALUES ($1,$2,$3,$4,$5)`,
      [equipo_id, funcionario_id || null, req.user.id, tipo, observacion]
    );

    // Actualizar estado del equipo
    const estadoMap = {
      asignacion: 'asignado',
      devolucion: 'disponible',
      mantencion: 'mantencion',
      baja: 'baja'
    };
    const nuevoEstado = estadoMap[tipo];
    const areaId = tipo === 'devolucion' || tipo === 'baja' ? null : undefined;

    if (areaId === null) {
      await client.query(
        `UPDATE equipos SET estado=$1, area_id=NULL, actualizado_en=NOW() WHERE id=$2`,
        [nuevoEstado, equipo_id]
      );
    } else {
      await client.query(
        `UPDATE equipos SET estado=$1, actualizado_en=NOW() WHERE id=$2`,
        [nuevoEstado, equipo_id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ ok: true, mensaje: `Movimiento registrado: ${tipo}` });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Error al registrar movimiento' });
  } finally {
    client.release();
  }
});

// GET /api/asignaciones — historial de auditoría con filtros avanzados
router.get('/', auth, async (req, res) => {
  const { 
    equipo_id, 
    tipo, 
    usuario_id, 
    fecha_desde, 
    fecha_hasta, 
    limit = 200 
  } = req.query;
  
  let sql = `
    SELECT
      asig.id, asig.tipo, asig.observacion, asig.fecha,
      e.numero_serie, e.modelo, e.marca, e.imei,
      a.nombre AS area,
      f.nombre AS funcionario, f.rut,
      u.nombre AS registrado_por, u.email AS registrado_email
    FROM asignaciones asig
    JOIN equipos e ON e.id = asig.equipo_id
    LEFT JOIN areas a ON a.id = e.area_id
    LEFT JOIN funcionarios f ON f.id = asig.funcionario_id
    JOIN usuarios u ON u.id = asig.usuario_id
    WHERE 1=1
  `;
  const params = [];

  if (equipo_id) {
    params.push(equipo_id);
    sql += ` AND asig.equipo_id = $${params.length}`;
  }

  if (tipo) {
    params.push(tipo);
    sql += ` AND asig.tipo = $${params.length}`;
  }

  if (usuario_id) {
    params.push(usuario_id);
    sql += ` AND asig.usuario_id = $${params.length}`;
  }

  if (fecha_desde) {
    params.push(fecha_desde);
    sql += ` AND asig.fecha >= $${params.length}`;
  }

  if (fecha_hasta) {
    params.push(fecha_hasta);
    sql += ` AND asig.fecha <= $${params.length}`;
  }

  params.push(Number(limit));
  sql += ` ORDER BY asig.fecha DESC LIMIT $${params.length}`;

  try {
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al obtener auditoría' });
  }
});

// GET /api/asignaciones/stats — estadísticas de movimientos
router.get('/stats', auth, async (req, res) => {
  try {
    const [porTipo, porUsuario, porMes] = await Promise.all([
      // Por tipo de movimiento
      pool.query(`
        SELECT tipo, COUNT(*) as cantidad
        FROM asignaciones
        GROUP BY tipo
        ORDER BY cantidad DESC
      `),
      // Por usuario que registró
      pool.query(`
        SELECT u.nombre, u.email, COUNT(*) as cantidad
        FROM asignaciones a
        JOIN usuarios u ON u.id = a.usuario_id
        GROUP BY u.nombre, u.email
        ORDER BY cantidad DESC
        LIMIT 10
      `),
      // Por mes (últimos 6 meses)
      pool.query(`
        SELECT 
          TO_CHAR(fecha, 'YYYY-MM') as mes,
          COUNT(*) as cantidad
        FROM asignaciones
        WHERE fecha >= NOW() - INTERVAL '6 months'
        GROUP BY mes
        ORDER BY mes DESC
      `)
    ]);

    res.json({
      por_tipo: porTipo.rows,
      por_usuario: porUsuario.rows,
      por_mes: porMes.rows
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// GET /api/asignaciones/export/excel — exportar a Excel
router.get('/export/excel', auth, async (req, res) => {
  const { tipo, usuario_id, fecha_desde, fecha_hasta } = req.query;
  
  let sql = `
    SELECT
      asig.fecha, asig.tipo, 
      e.numero_serie, e.modelo, e.marca,
      a.nombre AS area,
      f.nombre AS funcionario,
      u.nombre AS registrado_por,
      asig.observacion
    FROM asignaciones asig
    JOIN equipos e ON e.id = asig.equipo_id
    LEFT JOIN areas a ON a.id = e.area_id
    LEFT JOIN funcionarios f ON f.id = asig.funcionario_id
    JOIN usuarios u ON u.id = asig.usuario_id
    WHERE 1=1
  `;
  const params = [];

  if (tipo) {
    params.push(tipo);
    sql += ` AND asig.tipo = $${params.length}`;
  }

  if (usuario_id) {
    params.push(usuario_id);
    sql += ` AND asig.usuario_id = $${params.length}`;
  }

  if (fecha_desde) {
    params.push(fecha_desde);
    sql += ` AND asig.fecha >= $${params.length}`;
  }

  if (fecha_hasta) {
    params.push(fecha_hasta);
    sql += ` AND asig.fecha <= $${params.length}`;
  }

  sql += ' ORDER BY asig.fecha DESC LIMIT 5000';

  try {
    const { rows } = await pool.query(sql, params);
    
    // Formatear datos para Excel
    const data = rows.map(r => ({
      'Fecha': new Date(r.fecha).toLocaleString('es-CL'),
      'Tipo': r.tipo,
      'Serie': r.numero_serie,
      'Modelo': r.modelo,
      'Marca': r.marca || '',
      'Área': r.area || '',
      'Funcionario': r.funcionario || '',
      'Registrado por': r.registrado_por,
      'Observación': r.observacion || ''
    }));

    // Crear workbook
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    
    // Ajustar anchos de columna
    ws['!cols'] = [
      {wch: 18}, // Fecha
      {wch: 12}, // Tipo
      {wch: 12}, // Serie
      {wch: 25}, // Modelo
      {wch: 12}, // Marca
      {wch: 15}, // Área
      {wch: 20}, // Funcionario
      {wch: 20}, // Registrado por
      {wch: 30}  // Observación
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Movimientos');

    // Generar buffer
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=auditoria_invtech_${new Date().toISOString().split('T')[0]}.xlsx`);
    res.send(buffer);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al generar Excel' });
  }
});

module.exports = router;
