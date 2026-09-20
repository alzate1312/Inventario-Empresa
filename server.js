const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
 
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
 
const upload = multer({ dest: 'uploads/' });
const JWT_SECRET = 'clave_secreta_empresa_2026';
let db;
 
async function inicializarBD() {
  try {
    const conexionInicial = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: ''
    });
 
    await conexionInicial.query('CREATE DATABASE IF NOT EXISTS inventario_maquinas;');
    await conexionInicial.end();
 
    db = mysql.createPool({
      host: 'localhost',
      user: 'root',
      password: '',
      database: 'inventario_maquinas'
    });
 
    // Tabla de Usuarios
    await db.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id_usuario INT AUTO_INCREMENT PRIMARY KEY,
        usuario VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        nombre_completo VARCHAR(100) NOT NULL,
        rol ENUM('admin', 'tecnico') NOT NULL,
        activo BOOLEAN DEFAULT TRUE,
        fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
 
    // Tabla de Equipos
    await db.query(`
      CREATE TABLE IF NOT EXISTS equipos (
        id_equipo INT AUTO_INCREMENT PRIMARY KEY,
        codigo_interno VARCHAR(50) UNIQUE NOT NULL,
        numero_serie VARCHAR(100) UNIQUE NOT NULL,
        marca VARCHAR(50) DEFAULT 'Ricoh',
        modelo VARCHAR(50) NOT NULL,
        ubicacion_cliente VARCHAR(150),
        estado ENUM('Activo', 'En Taller', 'Baja') DEFAULT 'Activo',
        contador_actual INT DEFAULT 0,
        fecha_registro DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
 
    // Tabla de Mantenimientos e Historial Técnico
    await db.query(`
      CREATE TABLE IF NOT EXISTS mantenimientos (
        id_mantenimiento INT AUTO_INCREMENT PRIMARY KEY,
        id_equipo INT NOT NULL,
        tipo_servicio ENUM('Preventivo', 'Correctivo', 'Cambio Insumo', 'Diagnóstico') NOT NULL,
        contador_impresiones INT DEFAULT 0,
        descripcion TEXT NOT NULL,
        repuestos_cambiados TEXT,
        tecnico VARCHAR(100) NOT NULL,
        fecha_servicio DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (id_equipo) REFERENCES equipos(id_equipo) ON DELETE CASCADE
      );
    `);
 
    // Crear/Actualizar Administrador por defecto
    const hashAdmin = await bcrypt.hash('admin123', 10);
    await db.query(`
      INSERT INTO usuarios (usuario, password_hash, nombre_completo, rol) 
      VALUES ('admin', ?, 'Administrador General', 'admin')
      ON DUPLICATE KEY UPDATE password_hash = ?;
    `, [hashAdmin, hashAdmin]);
 
    // Crear/Actualizar Técnico por defecto
    const hashTecnico = await bcrypt.hash('tecnico123', 10);
    await db.query(`
      INSERT INTO usuarios (usuario, password_hash, nombre_completo, rol) 
      VALUES ('tecnico', ?, 'Técnico de Campo', 'tecnico')
      ON DUPLICATE KEY UPDATE password_hash = ?;
    `, [hashTecnico, hashTecnico]);
 
    console.log('--> Base de datos e historial de mantenimientos inicializados.');
 
  } catch (error) {
    console.error('Error al inicializar la base de datos:', error.message);
  }
}
 
// LOGIN
app.post('/api/login', async (req, res) => {
  const { usuario, password, rolRequerido } = req.body;
  try {
    const [rows] = await db.query('SELECT * FROM usuarios WHERE usuario = ? AND activo = TRUE', [usuario]);
    if (rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado' });
 
    const user = rows[0];
    if (rolRequerido && user.rol !== rolRequerido) {
      return res.status(403).json({ error: `El usuario no tiene rol de ${rolRequerido}` });
    }
 
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) return res.status(401).json({ error: 'Contraseña incorrecta' });
 
    const token = jwt.sign({ id: user.id_usuario, rol: user.rol }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, rol: user.rol, nombre: user.nombre_completo });
  } catch (err) {
    res.status(500).json({ error: 'Error interno en el servidor' });
  }
});
 
// CONSULTAR TODOS LOS EQUIPOS
app.get('/api/equipos', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM equipos ORDER BY id_equipo DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar equipos' });
  }
});
 
// REGISTRAR UN EQUIPO MANUAL
app.post('/api/equipos', async (req, res) => {
  const { codigo_interno, numero_serie, marca, modelo, ubicacion_cliente } = req.body;
  try {
    await db.query(
      'INSERT INTO equipos (codigo_interno, numero_serie, marca, modelo, ubicacion_cliente) VALUES (?, ?, ?, ?, ?)',
      [codigo_interno, numero_serie, marca, modelo, ubicacion_cliente]
    );
    res.json({ mensaje: 'Equipo registrado correctamente' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(400).json({ error: 'El código interno o número de serie ya existe.' });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});
 
// CARGA MASIVA CSV
app.post('/api/equipos/cargar-masivo', upload.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });
 
  const resultados = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (data) => {
      if (data.Placa_Interna && data.Numero_Serie) {
        resultados.push([
          data.Placa_Interna.trim(),
          data.Numero_Serie.trim(),
          data.Marca ? data.Marca.trim() : 'Ricoh',
          data.Modelo ? data.Modelo.trim() : 'N/A',
          data.Ubicacion ? data.Ubicacion.trim() : 'Sin Ubicación'
        ]);
      }
    })
    .on('end', async () => {
      try {
        if (resultados.length === 0) {
          fs.unlinkSync(req.file.path);
          return res.status(400).json({ error: 'El archivo CSV no tiene el formato correcto.' });
        }
 
        const sql = `
          INSERT INTO equipos (codigo_interno, numero_serie, marca, modelo, ubicacion_cliente)
          VALUES ?
          ON DUPLICATE KEY UPDATE 
            marca = VALUES(marca),
            modelo = VALUES(modelo),
            ubicacion_cliente = VALUES(ubicacion_cliente);
        `;
        await db.query(sql, [resultados]);
        fs.unlinkSync(req.file.path);
        res.json({ mensaje: `Procesados ${resultados.length} registros sin duplicación.` });
      } catch (err) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: err.message });
      }
    });
});
 
// CONSULTAR HISTORIAL DE MANTENIMIENTOS DE UN EQUIPO
app.get('/api/mantenimientos/:id_equipo', async (req, res) => {
  const { id_equipo } = req.params;
  try {
    const [rows] = await db.query(
      'SELECT * FROM mantenimientos WHERE id_equipo = ? ORDER BY fecha_servicio DESC',
      [id_equipo]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener historial' });
  }
});
 
// REGISTRAR UN MANTENIMIENTO Y ACTUALIZAR CONTADOR DEL EQUIPO
app.post('/api/mantenimientos', async (req, res) => {
  const { id_equipo, tipo_servicio, contador_impresiones, descripcion, repuestos_cambiados, tecnico } = req.body;
  try {
    // 1. Insertar el mantenimiento
    await db.query(
      'INSERT INTO mantenimientos (id_equipo, tipo_servicio, contador_impresiones, descripcion, repuestos_cambiados, tecnico) VALUES (?, ?, ?, ?, ?, ?)',
      [id_equipo, tipo_servicio, contador_impresiones || 0, descripcion, repuestos_cambiados || 'Ninguno', tecnico || 'Técnico']
    );
 
    // 2. Actualizar el contador actual en la tabla de equipos
    if (contador_impresiones) {
      await db.query(
        'UPDATE equipos SET contador_actual = ? WHERE id_equipo = ? AND contador_actual < ?',
        [contador_impresiones, id_equipo, contador_impresiones]
      );
    }
 
    res.json({ mensaje: 'Mantenimiento e historial registrados correctamente.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.listen(3000, async () => {
  await inicializarBD();
  console.log('====================================================');
  console.log('Servidor corriendo en: http://localhost:3000');
  console.log('====================================================');
});
 