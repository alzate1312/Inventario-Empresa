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
 
    // Tabla de Mantenimientos
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
 
    // Usuarios por defecto
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
 
