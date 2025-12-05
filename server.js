const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const soap = require('soap');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Configuración de URLs
const CONFIG = {
  // Homologación (Testing)
  homo: {
    wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms?WSDL',
    wsfe: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx?WSDL'
  },
  // Producción
  prod: {
    wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms?WSDL',
    wsfe: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx?WSDL'
  }
};

// Cache de tokens (en producción usar Redis)
const tokenCache = new Map();

// ==================== FUNCIONES AUXILIARES ====================

/**
 * Genera un ID único para archivos temporales
 */
function generateId() {
  return `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Crea el TRA (Ticket de Requerimiento de Acceso)
 */
function createTRA(service = 'wsfe') {
  const now = new Date();
  const generationTime = new Date(now.getTime() - 600000).toISOString(); // 10 min antes
  const expirationTime = new Date(now.getTime() + 600000).toISOString(); // 10 min después
  const uniqueId = Math.floor(Date.now() / 1000);

  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${uniqueId}</uniqueId>
    <generationTime>${generationTime}</generationTime>
    <expirationTime>${expirationTime}</expirationTime>
  </header>
  <service>${service}</service>
</loginTicketRequest>`;
}

/**
 * Firma el TRA y genera el CMS en Base64
 */
function signTRA(tra, cert, key) {
  const id = generateId();
  const tmpDir = '/tmp';
  
  const certPath = path.join(tmpDir, `cert_${id}.pem`);
  const keyPath = path.join(tmpDir, `key_${id}.key`);
  const traPath = path.join(tmpDir, `tra_${id}.xml`);
  const cmsPath = path.join(tmpDir, `cms_${id}.pem`);

  try {
    // Guardar archivos temporales
    fs.writeFileSync(certPath, cert);
    fs.writeFileSync(keyPath, key);
    fs.writeFileSync(traPath, tra);

    // Firmar con OpenSSL
    execSync(
      `openssl cms -sign -in "${traPath}" -out "${cmsPath}" -signer "${certPath}" -inkey "${keyPath}" -nodetach -outform PEM`,
      { stdio: 'pipe' }
    );

    // Leer el CMS firmado
    let cms = fs.readFileSync(cmsPath, 'utf8');
    
    // Extraer solo el contenido base64 (sin headers)
    cms = cms
      .replace('-----BEGIN CMS-----', '')
      .replace('-----END CMS-----', '')
      .replace(/\r?\n/g, '')
      .trim();

    return cms;
  } finally {
    // Limpiar archivos temporales
    [certPath, keyPath, traPath, cmsPath].forEach(f => {
      try { fs.unlinkSync(f); } catch (e) {}
    });
  }
}

/**
 * Obtiene el Token y Sign del WSAA
 */
async function getTokenSign(cuit, cert, key, environment = 'homo') {
  // Verificar cache
  const cacheKey = `${cuit}_${environment}`;
  const cached = tokenCache.get(cacheKey);
  
  if (cached && cached.expiration > new Date()) {
    console.log(`[${cuit}] Usando token cacheado`);
    return { token: cached.token, sign: cached.sign };
  }

  console.log(`[${cuit}] Solicitando nuevo token...`);

  // Crear y firmar TRA
  const tra = createTRA('wsfe');
  const cms = signTRA(tra, cert, key);

  // Llamar al WSAA
  const wsaaUrl = CONFIG[environment].wsaa;
  const client = await soap.createClientAsync(wsaaUrl);
  
  const [result] = await client.loginCmsAsync({ in0: cms });
  
  // Parsear respuesta
  const loginTicketResponse = result.loginCmsReturn;
  
  const tokenMatch = loginTicketResponse.match(/<token>([\s\S]*?)<\/token>/);
  const signMatch = loginTicketResponse.match(/<sign>([\s\S]*?)<\/sign>/);
  const expirationMatch = loginTicketResponse.match(/<expirationTime>([\s\S]*?)<\/expirationTime>/);

  if (!tokenMatch || !signMatch) {
    throw new Error('No se pudo obtener token/sign del WSAA');
  }

  const token = tokenMatch[1].trim();
  const sign = signMatch[1].trim();
  const expiration = expirationMatch ? new Date(expirationMatch[1]) : new Date(Date.now() + 11 * 60 * 60 * 1000);

  // Guardar en cache
  tokenCache.set(cacheKey, { token, sign, expiration });

  console.log(`[${cuit}] Token obtenido, expira: ${expiration}`);

  return { token, sign };
}

