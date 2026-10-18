const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de Multer para carga de archivos
const upload = multer({ dest: 'uploads/' });

// Middleware
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
// RUTAS DE AUTENTICACIÓN Y USUARIOS
// ==========================================

app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;
  try {
    const [rows] = await pool.query('SELECT * FROM usuarios WHERE usuario = ? AND password = ?', [usuario, password]);
    if (rows.length > 0) {
      const user = rows[0];
      res.json({ mensaje: 'Login exitoso', rol: user.rol, nombre: user.nombre });
    } else {
      res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
  } catch (err) {
    console.error('Error en Login:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ==========================================
// RUTAS DE ALMACÉN Y REPUESTOS
// ==========================================

// Obtener catálogo de repuestos
app.get('/api/repuestos', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM repuestos ORDER BY id_repuesto DESC');
    res.json(rows);
  } catch (err) {
    console.error('Error al obtener repuestos:', err);
    res.status(500).json({ error: 'Error al consultar inventario' });
  }
});

// Crear un repuesto individual
app.post('/api/repuestos', async (req, res) => {
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

// Registrar movimiento (Entrada / Salida) con actualización automática de stock
app.post('/api/almacen/movimiento', async (req, res) => {
  const { 
    tipo_movimiento, id_repuesto, cantidad, 
    numero_factura, proveedor, costo_unitario, 
    motivo_salida, entregado_a, cliente, serial_maquina 
  } = req.body;

  if (!id_repuesto || !cantidad || cantidad <= 0) {
    return res.status(400).json({ error: 'Debe seleccionar un repuesto y una cantidad válida' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Obtener el repuesto actual
    const [rep] = await conn.query('SELECT stock_actual FROM repuestos WHERE id_repuesto = ?', [id_repuesto]);
    if (rep.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Repuesto no encontrado' });
    }

    let nuevoStock = rep[0].stock_actual;
    if (tipo_movimiento === 'ENTRADA') {
      nuevoStock += parseInt(cantidad);
    } else if (tipo_movimiento === 'SALIDA') {
      if (nuevoStock < cantidad) {
        await conn.rollback();
        return res.status(400).json({ error: `Stock insuficiente. Stock actual: ${nuevoStock}` });
      }
      nuevoStock -= parseInt(cantidad);
    }

    // 2. Registrar el movimiento en el Kardex
    await conn.query(
      `INSERT INTO movimientos_almacen 
       (tipo_movimiento, id_repuesto, cantidad, numero_factura, proveedor, costo_unitario, motivo_salida, entregado_a, cliente, serial_maquina) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tipo_movimiento, id_repuesto, cantidad, numero_factura || null, proveedor || null, costo_unitario || null, motivo_salida || null, entregado_a || null, cliente || null, serial_maquina || null]
    );

    // 3. Actualizar el stock en el catálogo
    await conn.query('UPDATE repuestos SET stock_actual = ? WHERE id_repuesto = ?', [nuevoStock, id_repuesto]);

    await conn.commit();
    res.json({ mensaje: 'Movimiento registrado y stock actualizado con éxito' });
  } catch (err) {
    await conn.rollback();
    console.error('Error en movimiento de almacén:', err);
    res.status(500).json({ error: 'Error al procesar el movimiento' });
  } finally {
    conn.release();
  }
});

// Consultar historial de movimientos (Kardex)
app.get('/api/almacen/movimientos', async (req, res) => {
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
// IMPORTACIÓN MASIVA REPOTENCIADA (EXCEL/CSV)
// Detecta tanto Repuestos como Plantillas de Alquiler / Máquinas
// ==========================================

app.post('/api/repuestos/upload', upload.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se subió ningún archivo" });
  
  try {
    const filePath = req.file.path;
    const workbook = XLSX.readFile(filePath);
    
    // Procesa la primera hoja disponible
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const resultados = XLSX.utils.sheet_to_json(sheet);

    // Eliminar archivo temporal tras leerlo
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    if (resultados.length === 0) {
      return res.status(400).json({ error: "El archivo está vacío o no contiene filas de datos." });
    }

    let importados = 0;

    for (const item of resultados) {
      // Campos de planillas de Máquinas/Alquiler
      const numInterno = item['Numero Interno'] || item['Numero interno'] || item['NUMERO INTERNO'] || item.NumeroInterno;
      const referencia = item['REFERENCIA'] || item.Referencia || item.referencia;
      const serial = item['SERIAL'] || item.Serial || item.serial;
      const cliente = item['NOMBRE PROPIO CLIENTE'] || item['Nombre Cliente'] || item.Cliente;

      // Detectar código (sea de repuesto tradicional o de máquina)
      let codigo = item.codigo_interno || item.Codigo || item.CODIGO || item.codigo || item.COD || item['CÓDIGO'];
      
      if (!codigo && (numInterno || serial)) {
        codigo = numInterno ? `EQ-${numInterno}` : `SN-${serial}`;
      }

      // Detectar descripción (sea de repuesto tradicional o de máquina)
      let descripcion = item.descripcion || item.Descripcion || item.DESCRIPCION || item.repuesto || item.NOMBRE;
      
      if (!descripcion && (referencia || cliente)) {
        descripcion = `Equipo ${referencia || 'Multifuncional'} - Cliente: ${cliente || 'N/A'} (SN: ${serial || 'N/A'})`.trim();
      }

      const estado = item.estado_repuesto || item.Estado || item.ESTADO || 'Usado';
      const uso = item.uso_destino || item.Uso || item['TIPO COBRO'] || 'Alquiler';
      
      const stockVal = item.stock_actual || item.Stock || item.CANTIDAD || item.Cantidad || 1;
      const stock = parseInt(stockVal) || 1;
      
      const minVal = item.stock_minimo || item.Minimo || 2;
      const min = parseInt(minVal) || 2;

      // Inserción / Actualización inteligente en la BD
      if (codigo && descripcion) {
        await pool.query(
          `INSERT INTO repuestos (codigo_interno, descripcion, estado_repuesto, uso_destino, stock_actual, stock_minimo) 
           VALUES (?, ?, ?, ?, ?, ?) 
           ON DUPLICATE KEY UPDATE 
           descripcion = VALUES(descripcion), 
           stock_actual = VALUES(stock_actual)`,
          [String(codigo).trim(), String(descripcion).trim(), String(estado).trim(), String(uso).trim(), stock, min]
        );
        importados++;
      }
    }

    if (importados === 0) {
      return res.status(400).json({ 
        error: "No se reconocieron las columnas. Asegúrate de incluir encabezados de repuestos o campos como 'Numero Interno', 'REFERENCIA', 'SERIAL'." 
      });
    }

    res.json({ mensaje: `¡Base de datos importada con éxito! Se procesaron y guardaron ${importados} registros en el sistema.` });
  } catch (err) {
    console.error("Error al procesar archivo masivo:", err);
    res.status(500).json({ error: "Error interno al procesar el archivo Excel/CSV: " + err.message });
  }
});

// ==========================================
// RUTAS DE SUPERVISOR
// ==========================================

// Alertas de stock crítico
app.get('/api/supervisor/alertas', async (req, res) => {
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

// Autorizar solicitud de compra
app.post('/api/supervisor/autorizar', async (req, res) => {
  const { id_repuesto, autorizado_por } = req.body;
  try {
    await pool.query(
      `INSERT INTO autorizaciones_compra (id_repuesto, estado, autorizado_por) 
       VALUES (?, 'AUTORIZADO', ?)`,
      [id_repuesto, autorizado_por || 'Supervisor']
    );
    res.json({ mensaje: 'Orden de compra autorizada con éxito' });
  } catch (err) {
    console.error('Error al autorizar compra:', err);
    res.status(500).json({ error: 'Error al autorizar la compra' });
  }
});

// Auditoría de autorizaciones
app.get('/api/supervisor/auditoria', async (req, res) => {
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

// Servir frontend para cualquier ruta no mapeada
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en el puerto ${PORT}`);
});
