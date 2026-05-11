const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const multer = require('multer');
const xlsx = require('xlsx');

const upload = multer({ storage: multer.memoryStorage() });

// GET /api/equipos - listar con búsqueda por imei1, imei2 o serie
router.get('/', auth, async (req, res) => {
  try {
    const { q, estado } = req.query;
    let query = `
      SELECT e.*, a.nombre as area
      FROM equipos e
      LEFT JOIN areas a ON e.area_id = a.id
      WHERE 1=1
    `;
    const params = [];

    if (q) {
      params.push(`%${q}%`);
      query += ` AND (e.imei1 ILIKE $${params.length} OR e.imei2 ILIKE $${params.length} OR e.numero_serie ILIKE $${params.length} OR e.modelo ILIKE $${params.length} OR e.marca ILIKE $${params.length})`;
    }

    if (estado) {
      params.push(estado);
      query += ` AND e.estado = $${params.length}`;
    }

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
    const kpis = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE estado = 'asignado') as asignados,
        COUNT(*) FILTER (WHERE estado = 'disponible') as disponibles,
        COUNT(*) FILTER (WHERE estado = 'mantencion') as mantencion
      FROM equipos
    `);

    const porArea = await pool.query(`
      SELECT a.nombre as area, COUNT(e.id) as cantidad
      FROM areas a
      LEFT JOIN equipos e ON e.area_id = a.id
      GROUP BY a.nombre
      ORDER BY cantidad DESC
    `);

    res.json({
      kpis: kpis.rows[0],
      por_area: porArea.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// GET /api/equipos/buscar - buscar por imei1, imei2 o serie (para scanner)
router.get('/buscar', auth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Parámetro requerido' });

    const result = await pool.query(`
      SELECT e.*, a.nombre as area,
        f.nombre as asignado_a,
        (SELECT tipo FROM asignaciones WHERE equipo_id = e.id ORDER BY fecha DESC LIMIT 1) as ultimo_movimiento
      FROM equipos e
      LEFT JOIN areas a ON e.area_id = a.id
      LEFT JOIN asignaciones asig ON asig.equipo_id = e.id AND asig.tipo = 'asignacion'
        AND asig.id = (SELECT MAX(id) FROM asignaciones WHERE equipo_id = e.id AND tipo = 'asignacion')
      LEFT JOIN funcionarios f ON asig.funcionario_id = f.id
      WHERE e.imei1 = $1 OR e.imei2 = $1 OR e.numero_serie = $1
      LIMIT 1
    `, [q]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Equipo no encontrado' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al buscar equipo' });
  }
});

// GET /api/equipos/ficha/:imei1 - ficha pública por imei1
router.get('/ficha/:imei1', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.*, a.nombre as area,
        f.nombre as funcionario_nombre,
        f.rut as funcionario_rut,
        asig.fecha as fecha_asignacion,
        asig.observacion,
        u.nombre as registrado_por
      FROM equipos e
      LEFT JOIN areas a ON e.area_id = a.id
      LEFT JOIN asignaciones asig ON asig.equipo_id = e.id
        AND asig.id = (SELECT MAX(id) FROM asignaciones WHERE equipo_id = e.id AND tipo = 'asignacion')
      LEFT JOIN funcionarios f ON asig.funcionario_id = f.id
      LEFT JOIN usuarios u ON asig.usuario_id = u.id
      WHERE e.imei1 = $1
    `, [req.params.imei1]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Equipo no encontrado' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener ficha' });
  }
});