/**
 * Obtiene el cliente SOAP del WSFE
 */
async function getWSFEClient(environment = 'homo') {
  const wsfeUrl = CONFIG[environment].wsfe;
  return await soap.createClientAsync(wsfeUrl);
}

// ==================== ENDPOINTS ====================

/**
 * Health check
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Obtener último comprobante autorizado
 */
app.post('/ultimo-comprobante', async (req, res) => {
  try {
    const { cuit, cert, key, puntoVenta, tipoComprobante, environment = 'homo' } = req.body;

    if (!cuit || !cert || !key || !puntoVenta || !tipoComprobante) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }

    // Obtener token
    const { token, sign } = await getTokenSign(cuit, cert, key, environment);

    // Llamar al WSFE
    const client = await getWSFEClient(environment);
    
    const [result] = await client.FECompUltimoAutorizadoAsync({
      Auth: { Token: token, Sign: sign, Cuit: cuit },
      PtoVta: puntoVenta,
      CbteTipo: tipoComprobante
    });

    const cbteNro = result.FECompUltimoAutorizadoResult.CbteNro;

    res.json({
      success: true,
      ultimoComprobante: cbteNro,
      puntoVenta,
      tipoComprobante
    });

  } catch (error) {
    console.error('Error en /ultimo-comprobante:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: error.root?.Envelope?.Body?.Fault?.faultstring || null
    });
  }
});

/**
 * Crear factura (solicitar CAE)
 */
