const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const jwt = require('jwt-simple');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'copymaster_secret_key_2026_secure';

// Configuración de Multer para carga de archivos temporales
const upload = multer({ dest: 'uploads/' });

// Middleware Base
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Configuración de la base de datos MySQL (Aiven)
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 26963,
  ssl: { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Comprobar conexión a la Base de Datos
pool.getConnection()
  .then(conn => {
    console.log('✅ Conexión exitosa a la base de datos MySQL (Aiven)');
    conn.release();
  })
  .catch(err => {
    console.error('❌ Error de conexión a la base de datos:', err);
  });

// ==========================================
// MIDDLEWARES DE SEGURIDAD (JWT & ROLES)
// ==========================================

function autenticar(req, res, next) {
  const cabecera = req.headers.authorization;
  const token = cabecera?.startsWith('Bearer ') ? cabecera.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Debes iniciar sesión.' });
  }

  try {
    const usuario = jwt.decode(token, JWT_SECRET);

    if (!usuario.id || !usuario.rol || !usuario.exp || usuario.exp <= Math.floor(Date.now() / 1000)) {
      return res.status(401).json({ error: 'Sesión inválida o vencida.' });
    }

    req.usuario = usuario;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }
}

function permitirRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.usuario.rol)) {
      return res.status(403).json({ error: 'No tienes permisos para esta operación.' });
    }
    next();
  };
}

// ==========================================
// RUTAS DE AUTENTICACIÓN
// ==========================================

app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;

  try {
    let [rows] = await pool.query('SELECT * FROM usuarios WHERE usuario = ?', [usuario]);
    let user = rows[0];

    const credencialesBase = {
      'admin': { pass: 'admin123', rol: 'admin', nombre: 'Administrador Principal' },
      'almacen': { pass: 'almacen123', rol: 'almacen', nombre: 'Encargado de Almacén' },
      'supervisor': { pass: 'super123', rol: 'supervisor', nombre: 'Supervisor de Compras' },
      'tecnico': { pass: 'tec123', rol: 'tecnico', nombre: 'Técnico de Servicio' }
    };

    const cuentaBase = credencialesBase[usuario];
    let loginValido = false;

    if (user && user.password === password) {
      loginValido = true;
    } else if (cuentaBase && cuentaBase.pass === password) {
      loginValido = true;
      if (!user) {
        await pool.query(
          'INSERT INTO usuarios (usuario, password, rol, nombre) VALUES (?, ?, ?, ?)',
          [usuario, cuentaBase.pass, cuentaBase.rol, cuentaBase.nombre]
        );
        user = { usuario, rol: cuentaBase.rol, nombre: cuentaBase.nombre };
      } else {
        await pool.query('UPDATE usuarios SET password = ? WHERE usuario = ?', [cuentaBase.pass, usuario]);
        user.password = cuentaBase.pass;
      }
    }

    if (loginValido) {
      const token = jwt.encode({
        id: user.id_usuario || user.id || 1,
        rol: user.rol,
        nombre: user.nombre,
        exp: Math.floor(Date.now() / 1000) + (60 * 60 * 8)
      }, JWT_SECRET);

      return res.json({
        mensaje: 'Login exitoso',
        token,
        rol: user.rol,
        nombre: user.nombre || user.usuario
      });
    } else {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

  } catch (err) {
    console.error('Error en Login:', err);
    res.status(500).json({ error: 'Error interno del servidor al autenticar' });
  }
});

// ==========================================
// RUTAS DE ALMACÉN Y REPUESTOS (PROTEGIDAS)
// ==========================================

app.get('/api/repuestos', autenticar, permitirRoles('admin', 'almacen', 'supervisor', 'tecnico'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM repuestos ORDER BY id_repuesto DESC');
    res.json(rows);
  } catch (err) {
    console.error('Error al obtener repuestos:', err);
    res.status(500).json({ error: 'Error al consultar inventario' });
  }
});

app.post('/api/repuestos', autenticar, permitirRoles('admin', 'almacen'), async (req, res) => {
  const { codigo_interno, descripcion, estado_repuesto, uso_destino, stock_minimo } = req.body;
  try {
    await pool.query(
      `INSERT INTO repuestos (codigo_interno, descripcion, estado_repuesto, uso_destino, stock_actual, stock_minimo) 
       VALUES (?, ?, ?, ?, 0, ?)`,
      [codigo_interno, descripcion, estado_repuesto || 'Nuevo', uso_destino || 'Ambos', stock_minimo || 2]
    );
    res.json({ mensaje: 'Repuesto registrado con éxito' });
  } catch (err) {
    console.error('Error al registrar repuesto:', err);
    res.status(500).json({ error: 'Error al registrar repuesto. Verifique que el código no esté duplicado.' });
  }
});

