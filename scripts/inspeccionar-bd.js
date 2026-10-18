
const mysql = require('mysql2/promise');

async function inspeccionarBaseDeDatos() {
  const requeridas = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
  const faltantes = requeridas.filter((nombre) => !process.env[nombre]);

  if (faltantes.length > 0) {
    console.error(
      `Faltan variables de entorno requeridas: ${faltantes.join(', ')}`
    );
    process.exitCode = 1;
    return;
  }

  let conexion;

  try {
    conexion = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: Number(process.env.DB_PORT || 26963),
      ssl: {
        rejectUnauthorized: false
      },
      connectTimeout: 15000
    });

    console.log('Conexión con MySQL establecida.');

    const [tablas] = await conexion.execute(
      `SELECT TABLE_NAME
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
         AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
      [process.env.DB_NAME]
    );

    if (tablas.length === 0) {
      console.log('No se encontraron tablas en la base de datos.');
      return;
    }

    console.log('\nTABLAS EXISTENTES:');

    for (const tabla of tablas) {
      console.log(`\n--- ${tabla.TABLE_NAME} ---`);

      const [columnas] = await conexion.execute(
        `SELECT
           COLUMN_NAME,
           COLUMN_TYPE,
           IS_NULLABLE,
           COLUMN_KEY,
           COLUMN_DEFAULT,
           EXTRA
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ?
           AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [process.env.DB_NAME, tabla.TABLE_NAME]
      );

      for (const columna of columnas) {
        console.log(
          [
            columna.COLUMN_NAME,
            columna.COLUMN_TYPE,
            `NULL: ${columna.IS_NULLABLE}`,
            `KEY: ${columna.COLUMN_KEY || '-'}`,
            `DEFAULT: ${
              columna.COLUMN_DEFAULT === null
                ? 'NULL/sin valor predeterminado'
                : columna.COLUMN_DEFAULT
            }`,
            columna.EXTRA || ''
          ].join(' | ')
        );
      }
    }

    console.log('\nInspección terminada. No se modificó ninguna tabla.');
  } catch (error) {
    console.error('No fue posible inspeccionar la base de datos.');
    console.error('Código de error:', error.code || 'No disponible');
    console.error('Revisa la conexión y las variables de entorno.');
    process.exitCode = 1;
  } finally {
    if (conexion) {
      await conexion.end();
    }
  }
}

inspeccionarBaseDeDatos();