app.post('/crear-factura', async (req, res) => {
  try {
    const { 
      cuit, 
      cert, 
      key, 
      environment = 'homo',
      factura 
    } = req.body;

    if (!cuit || !cert || !key || !factura) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }

    // Obtener token
    const { token, sign } = await getTokenSign(cuit, cert, key, environment);

    // Preparar request
    const feCAEReq = {
      FeCabReq: {
        CantReg: factura.CantReg || 1,
        PtoVta: factura.PtoVta,
        CbteTipo: factura.CbteTipo
      },
      FeDetReq: {
        FECAEDetRequest: [{
          Concepto: factura.Concepto,
          DocTipo: factura.DocTipo,
          DocNro: factura.DocNro,
          CbteDesde: factura.CbteDesde,
          CbteHasta: factura.CbteHasta,
          CbteFch: factura.CbteFch,
          ImpTotal: factura.ImpTotal,
          ImpTotConc: factura.ImpTotConc || 0,
          ImpNeto: factura.ImpNeto,
          ImpOpEx: factura.ImpOpEx || 0,
          ImpIVA: factura.ImpIVA,
          ImpTrib: factura.ImpTrib || 0,
          MonId: factura.MonId || 'PES',
          MonCotiz: factura.MonCotiz || 1
        }]
      }
    };

    // Agregar CondicionIVAReceptorId si existe (obligatorio desde abril 2025)
    if (factura.CondicionIVAReceptorId) {
      feCAEReq.FeDetReq.FECAEDetRequest[0].CondicionIVAReceptorId = factura.CondicionIVAReceptorId;
    }

    // Agregar IVA si existe
    if (factura.Iva && factura.Iva.length > 0) {
      feCAEReq.FeDetReq.FECAEDetRequest[0].Iva = {
        AlicIva: factura.Iva.map(iva => ({
          Id: iva.Id,
          BaseImp: iva.BaseImp,
          Importe: iva.Importe
        }))
      };
    }

    // Agregar tributos si existen
    if (factura.Tributos && factura.Tributos.length > 0) {
      feCAEReq.FeDetReq.FECAEDetRequest[0].Tributos = {
        Tributo: factura.Tributos
      };
    }

    // Agregar comprobantes asociados si existen (para notas de crédito/débito)
    if (factura.CbtesAsoc && factura.CbtesAsoc.length > 0) {
      feCAEReq.FeDetReq.FECAEDetRequest[0].CbtesAsoc = {
        CbteAsoc: factura.CbtesAsoc
      };
    }

    // Agregar datos de servicios si es concepto 2 o 3
    if (factura.Concepto === 2 || factura.Concepto === 3) {
      feCAEReq.FeDetReq.FECAEDetRequest[0].FchServDesde = factura.FchServDesde;
      feCAEReq.FeDetReq.FECAEDetRequest[0].FchServHasta = factura.FchServHasta;
      feCAEReq.FeDetReq.FECAEDetRequest[0].FchVtoPago = factura.FchVtoPago;
    }

    // Llamar al WSFE
    const client = await getWSFEClient(environment);
    
    const [result] = await client.FECAESolicitarAsync({
      Auth: { Token: token, Sign: sign, Cuit: cuit },
      FeCAEReq: feCAEReq
    });

    const response = result.FECAESolicitarResult;
    const cabResp = response.FeCabResp;
    const detResp = response.FeDetResp?.FECAEDetResponse?.[0];

    // Preparar respuesta
    const respuesta = {
      success: cabResp.Resultado === 'A',
      resultado: cabResp.Resultado,
      cuit: cabResp.Cuit,
      puntoVenta: cabResp.PtoVta,
      tipoComprobante: cabResp.CbteTipo,
      fechaProceso: cabResp.FchProceso
    };

    if (detResp) {
      respuesta.comprobante = {
        numero: detResp.CbteDesde,
        CAE: detResp.CAE || null,
        CAEVencimiento: detResp.CAEFchVto || null,
        resultado: detResp.Resultado
      };

      // Agregar observaciones si existen
      if (detResp.Observaciones) {
        respuesta.observaciones = detResp.Observaciones.Obs || detResp.Observaciones;
      }
    }

    // Agregar errores si existen
    if (response.Errors) {
      respuesta.errores = response.Errors.Err || response.Errors;
    }

    res.json(respuesta);

  } catch (error) {
    console.error('Error en /crear-factura:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: error.root?.Envelope?.Body?.Fault?.faultstring || null
    });
  }
});

/**
 * Consultar comprobante
 */