app.post('/api/almacen/movimiento', autenticar, permitirRoles('admin', 'almacen'), async (req, res) => {
  const {
    tipo_movimiento,
    id_repuesto,
    cantidad,
    costo_unitario,
    numero_factura,
    proveedor,
    motivo_salida,
    entregado_a,
    cliente,
    cliente_final,
    serial_maquina,
    codigo_interno_maquina,
    referencia_maquina
  } = req.body;

  if (!['ENTRADA', 'SALIDA'].includes(tipo_movimiento)) {
    return res.status(400).json({ error: 'Tipo de movimiento inválido.' });
  }

  const id = Number(id_repuesto);
  const cant = Number(cantidad);

  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(cant) || cant <= 0) {
    return res.status(400).json({ error: 'Repuesto o cantidad inválidos.' });
  }

  if (tipo_movimiento === 'ENTRADA' && costo_unitario != null && (!Number.isFinite(Number(costo_unitario)) || Number(costo_unitario) < 0)) {
    return res.status(400).json({ error: 'El costo unitario no es válido.' });
  }

  let conexion;
  let transaccionIniciada = false;

  try {
    conexion = await pool.getConnection();
    await conexion.beginTransaction();
    transaccionIniciada = true;

    let actualizacion;
    if (tipo_movimiento === 'ENTRADA') {
      [actualizacion] = await conexion.query(
        `UPDATE repuestos SET stock_actual = stock_actual + ? WHERE id_repuesto = ?`,
        [cant, id]
      );
    } else {
      [actualizacion] = await conexion.query(
        `UPDATE repuestos SET stock_actual = stock_actual - ? WHERE id_repuesto = ? AND stock_actual >= ?`,
        [cant, id, cant]
      );
    }

    if (actualizacion.affectedRows !== 1) {
      const [repuestos] = await conexion.query('SELECT id_repuesto FROM repuestos WHERE id_repuesto = ?', [id]);
      await conexion.rollback();
      transaccionIniciada = false;

      if (!repuestos.length) {
        return res.status(404).json({ error: 'El repuesto no existe.' });
      }
      return res.status(409).json({ error: 'Stock insuficiente para realizar la salida.' });
    }

    const costo = tipo_movimiento === 'ENTRADA' && costo_unitario != null ? Number(costo_unitario) : null;
    const total = costo == null ? null : costo * cant;

    await conexion.query(
      `INSERT INTO movimientos_almacen (
        tipo_movimiento, id_repuesto, cantidad,
        costo_unitario, costo_total, numero_factura,
        proveedor, motivo_salida, entregado_a, cliente,
        cliente_final, serial_maquina,
        codigo_interno_maquina, referencia_maquina
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tipo_movimiento, id, cant,
        costo, total, numero_factura || null,
        proveedor || null, motivo_salida || null,
        entregado_a || null, cliente || null,
        cliente_final || null, serial_maquina || null,
        codigo_interno_maquina || null,
        referencia_maquina || null
      ]
    );

    await conexion.commit();
    transaccionIniciada = false;

    return res.status(201).json({ mensaje: 'Movimiento registrado y stock actualizado.' });
  } catch (error) {
    if (conexion && transaccionIniciada) {
      await conexion.rollback();
    }
    console.error('Error en movimiento de almacén:', error);
    return res.status(500).json({ error: 'No se pudo registrar el movimiento.' });
  } finally {
    if (conexion) conexion.release();
  }
});

app.get('/api/almacen/movimientos', autenticar, permitirRoles('admin', 'almacen', 'supervisor'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.*, r.codigo_interno, r.descripcion 
       FROM movimientos_almacen m 
       JOIN repuestos r ON m.id_repuesto = r.id_repuesto 
       ORDER BY m.fecha_movimiento DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Error al obtener movimientos:', err);
    res.status(500).json({ error: 'Error al obtener historial' });
  }
});

// ==========================================
// IMPORTACIÓN MASIVA FLEXIBLE (PROTEGIDA)
// ==========================================

app.post('/api/repuestos/upload', autenticar, permitirRoles('admin', 'almacen'), upload.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se subió ningún archivo" });
  
  try {
    const filePath = req.file.path;
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const resultados = XLSX.utils.sheet_to_json(sheet);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    if (resultados.length === 0) {
      return res.status(400).json({ error: "El archivo está vacío o no contiene filas de datos." });
    }

    let importados = 0;

    for (const item of resultados) {
      const numInterno = item['Numero Interno'] || item['Numero interno'] || item['NUMERO INTERNO'] || item.NumeroInterno;
      const referencia = item['REFERENCIA'] || item.Referencia || item.referencia;
      const serial = item['SERIAL'] || item.Serial || item.serial;
      const cliente = item['NOMBRE PROPIO CLIENTE'] || item['Nombre Cliente'] || item.Cliente;

      let codigo = item.codigo_interno || item.Codigo || item.CODIGO || item.codigo || item.COD || item['CÓDIGO'];
      if (!codigo && (numInterno || serial)) {
        codigo = numInterno ? `EQ-${numInterno}` : `SN-${serial}`;
      }

      let descripcion = item.descripcion || item.Descripcion || item.DESCRIPCION || item.repuesto || item.NOMBRE;
      if (!descripcion && (referencia || cliente)) {
        descripcion = `Equipo ${referencia || 'Multifuncional'} - Cliente: ${cliente || 'N/A'} (SN: ${serial || 'N/A'})`.trim();
      }

      const estado = item.estado_repuesto || item.Estado || item.ESTADO || 'Usado';
      let uso = 'Ambos';
      const rawUso = item.uso_destino || item.Uso || item['TIPO COBRO'] || '';
      const usoUpper = String(rawUso).toUpperCase();
      
      if (usoUpper.includes('ALQUILER') || usoUpper.includes('FACTURA')) {
        uso = 'Alquiler';
      } else if (usoUpper.includes('VENTA')) {
        uso = 'Venta';
      }

      const stockVal = item.stock_actual || item.Stock || item.CANTIDAD || item.Cantidad || 1;
      const stock = parseInt(stockVal) || 1;
      const minVal = item.stock_minimo || item.Minimo || 2;
      const min = parseInt(minVal) || 2;

      if (codigo && descripcion) {
        await pool.query(
          `INSERT INTO repuestos (codigo_interno, descripcion, estado_repuesto, uso_destino, stock_actual, stock_minimo) 
           VALUES (?, ?, ?, ?, ?, ?) 
           ON DUPLICATE KEY UPDATE 
           descripcion = VALUES(descripcion), 
           stock_actual = VALUES(stock_actual)`,
          [String(codigo).trim(), String(descripcion).trim(), String(estado).trim(), uso, stock, min]
        );
        importados++;
      }
    }

    if (importados === 0) {
      return res.status(400).json({ 
        error: "No se reconocieron las columnas. Asegúrate de incluir encabezados válidos en tu archivo." 
      });
    }

    res.json({ mensaje: `¡Base de datos importada con éxito! Se procesaron ${importados} registros.` });
  } catch (err) {
    console.error("Error al procesar archivo masivo:", err);
    res.status(500).json({ error: "Error interno al procesar el archivo Excel/CSV: " + err.message });
  }
});

// ==========================================
// RUTAS DE SUPERVISOR (PROTEGIDAS)
// ==========================================

app.get('/api/supervisor/alertas', autenticar, permitirRoles('admin', 'supervisor'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.*, 
              IF(a.id_autorizacion IS NOT NULL, 'AUTORIZADO', 'PENDIENTE') AS estado_solicitud
       FROM repuestos r
       LEFT JOIN autorizaciones_compra a ON r.id_repuesto = a.id_repuesto AND a.estado = 'AUTORIZADO'
       WHERE r.stock_actual <= r.stock_minimo`
    );
    res.json(rows);
  } catch (err) {
    console.error('Error al consultar alertas:', err);
    res.status(500).json({ error: 'Error al consultar alertas' });
  }
});

app.post('/api/supervisor/autorizar', autenticar, permitirRoles('admin', 'supervisor'), async (req, res) => {
  const { id_repuesto, autorizado_por } = req.body;
  try {
    await pool.query(
      `INSERT INTO autorizaciones_compra (id_repuesto, estado, autorizado_por) 
       VALUES (?, 'AUTORIZADO', ?)`,
      [id_repuesto, autorizado_por || req.usuario.nombre || 'Supervisor']
    );
    res.json({ mensaje: 'Orden de compra autorizada con éxito' });
  } catch (err) {
    console.error('Error al autorizar compra:', err);
    res.status(500).json({ error: 'Error al autorizar la compra' });
  }
});

app.get('/api/supervisor/auditoria', autenticar, permitirRoles('admin', 'supervisor'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, r.codigo_interno, r.descripcion 
       FROM autorizaciones_compra a 
       JOIN repuestos r ON a.id_repuesto = r.id_repuesto 
       ORDER BY a.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Error al consultar auditoría:', err);
    res.status(500).json({ error: 'Error al obtener auditoría' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en el puerto ${PORT}`);
});
