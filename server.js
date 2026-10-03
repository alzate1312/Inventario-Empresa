const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jwt-simple');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: 'uploads/' });
const SECRET_KEY = process.env.JWT_SECRET || 'secreto_super_seguro_123';

const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  ssl: { rejectUnauthorized: false }
};

let pool;

async function initDB() {
  try {
    pool = mysql.createPool(dbConfig);

    // 1. Tabla Usuarios
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id_usuario INT AUTO_INCREMENT PRIMARY KEY,
        usuario VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        rol ENUM('admin', 'tecnico', 'supervisor', 'almacen') NOT NULL,
        nombre VARCHAR(100) NOT NULL
      );
    `);

    // Insertar/actualizar usuarios garantizando los 4 roles
    const passAdmin = await bcrypt.hash('admin123', 10);
    const passTecnico = await bcrypt.hash('tecnico123', 10);
    const passSupervisor = await bcrypt.hash('supervisor123', 10);
    const passAlmacen = await bcrypt.hash('almacen123', 10);

    await pool.query(`
      INSERT INTO usuarios (usuario, password, rol, nombre) VALUES
      ('admin', ?, 'admin', 'Administrador Principal'),
      ('tecnico', ?, 'tecnico', 'Técnico de Campo'),
      ('supervisor', ?, 'supervisor', 'Supervisor General'),
      ('almacen', ?, 'almacen', 'Encargado de Almacén')
      ON DUPLICATE KEY UPDATE nombre = VALUES(nombre);
    `, [passAdmin, passTecnico, passSupervisor, passAlmacen]);

    // 2. Tabla Equipos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS equipos (
        id_equipo INT AUTO_INCREMENT PRIMARY KEY,
        codigo_interno VARCHAR(50) UNIQUE NOT NULL,
        numero_serie VARCHAR(50) UNIQUE NOT NULL,
        marca VARCHAR(50) NOT NULL,
        modelo VARCHAR(50) NOT NULL,
        ubicacion_cliente VARCHAR(100),
        contador_actual INT DEFAULT 0,
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. Tabla Mantenimientos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mantenimientos (
        id_mantenimiento INT AUTO_INCREMENT PRIMARY KEY,
        id_equipo INT NOT NULL,
        tipo_servicio VARCHAR(50) NOT NULL,
        contador_impresiones INT NOT NULL,
        descripcion TEXT NOT NULL,
        repuestos_cambiados TEXT,
        tecnico VARCHAR(100) NOT NULL,
        fecha_servicio TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (id_equipo) REFERENCES equipos(id_equipo) ON DELETE CASCADE
      );
    `);

    // 4. Tabla Repuestos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS repuestos (
        id_repuesto INT AUTO_INCREMENT PRIMARY KEY,
        codigo_interno VARCHAR(50) UNIQUE NOT NULL,
        descripcion TEXT NOT NULL,
        estado_repuesto ENUM('Nuevo', 'Usado') DEFAULT 'Nuevo',
        uso_destino ENUM('Venta', 'Alquiler', 'Ambos') DEFAULT 'Ambos',
        stock_actual INT DEFAULT 0,
        stock_minimo INT DEFAULT 2,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 5. Tabla Movimientos de Almacén
    await pool.query(`
      CREATE TABLE IF NOT EXISTS movimientos_almacen (
        id_movimiento INT AUTO_INCREMENT PRIMARY KEY,
        tipo_movimiento ENUM('ENTRADA', 'SALIDA') NOT NULL,
        id_repuesto INT NOT NULL,
        cantidad INT NOT NULL,
        costo_unitario DECIMAL(10,2) NULL,
        costo_total DECIMAL(10,2) NULL,
        numero_factura VARCHAR(50) NULL,
        proveedor VARCHAR(100) NULL,
        motivo_salida VARCHAR(100) NULL,
        entregado_a VARCHAR(100) NULL,
        cliente VARCHAR(100) NULL,
        cliente_final VARCHAR(100) NULL,
        serial_maquina VARCHAR(50) NULL,
        codigo_interno_maquina VARCHAR(50) NULL,
        referencia_maquina VARCHAR(100) NULL,
        fecha_movimiento TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (id_repuesto) REFERENCES repuestos(id_repuesto) ON DELETE CASCADE
      );
    `);

    // 6. Tabla Solicitudes y Autorizaciones de Compra
    await pool.query(`
      CREATE TABLE IF NOT EXISTS solicitudes_compra (
        id_solicitud INT AUTO_INCREMENT PRIMARY KEY,
        id_repuesto INT NOT NULL,
        estado ENUM('PENDIENTE', 'AUTORIZADO', 'COMPRADO') DEFAULT 'PENDIENTE',
        fecha_autorizacion DATETIME NULL,
        autorizado_por VARCHAR(100) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (id_repuesto) REFERENCES repuestos(id_repuesto) ON DELETE CASCADE
      );
    `);

    console.log('--> Base de datos e historia de tablas inicializadas correctamente.');
  } catch (err) {
    console.error('--> Error al conectar/inicializar la Base de Datos:', err);
  }
}

