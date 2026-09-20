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
 
// Variables de entorno para Aiven / Render
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'inventario_maquinas';
const DB_PORT = process.env.DB_PORT || 3306;
const PORT = process.env.PORT || 3000;
 
async function inicializarBD() {
  try {
    const esNube = process.env.DB_HOST ? true : false;
 
    db = mysql.createPool({
      host: DB_HOST,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      port: DB_PORT,
      ssl: esNube ? { rejectUnauthorized: false } : false
    });
 
    // Crear Tabla de Usuarios
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
 
    // Crear Tabla de Equipos
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
 
    // Crear Tabla de Mantenimientos
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
 
    // Insertar/Actualizar Usuarios Iniciales
    const hashAdmin = await bcrypt.hash('admin123', 10);
    await db.query(`
      INSERT INTO usuarios (usuario, password_hash, nombre_completo, rol)
      VALUES ('admin', ?, 'Administrador General', 'admin')
      ON DUPLICATE KEY UPDATE password_hash = ?;
    `, [hashAdmin, hashAdmin]);
 
    const hashTecnico = await bcrypt.hash('tecnico123', 10);
    await db.query(`
      INSERT INTO usuarios (usuario, password_hash, nombre_completo, rol)
      VALUES ('tecnico', ?, 'Técnico de Campo', 'tecnico')
      ON DUPLICATE KEY UPDATE password_hash = ?;
    `, [hashTecnico, hashTecnico]);
 
    console.log('--> Base de datos e historial de mantenimientos inicializados correctamente.');
 
  } catch (error) {
    console.error('Error al inicializar la base de datos:', error.message);
  }
}
 
// ENDPOINTS DE LA APLICACIÓN
 
// Login
app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;
  try {
    const [rows] = await db.query('SELECT * FROM usuarios WHERE usuario = ? AND activo = TRUE', [usuario]);
    if (rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado' });
 
    const user = rows[0];
    const passwordValido = await bcrypt.compare(password, user.password_hash);
    if (!passwordValido) return res.status(401).json({ error: 'Contraseña incorrecta' });
 
    const token = jwt.sign({ id: user.id_usuario, rol: user.rol, nombre: user.nombre_completo }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, rol: user.rol, nombre: user.nombre_completo });
  } catch (error) {
    res.status(500).json({ error: 'Error interno en el servidor' });
  }
});
 
// Obtener Equipos
app.get('/api/equipos', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM equipos ORDER BY id_equipo DESC');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener equipos' });
  }
});
 
// Registrar Equipo
app.post('/api/equipos', async (req, res) => {
  const { codigo_interno, numero_serie, marca, modelo, ubicacion_cliente, contador_actual } = req.body;
  try {
    await db.query(
      'INSERT INTO equipos (codigo_interno, numero_serie, marca, modelo, ubicacion_cliente, contador_actual) VALUES (?, ?, ?, ?, ?, ?)',
      [codigo_interno, numero_serie, marca || 'Ricoh', modelo, ubicacion_cliente, contador_actual || 0]
    );
    res.json({ mensaje: 'Equipo registrado con éxito' });
  } catch (error) {
    res.status(500).json({ error: 'Error al registrar el equipo. Verifica que el código o serie no estén duplicados.' });
  }
});
 
// Registrar Mantenimiento
app.post('/api/mantenimientos', async (req, res) => {
  const { id_equipo, tipo_servicio, contador_impresiones, descripcion, repuestos_cambiados, tecnico } = req.body;
  try {
    await db.query(
      'INSERT INTO mantenimientos (id_equipo, tipo_servicio, contador_impresiones, descripcion, repuestos_cambiados, tecnico) VALUES (?, ?, ?, ?, ?, ?)',
      [id_equipo, tipo_servicio, contador_impresiones, descripcion, repuestos_cambiados, tecnico]
    );
    await db.query('UPDATE equipos SET contador_actual = ? WHERE id_equipo = ?', [contador_impresiones, id_equipo]);
    res.json({ mensaje: 'Mantenimiento registrado con éxito' });
  } catch (error) {
    res.status(500).json({ error: 'Error al guardar el servicio técnico' });
  }
});
 
// Obtener Historial de Mantenimientos por Equipo
app.get('/api/mantenimientos/:id_equipo', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM mantenimientos WHERE id_equipo = ? ORDER BY fecha_servicio DESC', [req.params.id_equipo]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al consultar historial' });
  }
});
 
// Iniciar Servidor
app.listen(PORT, async () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
  await inicializarBD();
});
 
