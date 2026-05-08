const { Pool } = require('pg');

const connString = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_fxWyHAPghq09@ep-ancient-dream-aptolm3k-pooler.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

console.log('DATABASE_URL desde env:', process.env.DATABASE_URL ? 'EXISTE' : 'NO EXISTE');
console.log('Conectando a:', connString.substring(0, 40) + '...');

const pool = new Pool({
  connectionString: connString,
  ssl: { rejectUnauthorized: false }
});

module.exports = pool;