initDB();

// --- RUTAS DE AUTENTICACIÓN ---
app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;
  try {
    const [rows] = await pool.query('SELECT * FROM usuarios WHERE usuario = ?', [usuario]);
    if (rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado' });

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Contraseña incorrecta' });

    const token = jwt.encode({ id: user.id_usuario, rol: user.rol }, SECRET_KEY);
    res.json({ token, rol: user.rol, nombre: user.nombre });
  } catch (err) {
    res.status(500).json({ error: 'Error interno en el servidor' });
  }
});

// --- RUTAS DE EQUIPOS Y MANTENIMIENTOS ---
app.get('/api/equipos', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM equipos ORDER BY id_equipo DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar equipos' });
  }
});

app.post('/api/equipos', async (req, res) => {
  const { codigo_interno, numero_serie, marca, modelo, ubicacion_cliente, contador_actual } = req.body;
  try {
    await pool.query(`
      INSERT INTO equipos (codigo_interno, numero_serie, marca, modelo, ubicacion_cliente, contador_actual)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [codigo_interno, numero_serie, marca || 'Ricoh', modelo, ubicacion_cliente, contador_actual || 0]);

    res.json({ mensaje: 'Equipo registrado con éxito' });
  } catch (err) {
    res.status(400).json({ error: 'El código interno o número de serie ya existe' });
  }
});

app.post('/api/equipos/upload-csv', upload.single('archivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });

  const resultados = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (data) => resultados.push(data))
    .on('end', async () => {
      fs.unlinkSync(req.file.path);
      try {
        for (const eq of resultados) {
          await pool.query(`
            INSERT INTO equipos (codigo_interno, numero_serie, marca, modelo, ubicacion_cliente, contador_actual)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
            marca = VALUES(marca), modelo = VALUES(modelo), ubicacion_cliente = VALUES(ubicacion_cliente), contador_actual = VALUES(contador_actual)
          `, [eq.codigo_interno, eq.numero_serie, eq.marca || 'Ricoh', eq.modelo, eq.ubicacion_cliente, eq.contador_actual || 0]);
        }
        res.json({ mensaje: 'Procesados ' + resultados.length + ' equipos con éxito.' });
      } catch (err) {
        res.status(500).json({ error: 'Error al procesar el archivo CSV' });
      }
    });
});

app.post('/api/mantenimientos', async (req, res) => {
  const { id_equipo, tipo_servicio, contador_impresiones, descripcion, repuestos_cambiados, tecnico } = req.body;
  try {
    await pool.query(`
      INSERT INTO mantenimientos (id_equipo, tipo_servicio, contador_impresiones, descripcion, repuestos_cambiados, tecnico)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id_equipo, tipo_servicio, contador_impresiones, descripcion, repuestos_cambiados, tecnico]);

    await pool.query('UPDATE equipos SET contador_actual = ? WHERE id_equipo = ?', [contador_impresiones, id_equipo]);

    res.json({ mensaje: 'Mantenimiento guardado correctamente' });
  } catch (err) {
    res.status(500).json({ error: 'Error al guardar el mantenimiento' });
  }
});

