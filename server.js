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
    // Normalizar saltos de línea (por si vienen escapados desde Google Sheets)
    const certNormalized = cert.replace(/\\n/g, '\n');
    const keyNormalized = key.replace(/\\n/g, '\n');

    // Guardar archivos temporales con codificación UTF-8 explícita
    fs.writeFileSync(certPath, certNormalized, 'utf8');
    fs.writeFileSync(keyPath, keyNormalized, 'utf8');
    fs.writeFileSync(traPath, tra, 'utf8');

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
      feCAEReq.FeDetReq.FECAEDetRequest[
