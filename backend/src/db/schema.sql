-- InvTech · Esquema de base de datos
-- PostgreSQL

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Usuarios del sistema
CREATE TABLE usuarios (
  id          SERIAL PRIMARY KEY,
  nombre      VARCHAR(100) NOT NULL,
  email       VARCHAR(150) UNIQUE NOT NULL,
  password    VARCHAR(255) NOT NULL,
  rol         VARCHAR(20) NOT NULL DEFAULT 'operador' CHECK (rol IN ('admin','operador','auditor')),
  activo      BOOLEAN DEFAULT TRUE,
  creado_en   TIMESTAMPTZ DEFAULT NOW()
);

-- Áreas de la empresa
CREATE TABLE areas (
  id        SERIAL PRIMARY KEY,
  nombre    VARCHAR(100) UNIQUE NOT NULL
);

INSERT INTO areas (nombre) VALUES
  ('TI'),('Ventas'),('RRHH'),('Operaciones'),('Finanzas');

-- Equipos electrónicos
CREATE TABLE equipos (
  id              SERIAL PRIMARY KEY,
  numero_serie    VARCHAR(50) UNIQUE NOT NULL,
  modelo          VARCHAR(100) NOT NULL,
  marca           VARCHAR(80),
  imei            VARCHAR(20),
  estado          VARCHAR(20) NOT NULL DEFAULT 'disponible'
                    CHECK (estado IN ('disponible','asignado','mantencion','baja')),
  area_id         INTEGER REFERENCES areas(id),
  notas           TEXT,
  creado_en       TIMESTAMPTZ DEFAULT NOW(),
  actualizado_en  TIMESTAMPTZ DEFAULT NOW()
);

-- Funcionarios (personas que reciben equipos)
CREATE TABLE funcionarios (
  id        SERIAL PRIMARY KEY,
  nombre    VARCHAR(100) NOT NULL,
  rut       VARCHAR(15) UNIQUE,
  area_id   INTEGER REFERENCES areas(id),
  activo    BOOLEAN DEFAULT TRUE
);

-- Asignaciones (el corazón del sistema)
CREATE TABLE asignaciones (
  id              SERIAL PRIMARY KEY,
  equipo_id       INTEGER NOT NULL REFERENCES equipos(id),
  funcionario_id  INTEGER REFERENCES funcionarios(id),
  usuario_id      INTEGER NOT NULL REFERENCES usuarios(id),
  tipo            VARCHAR(20) NOT NULL
                    CHECK (tipo IN ('asignacion','devolucion','mantencion','baja')),
  observacion     TEXT,
  fecha           TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para búsquedas rápidas
CREATE INDEX idx_equipos_serie   ON equipos(numero_serie);
CREATE INDEX idx_equipos_estado  ON equipos(estado);
CREATE INDEX idx_asig_equipo     ON asignaciones(equipo_id);
CREATE INDEX idx_asig_fecha      ON asignaciones(fecha DESC);

-- Vista: estado actual de cada equipo con su asignación vigente
CREATE VIEW vista_equipos AS
SELECT
  e.id, e.numero_serie, e.modelo, e.marca, e.imei, e.estado,
  a.nombre AS area,
  f.nombre AS asignado_a,
  f.rut,
  MAX(asig.fecha) AS ultimo_movimiento
FROM equipos e
LEFT JOIN areas a ON a.id = e.area_id
LEFT JOIN asignaciones asig ON asig.equipo_id = e.id
LEFT JOIN funcionarios f ON f.id = asig.funcionario_id
  AND asig.id = (
    SELECT id FROM asignaciones
    WHERE equipo_id = e.id
    ORDER BY fecha DESC LIMIT 1
  )
GROUP BY e.id, e.numero_serie, e.modelo, e.marca, e.imei,
         e.estado, a.nombre, f.nombre, f.rut;

-- Datos de ejemplo
INSERT INTO usuarios (nombre, email, password, rol) VALUES
  ('Admin','admin@empresa.cl', crypt('admin123', gen_salt('bf')), 'admin'),
  ('Operador','operador@empresa.cl', crypt('oper123', gen_salt('bf')), 'operador');

INSERT INTO funcionarios (nombre, rut, area_id) VALUES
  ('Ana López','12.345.678-9',1),
  ('Pedro Ruiz','11.222.333-4',2),
  ('Luis Vera','10.111.222-3',3),
  ('María Soto','9.876.543-2',2),
  ('Jorge Pino','8.765.432-1',4);

INSERT INTO equipos (numero_serie, modelo, marca, imei, estado, area_id) VALUES
  ('SN-0421','iPhone 14 Pro','Apple','350000000000001','asignado',1),
  ('SN-0389','Samsung S23 Ultra','Samsung','350000000000002','disponible',NULL),
  ('SN-0312','iPhone 13','Apple','350000000000003','asignado',3),
  ('SN-0445','Xiaomi 12','Xiaomi','350000000000004','asignado',2),
  ('SN-0201','Motorola G82','Motorola','350000000000005','mantencion',NULL),
  ('SN-0188','Samsung A54','Samsung','350000000000006','asignado',4),
  ('SN-0160','Huawei P50','Huawei','350000000000007','disponible',NULL),
  ('SN-0133','Samsung S22','Samsung','350000000000008','disponible',NULL);