app.post('/consultar-comprobante', async (req, res) => {
  try {
    const { cuit, cert, key, puntoVenta, tipoComprobante, numeroComprobante, environment = 'homo' } = req.body;

    if (!cuit || !cert || !key || !puntoVenta || !tipoComprobante || !numeroComprobante) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }

    // Obtener token
    const { token, sign } = await getTokenSign(cuit, cert, key, environment);

    // Llamar al WSFE
    const client = await getWSFEClient(environment);
    
    const [result] = await client.FECompConsultarAsync({
      Auth: { Token: token, Sign: sign, Cuit: cuit },
      FeCompConsReq: {
        CbteTipo: tipoComprobante,
        CbteNro: numeroComprobante,
        PtoVta: puntoVenta
      }
    });

    const response = result.FECompConsultarResult;

    res.json({
      success: true,
      comprobante: response.ResultGet || null,
      errores: response.Errors?.Err || null
    });

  } catch (error) {
    console.error('Error en /consultar-comprobante:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * Obtener tipos de comprobante
 */
app.post('/tipos-comprobante', async (req, res) => {
  try {
    const { cuit, cert, key, environment = 'homo' } = req.body;

    if (!cuit || !cert || !key) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }

    const { token, sign } = await getTokenSign(cuit, cert, key, environment);
    const client = await getWSFEClient(environment);
    
    const [result] = await client.FEParamGetTiposCbteAsync({
      Auth: { Token: token, Sign: sign, Cuit: cuit }
    });

    res.json({
      success: true,
      tipos: result.FEParamGetTiposCbteResult.ResultGet?.CbteTipo || []
    });

  } catch (error) {
    console.error('Error en /tipos-comprobante:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Obtener tipos de documento
 */
app.post('/tipos-documento', async (req, res) => {
  try {
    const { cuit, cert, key, environment = 'homo' } = req.body;

    if (!cuit || !cert || !key) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }

    const { token, sign } = await getTokenSign(cuit, cert, key, environment);
    const client = await getWSFEClient(environment);
    
    const [result] = await client.FEParamGetTiposDocAsync({
      Auth: { Token: token, Sign: sign, Cuit: cuit }
    });

    res.json({
      success: true,
      tipos: result.FEParamGetTiposDocResult.ResultGet?.DocTipo || []
    });

  } catch (error) {
    console.error('Error en /tipos-documento:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Obtener tipos de IVA
 */
app.post('/tipos-iva', async (req, res) => {
  try {
    const { cuit, cert, key, environment = 'homo' } = req.body;

    if (!cuit || !cert || !key) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }

    const { token, sign } = await getTokenSign(cuit, cert, key, environment);
    const client = await getWSFEClient(environment);
    
    const [result] = await client.FEParamGetTiposIvaAsync({
      Auth: { Token: token, Sign: sign, Cuit: cuit }
    });

    res.json({
      success: true,
      tipos: result.FEParamGetTiposIvaResult.ResultGet?.IvaTipo || []
    });

  } catch (error) {
    console.error('Error en /tipos-iva:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Obtener condiciones IVA receptor
 */
app.post('/condiciones-iva-receptor', async (req, res) => {
  try {
    const { cuit, cert, key, environment = 'homo' } = req.body;

    if (!cuit || !cert || !key) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }

    const { token, sign } = await getTokenSign(cuit, cert, key, environment);
    const client = await getWSFEClient(environment);
    
    const [result] = await client.FEParamGetCondicionIvaReceptorAsync({
      Auth: { Token: token, Sign: sign, Cuit: cuit }
    });

    res.json({
      success: true,
      condiciones: result.FEParamGetCondicionIvaReceptorResult.ResultGet?.CondicionIvaReceptor || []
    });

  } catch (error) {
    console.error('Error en /condiciones-iva-receptor:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Obtener puntos de venta
 */
app.post('/puntos-venta', async (req, res) => {
  try {
    const { cuit, cert, key, environment = 'homo' } = req.body;

    if (!cuit || !cert || !key) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }

    const { token, sign } = await getTokenSign(cuit, cert, key, environment);
    const client = await getWSFEClient(environment);
    
    const [result] = await client.FEParamGetPtosVentaAsync({
      Auth: { Token: token, Sign: sign, Cuit: cuit }
    });

    res.json({
      success: true,
      puntosVenta: result.FEParamGetPtosVentaResult.ResultGet?.PtoVenta || []
    });

  } catch (error) {
    console.error('Error en /puntos-venta:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Dummy - verificar estado del servicio ARCA
 */
app.get('/dummy', async (req, res) => {
  try {
    const environment = req.query.environment || 'homo';
    const client = await getWSFEClient(environment);
    
    const [result] = await client.FEDummyAsync({});

    res.json({
      success: true,
      environment,
      appServer: result.FEDummyResult.AppServer,
      dbServer: result.FEDummyResult.DbServer,
      authServer: result.FEDummyResult.AuthServer
    });

  } catch (error) {
    console.error('Error en /dummy:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== INICIAR SERVIDOR ====================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 API de Facturación ARCA corriendo en puerto ${PORT}`);
  console.log(`📋 Endpoints disponibles:`);
  console.log(`   GET  /health`);
  console.log(`   GET  /dummy?environment=homo|prod`);
  console.log(`   POST /ultimo-comprobante`);
  console.log(`   POST /crear-factura`);
  console.log(`   POST /consultar-comprobante`);
  console.log(`   POST /tipos-comprobante`);
  console.log(`   POST /tipos-documento`);
  console.log(`   POST /tipos-iva`);
  console.log(`   POST /condiciones-iva-receptor`);
  console.log(`   POST /puntos-venta`);
});