// POST /api/equipos - crear equipo individual
router.post('/', auth, async (req, res) => {
  try {
    const { imei1, imei2, numero_serie, modelo, marca, notas, area_id } = req.body;

    if (!imei1 || !modelo) {
      return res.status(400).json({ error: 'IMEI 1 y modelo son requeridos' });
    }

    // Verificar que imei1 no exista
    const exists = await pool.query('SELECT id FROM equipos WHERE imei1 = $1', [imei1]);
    if (exists.rows.length > 0) {
      return res.status(400).json({ error: 'Ya existe un equipo con ese IMEI 1' });
    }

    const result = await pool.query(`
      INSERT INTO equipos (imei1, imei2, numero_serie, modelo, marca, notas, area_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [imei1, imei2 || null, numero_serie || null, modelo, marca || null, notas || null, area_id || null]);

    const equipo = result.rows[0];

    // Registrar ingreso en auditoría automáticamente
    await pool.query(`
      INSERT INTO asignaciones (equipo_id, usuario_id, tipo, observacion)
      VALUES ($1, $2, 'ingreso', $3)
    `, [equipo.id, req.usuario.id, notas || 'Ingreso inicial al sistema']);

    res.json({ ok: true, equipo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear equipo' });
  }
});

// POST /api/equipos/importar - importar desde Excel
router.post('/importar', auth, upload.single('archivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const filas = xlsx.utils.sheet_to_json(sheet);

    if (filas.length === 0) {
      return res.status(400).json({ error: 'El archivo está vacío' });
    }

    const resultados = { exitosos: 0, errores: [], total: filas.length };

    for (const fila of filas) {
      const imei1 = String(fila['imei1'] || fila['IMEI1'] || fila['IMEI 1'] || '').trim();
      const imei2 = String(fila['imei2'] || fila['IMEI2'] || fila['IMEI 2'] || '').trim();
      const numero_serie = String(fila['numero_serie'] || fila['SERIE'] || fila['Serie'] || '').trim();
      const modelo = String(fila['modelo'] || fila['MODELO'] || fila['Modelo'] || '').trim();
      const marca = String(fila['marca'] || fila['MARCA'] || fila['Marca'] || '').trim();
      const notas = String(fila['notas'] || fila['NOTAS'] || fila['Notas'] || '').trim();

      if (!imei1 || !modelo) {
        resultados.errores.push(`Fila sin IMEI1 o modelo: ${JSON.stringify(fila)}`);
        continue;
      }

      try {
        const exists = await pool.query('SELECT id FROM equipos WHERE imei1 = $1', [imei1]);
        if (exists.rows.length > 0) {
          resultados.errores.push(`IMEI1 ${imei1} ya existe`);
          continue;
        }

        const result = await pool.query(`
          INSERT INTO equipos (imei1, imei2, numero_serie, modelo, marca, notas)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id
        `, [imei1, imei2 || null, numero_serie || null, modelo, marca || null, notas || null]);

        await pool.query(`
          INSERT INTO asignaciones (equipo_id, usuario_id, tipo, observacion)
          VALUES ($1, $2, 'ingreso', 'Importación masiva')
        `, [result.rows[0].id, req.usuario.id]);

        resultados.exitosos++;
      } catch (e) {
        resultados.errores.push(`Error en IMEI1 ${imei1}: ${e.message}`);
      }
    }

    res.json({ ok: true, resultados });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al importar archivo' });
  }
});

// POST /api/equipos/masivo - ingreso masivo manual (lista de IMEIs)
router.post('/masivo', auth, async (req, res) => {
  try {
    const { equipos } = req.body;

    if (!equipos || !Array.isArray(equipos) || equipos.length === 0) {
      return res.status(400).json({ error: 'Lista de equipos requerida' });
    }

    const resultados = { exitosos: 0, errores: [], total: equipos.length };

    for (const eq of equipos) {
      const { imei1, imei2, numero_serie, modelo, marca, notas, area_id } = eq;

      if (!imei1 || !modelo) {
        resultados.errores.push(`Equipo sin IMEI1 o modelo`);
        continue;
      }

      try {
        const exists = await pool.query('SELECT id FROM equipos WHERE imei1 = $1', [imei1]);
        if (exists.rows.length > 0) {
          resultados.errores.push(`IMEI1 ${imei1} ya existe`);
          continue;
        }

        const result = await pool.query(`
          INSERT INTO equipos (imei1, imei2, numero_serie, modelo, marca, notas, area_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id
        `, [imei1, imei2 || null, numero_serie || null, modelo, marca || null, notas || null, area_id || null]);

        await pool.query(`
          INSERT INTO asignaciones (equipo_id, usuario_id, tipo, observacion)
          VALUES ($1, $2, 'ingreso', $3)
        `, [result.rows[0].id, req.usuario.id, notas || 'Ingreso masivo']);

        resultados.exitosos++;
      } catch (e) {
        resultados.errores.push(`Error en IMEI1 ${imei1}: ${e.message}`);
      }
    }

    res.json({ ok: true, resultados });
  } catch (err) {
    res.status(500).json({ error: 'Error en ingreso masivo' });
  }
});

// GET /api/equipos/plantilla - descargar plantilla Excel
router.get('/plantilla', auth, (req, res) => {
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet([
    ['imei1', 'imei2', 'numero_serie', 'modelo', 'marca', 'notas'],
    ['351234567890123', '351234567890124', 'SN-001', 'Samsung Galaxy S23', 'Samsung', 'Equipo nuevo'],
    ['351234567890125', '', 'SN-002', 'iPhone 14 Pro', 'Apple', ''],
  ]);
  xlsx.utils.book_append_sheet(wb, ws, 'Equipos');
  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=plantilla_equipos.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

// PUT /api/equipos/:id - actualizar equipo
router.put('/:id', auth, async (req, res) => {
  try {
    const { imei1, imei2, numero_serie, modelo, marca, notas, area_id, estado } = req.body;

    const result = await pool.query(`
      UPDATE equipos SET
        imei1 = COALESCE($1, imei1),
        imei2 = $2,
        numero_serie = $3,
        modelo = COALESCE($4, modelo),
        marca = $5,
        notas = $6,
        area_id = $7,
        estado = COALESCE($8, estado),
        updated_at = NOW()
      WHERE id = $9
      RETURNING *
    `, [imei1, imei2 || null, numero_serie || null, modelo, marca || null, notas || null, area_id || null, estado, req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Equipo no encontrado' });
    }

    res.json({ ok: true, equipo: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar equipo' });
  }
});

module.exports = router;
