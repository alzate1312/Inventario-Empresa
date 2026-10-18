// ==========================================
// IMPORTACIÓN MASIVA FLEXIBLE (EXCEL / CSV) - FIX USO_DESTINO
// ==========================================

app.post('/api/repuestos/upload', upload.single('archivo'), async (req, res) => {
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
      
      // FIX PARA EVITAR EL ERROR "Data truncated for column 'uso_destino'"
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