app.get('/api/mantenimientos/:id_equipo', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM mantenimientos WHERE id_equipo = ? ORDER BY fecha_servicio DESC', [req.params.id_equipo]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener mantenimientos' });
  }
});

// --- RUTAS DE REPUESTOS Y ALMACÉN ---
app.get('/api/repuestos', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM repuestos ORDER BY id_repuesto DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar repuestos' });
  }
});

app.post('/api/repuestos', async (req, res) => {
  const { codigo_interno, descripcion, estado_repuesto, uso_destino, stock_minimo } = req.body;
  try {
    await pool.query(`
      INSERT INTO repuestos (codigo_interno, descripcion, estado_repuesto, uso_destino, stock_minimo)
      VALUES (?, ?, ?, ?, ?)
    `, [codigo_interno, descripcion, estado_repuesto || 'Nuevo', uso_destino || 'Ambos', stock_minimo || 2]);
    res.json({ mensaje: 'Repuesto registrado en el catálogo con éxito' });
  } catch (err) {
    res.status(400).json({ error: 'El código interno del repuesto ya existe' });
  }
});

app.post('/api/almacen/movimiento', async (req, res) => {
  const {
    tipo_movimiento, id_repuesto, cantidad,
    costo_unitario, costo_total, numero_factura, proveedor,
    motivo_salida, entregado_a, cliente, cliente_final,
    serial_maquina, codigo_interno_maquina, referencia_maquina
  } = req.body;

  try {
    const cant = parseInt(cantidad);
    await pool.query(`
      INSERT INTO movimientos_almacen (
        tipo_movimiento, id_repuesto, cantidad, costo_unitario, costo_total,
        numero_factura, proveedor, motivo_salida, entregado_a, cliente,
        cliente_final, serial_maquina, codigo_interno_maquina, referencia_maquina
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      tipo_movimiento, id_repuesto, cant, costo_unitario || null, costo_total || null,
      numero_factura || null, proveedor || null, motivo_salida || null, entregado_a || null,
      cliente || null, cliente_final || null, serial_maquina || null,
      codigo_interno_maquina || null, referencia_maquina || null
    ]);

    if (tipo_movimiento === 'ENTRADA') {
      await pool.query('UPDATE repuestos SET stock_actual = stock_actual + ? WHERE id_repuesto = ?', [cant, id_repuesto]);
    } else if (tipo_movimiento === 'SALIDA') {
      await pool.query('UPDATE repuestos SET stock_actual = stock_actual - ? WHERE id_repuesto = ?', [cant, id_repuesto]);
    }

    res.json({ mensaje: 'Movimiento registrado correctamente y stock actualizado' });
  } catch (err) {
    res.status(500).json({ error: 'Error al registrar movimiento de almacén' });
  }
});

// --- RUTAS DEL SUPERVISOR ---
app.get('/api/supervisor/alertas', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT r.*, COALESCE(s.estado, 'PENDIENTE') AS estado_solicitud, s.id_solicitud
      FROM repuestos r
      LEFT JOIN solicitudes_compra s ON r.id_repuesto = s.id_repuesto AND s.estado != 'COMPRADO'
      WHERE r.stock_actual <= r.stock_minimo
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar alertas' });
  }
});

app.post('/api/supervisor/autorizar', async (req, res) => {
  const { id_repuesto, autorizado_por } = req.body;
  try {
    await pool.query(`
      INSERT INTO solicitudes_compra (id_repuesto, estado, fecha_autorizacion, autorizado_por)
      VALUES (?, 'AUTORIZADO', NOW(), ?)
      ON DUPLICATE KEY UPDATE estado = 'AUTORIZADO', fecha_autorizacion = NOW(), autorizado_por = VALUES(autorizado_por)
    `, [id_repuesto, autorizado_por || 'Supervisor']);

    res.json({ mensaje: 'Compra autorizada con éxito por el supervisor' });
  } catch (err) {
    res.status(500).json({ error: 'Error al autorizar compra' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(Servidor ejecutándose en el puerto ${PORT});
}); 
