-- Limpiar tablas existentes
DROP TABLE IF EXISTS asignaciones CASCADE;
DROP TABLE IF EXISTS equipos CASCADE;
DROP TABLE IF EXISTS funcionarios CASCADE;
DROP TABLE IF EXISTS areas CASCADE;
DROP TABLE IF EXISTS usuarios CASCADE;

-- Tabla usuarios
CREATE TABLE usuarios (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  rol VARCHAR(20) DEFAULT 'operador' CHECK (rol IN ('admin', 'operador', 'auditor')),
  activo BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tabla areas
CREATE TABLE areas (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL UNIQUE,
  descripcion TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tabla equipos (identificador principal: imei1)
CREATE TABLE equipos (
  id SERIAL PRIMARY KEY,
  imei1 VARCHAR(20) UNIQUE NOT NULL,
  imei2 VARCHAR(20),
  numero_serie VARCHAR(100),
  modelo VARCHAR(100) NOT NULL,
  marca VARCHAR(100),
  estado VARCHAR(20) DEFAULT 'disponible' CHECK (estado IN ('disponible', 'asignado', 'mantencion', 'baja')),
  area_id INTEGER REFERENCES areas(id),
  notas TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Tabla funcionarios
CREATE TABLE funcionarios (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  rut VARCHAR(20),
  cargo VARCHAR(100),
  area_id INTEGER REFERENCES areas(id),
  email VARCHAR(100),
  activo BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tabla asignaciones (auditoría completa)
CREATE TABLE asignaciones (
  id SERIAL PRIMARY KEY,
  equipo_id INTEGER REFERENCES equipos(id),
  funcionario_id INTEGER REFERENCES funcionarios(id),
  usuario_id INTEGER REFERENCES usuarios(id),
  tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('ingreso', 'asignacion', 'devolucion', 'mantencion', 'baja')),
  observacion TEXT,
  fecha TIMESTAMP DEFAULT NOW()
);

-- Áreas por defecto
INSERT INTO areas (nombre) VALUES
  ('TI'),
  ('Ventas'),
  ('RRHH'),
  ('Operaciones'),
  ('Finanzas');

-- Usuario admin por defecto
INSERT INTO usuarios (nombre, email, password, rol) VALUES
  ('Administrador', 'admin@empresa.cl', '$2b$10$rOmIBWkbPEBGJjvDsGl1ZOJe5L5L5L5L5L5L5L5L5L5L5L5L5L5L2', 'admin'),
  ('Operador', 'operador@empresa.cl', '$2b$10$rOmIBWkbPEBGJjvDsGl1ZOJe5L5L5L5L5L5L5L5L5L5L5L5L5L5L2', 'operador');

-- Índices para búsquedas rápidas
CREATE INDEX idx_equipos_imei1 ON equipos(imei1);
CREATE INDEX idx_equipos_imei2 ON equipos(imei2);
CREATE INDEX idx_equipos_serie ON equipos(numero_serie);
CREATE INDEX idx_equipos_estado ON equipos(estado);
CREATE INDEX idx_asignaciones_equipo ON asignaciones(equipo_id);
CREATE INDEX idx_asignaciones_fecha ON asignaciones(fecha DESC);
