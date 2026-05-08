# InvTech · Sistema de Inventario de Equipos Telefónicos

Sistema web para gestión, asignación y auditoría de equipos electrónicos.
Multi-usuario, compatible con pistola láser, accesible desde web y celular.

---

## Qué incluye

- Dashboard con KPIs en tiempo real
- Inventario completo con búsqueda y filtros
- Escaneo con pistola láser (o teclado) para asignaciones rápidas
- Log de auditoría completo con exportación CSV
- Autenticación con roles (admin / operador / auditor)
- API REST lista para conectar la app Android

---

## Requisitos previos

- Cuenta en GitHub (gratis): https://github.com
- Cuenta en Railway (gratis): https://railway.app
- Git instalado en tu computador

---

## Paso 1 · Subir el código a GitHub

```bash
# En la carpeta del proyecto
git init
git add .
git commit -m "InvTech primer commit"

# Crear repositorio en github.com y luego:
git remote add origin https://github.com/TU_USUARIO/invtech.git
git push -u origin main
```

---

## Paso 2 · Crear la base de datos en Railway

1. Entra a https://railway.app y haz clic en **New Project**
2. Elige **Deploy PostgreSQL**
3. En el panel de la base de datos, ve a **Variables** y copia el valor de `DATABASE_URL`
4. Ve a la pestaña **Query** y ejecuta todo el contenido de `backend/src/db/schema.sql`
   - Esto crea las tablas, vistas y carga los datos de ejemplo

---

## Paso 3 · Deploy del backend en Railway

1. En tu proyecto Railway, haz clic en **New Service → GitHub Repo**
2. Selecciona el repositorio `invtech`
3. Railway detectará automáticamente el `package.json`
4. Ve a **Variables** del servicio y agrega:

```
DATABASE_URL    = (el valor que copiaste en el Paso 2)
JWT_SECRET      = una_clave_larga_y_segura_al_menos_32_caracteres
NODE_ENV        = production
PORT            = 3000
```

5. Railway hace el deploy automáticamente. En 2 minutos verás la URL pública.

---

## Paso 4 · Acceder al sistema

- Abre la URL que te dio Railway (ej: `invtech-production.up.railway.app`)
- Usuario por defecto: `admin@empresa.cl` / contraseña: `admin123`
- **Cambia la contraseña inmediatamente** desde la base de datos

---

## Usuarios y roles

| Rol      | Puede hacer                                      |
|----------|--------------------------------------------------|
| admin    | Todo: crear equipos, usuarios, ver auditoría     |
| operador | Asignar, devolver, buscar equipos               |
| auditor  | Solo lectura: ver inventario y auditoría        |

Para crear más usuarios, ejecuta en Railway Query:

```sql
INSERT INTO usuarios (nombre, email, password, rol)
VALUES ('Nombre', 'email@empresa.cl', crypt('contraseña', gen_salt('bf')), 'operador');
```

---

## Usar con pistola láser

La pistola láser se comporta como un teclado USB o Bluetooth.
1. Abre la pestaña **Escanear** en el sistema
2. El cursor está listo en el campo de serie
3. Escanea el código de barras del equipo — el sistema lo busca automáticamente
4. Selecciona el tipo de movimiento y el funcionario, y registra

Para imprimir etiquetas con código de barras para tus equipos, usa el número de serie
en formato Code 128 con cualquier generador online (ej: barcode.tec-it.com)

---

## API endpoints (para app Android)

```
POST   /api/auth/login              Login, retorna JWT
GET    /api/equipos                 Listar equipos (filtros: ?q= &estado=)
GET    /api/equipos/serie/:serie    Buscar por serie (pistola)
POST   /api/equipos                 Crear equipo
GET    /api/equipos/stats/resumen   KPIs para dashboard
POST   /api/asignaciones            Registrar movimiento
GET    /api/asignaciones            Historial auditoría
GET    /api/funcionarios            Listar funcionarios
POST   /api/funcionarios            Crear funcionario
```

Todas las rutas (excepto login) requieren header:
```
Authorization: Bearer <token>
```

---

## Estructura del proyecto

```
invtech/
├── backend/
│   ├── src/
│   │   ├── index.js          Servidor Express principal
│   │   ├── db/
│   │   │   ├── pool.js       Conexión PostgreSQL
│   │   │   └── schema.sql    Esquema + datos de ejemplo
│   │   ├── middleware/
│   │   │   └── auth.js       Validación JWT
│   │   └── routes/
│   │       ├── auth.js       Login
│   │       ├── equipos.js    CRUD equipos
│   │       ├── asignaciones.js  Movimientos + auditoría
│   │       └── funcionarios.js  CRUD funcionarios
│   └── package.json
├── frontend/
│   └── public/
│       └── index.html        App web completa (SPA)
├── railway.toml              Config de deploy
└── package.json
```

---

## Próximos pasos opcionales

- App Android nativa en Kotlin + Jetpack Compose (conecta a la misma API)
- Notificaciones por email cuando un equipo lleva más de X días sin devolución
- Panel de reportes con gráficos históricos
- Módulo de mantención con seguimiento de estado
- Integración con directorio de empleados (Active Directory / LDAP)
