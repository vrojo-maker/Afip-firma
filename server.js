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
  homo: {
    wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms?WSDL',
    wsfe: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx?WSDL',
    padron: 'https://awshomo.afip.gov.ar/sr-padron/ws/include/ws_sr_constancia_inscripcion.wsdl'
  },
  prod: {
    wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms?WSDL',
    wsfe: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx?WSDL',
    padron: 'https://aws.afip.gov.ar/sr-padron/ws/include/ws_sr_constancia_inscripcion.wsdl'
  }
};

// Cache de tokens
const tokenCache = new Map();

// ==================== FUNCIONES AUXILIARES ====================

function generateId() {
  return `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function createTRA(service = 'wsfe') {
  const now = new Date();
  const generationTime = new Date(now.getTime() - 600000).toISOString();
  const expirationTime = new Date(now.getTime() + 600000).toISOString();
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

function signTRA(tra, cert, key) {
  const id = generateId();
  const tmpDir = '/tmp';
  
  const certPath = path.join(tmpDir, `cert_${id}.pem`);
  const keyPath = path.join(tmpDir, `key_${id}.key`);
  const traPath = path.join(tmpDir, `tra_${id}.xml`);
  const cmsPath = path.join(tmpDir, `cms_${id}.pem`);

  try {
    console.log('KEY recibida (primeros 100 chars):', key.substring(0, 100));
    console.log('KEY contiene \\n literales?', key.includes('\\n'));
    
    const certNormalized = cert.replace(/\\n/g, '\n');
    const keyNormalized = key.replace(/\\n/g, '\n');
    
    console.log('KEY normalizada (primeros 100 chars):', keyNormalized.substring(0, 100));

    fs.writeFileSync(certPath, certNormalized, 'utf8');
    fs.writeFileSync(keyPath, keyNormalized, 'utf8');
    fs.writeFileSync(traPath, tra, 'utf8');
    
    const savedKey = fs.readFileSync(keyPath, 'utf8');
    console.log('KEY guardada en archivo (primeros 100 chars):', savedKey.substring(0, 100));
    console.log('Tamaño del archivo KEY:', savedKey.length);

    execSync(
      `openssl cms -sign -in "${traPath}" -out "${cmsPath}" -signer "${certPath}" -inkey "${keyPath}" -nodetach -outform PEM`,
      { stdio: 'pipe' }
    );

    let cms = fs.readFileSync(cmsPath, 'utf8');
    
    cms = cms
      .replace('-----BEGIN CMS-----', '')
      .replace('-----END CMS-----', '')
      .replace(/\r?\n/g, '')
      .trim();

    return cms;
  } finally {
    [certPath, keyPath, traPath, cmsPath].forEach(f => {
      try { fs.unlinkSync(f); } catch (e) {}
    });
  }
}

/**
 * Obtiene token/sign del WSAA para un servicio específico
 * FIX: la clave de cache incluye el servicio para evitar reutilizar
 * tokens de wsfe en ws_sr_constancia_inscripcion
 */
async function getTokenSign(cuit, cert, key, environment = 'homo', service = 'wsfe') {
  const cacheKey = `${cuit}_${environment}_${service}`;  // ← CORREGIDO
  const cached = tokenCache.get(cacheKey);
  
  if (cached && cached.expiration > new Date()) {
    console.log(`[${cuit}] Usando token cacheado para ${service}`);
    return { token: cached.token, sign: cached.sign };
  }

  console.log(`[${cuit}] Solicitando nuevo token para ${service}...`);

  const tra = createTRA(service);
  const cms = signTRA(tra, cert, key);

  const wsaaUrl = CONFIG[environment].wsaa;
  const client = await soap.createClientAsync(wsaaUrl);
  
  const [result] = await client.loginCmsAsync({ in0: cms });
  
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

  tokenCache.set(cacheKey, { token, sign, expiration });

  console.log(`[${cuit}] Token obtenido para ${service}, expira: ${expiration}`);

  return { token, sign };
}

async function getWSFEClient(environment = 'homo') {
  const wsfeUrl = CONFIG[environment].wsfe;
  return await soap.createClientAsync(wsfeUrl);
}

// ==================== ENDPOINTS ====================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/ultimo-comprobante', async (req, res) => {
  try {
    const { cuit, cert, key, puntoVenta, tipoComprobante, environment = 'homo' } = req.body;

    if (!cuit || !cert || !key || !puntoVenta || !tipoComprobante) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }

    const { token, sign } = await getTokenSign(cuit, cert, key, environment, 'wsfe');
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

app.post('/crear-factura', async (req, res) => {
  try {
    const { cuit, cert, key, environment = 'homo', factura } = req.body;

    if (!cuit || !cert || !key || !factura) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }

    const { token, sign } = await getTokenSign(cuit, cert, key, environment, 'wsfe');

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

    if (factura.CondicionIVAReceptorId) {
      feCAEReq.FeDetReq.FECAEDetRequest[0].CondicionIVAReceptorId = factura.CondicionIVAReceptorId;
    }

    if (factura.Iva && factura.Iva.length > 0) {
      feCAEReq.FeDetReq.FECAEDetRequest[0].Iva = {
        AlicIva: factura.Iva.map(iva => ({
          Id: iva.Id,
          BaseImp: iva.BaseImp,
          Importe: iva.Importe
        }))
      };
    }

    if (factura.Tributos && factura.Tributos.length > 0) {
      feCAEReq.FeDetReq.FECAEDetRequest[0].Tributos = { Tributo: factura.Tributos };
    }

    if (factura.CbtesAsoc && factura.CbtesAsoc.length > 0) {
      feCAEReq.FeDetReq.FECAEDetRequest[0].CbtesAsoc = { CbteAsoc: factura.CbtesAsoc };
    }

    if (factura.Concepto === 2 || factura.Concepto === 3) {
      feCAEReq.FeDetReq.FECAEDetRequest[0].FchServDesde = factura.FchServDesde;
      feCAEReq.FeDetReq.FECAEDetRequest[0].FchServHasta = factura.FchServHasta;
      feCAEReq.FeDetReq.FECAEDetRequest[0].FchVtoPago = factura.FchVtoPago;
    }

    const client = await getWSFEClient(environment);
    
    const [result] = await client.FECAESolicitarAsync({
      Auth: { Token: token, Sign: sign, Cuit: cuit },
      FeCAEReq: feCAEReq
    });

    const response = result.FECAESolicitarResult;
    const cabResp = response.FeCabResp;
    const detResp = response.FeDetResp?.FECAEDetResponse?.[0];

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

      if (detResp.Observaciones) {
        respuesta.observaciones = detResp.Observaciones.Obs || detResp.Observaciones;
      }
    }

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

app.post('/consultar-comprobante', async (req, res) => {
  try {
    const { cuit, cert, key, puntoVenta, tipoComprobante, numeroComprobante, environment = 'homo' } = req.body;

    if (!cuit || !cert || !key || !puntoVenta || !tipoComprobante || !numeroComprobante) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }

    const { token, sign } = await getTokenSign(cuit, cert, key, environment, 'wsfe');
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
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/tipos-comprobante', async (req, res) => {
  try {
    const { cuit, cert, key, environment = 'homo' } = req.body;
    if (!cuit || !cert || !key) return res.status(400).json({ error: 'Faltan parámetros requeridos' });

    const { token, sign } = await getTokenSign(cuit, cert, key, environment, 'wsfe');
    const client = await getWSFEClient(environment);
    const [result] = await client.FEParamGetTiposCbteAsync({ Auth: { Token: token, Sign: sign, Cuit: cuit } });

    res.json({ success: true, tipos: result.FEParamGetTiposCbteResult.ResultGet?.CbteTipo || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/tipos-documento', async (req, res) => {
  try {
    const { cuit, cert, key, environment = 'homo' } = req.body;
    if (!cuit || !cert || !key) return res.status(400).json({ error: 'Faltan parámetros requeridos' });

    const { token, sign } = await getTokenSign(cuit, cert, key, environment, 'wsfe');
    const client = await getWSFEClient(environment);
    const [result] = await client.FEParamGetTiposDocAsync({ Auth: { Token: token, Sign: sign, Cuit: cuit } });

    res.json({ success: true, tipos: result.FEParamGetTiposDocResult.ResultGet?.DocTipo || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/tipos-iva', async (req, res) => {
  try {
    const { cuit, cert, key, environment = 'homo' } = req.body;
    if (!cuit || !cert || !key) return res.status(400).json({ error: 'Faltan parámetros requeridos' });

    const { token, sign } = await getTokenSign(cuit, cert, key, environment, 'wsfe');
    const client = await getWSFEClient(environment);
    const [result] = await client.FEParamGetTiposIvaAsync({ Auth: { Token: token, Sign: sign, Cuit: cuit } });

    res.json({ success: true, tipos: result.FEParamGetTiposIvaResult.ResultGet?.IvaTipo || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/condiciones-iva-receptor', async (req, res) => {
  try {
    const { cuit, cert, key, environment = 'homo' } = req.body;
    if (!cuit || !cert || !key) return res.status(400).json({ error: 'Faltan parámetros requeridos' });

    const { token, sign } = await getTokenSign(cuit, cert, key, environment, 'wsfe');
    const client = await getWSFEClient(environment);
    const [result] = await client.FEParamGetCondicionIvaReceptorAsync({ Auth: { Token: token, Sign: sign, Cuit: cuit } });

    res.json({ success: true, condiciones: result.FEParamGetCondicionIvaReceptorResult.ResultGet?.CondicionIvaReceptor || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/puntos-venta', async (req, res) => {
  try {
    const { cuit, cert, key, environment = 'homo' } = req.body;
    if (!cuit || !cert || !key) return res.status(400).json({ error: 'Faltan parámetros requeridos' });

    const { token, sign } = await getTokenSign(cuit, cert, key, environment, 'wsfe');
    const client = await getWSFEClient(environment);
    const [result] = await client.FEParamGetPtosVentaAsync({ Auth: { Token: token, Sign: sign, Cuit: cuit } });

    res.json({ success: true, puntosVenta: result.FEParamGetPtosVentaResult.ResultGet?.PtoVenta || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

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
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Consultar datos de contribuyente por CUIT
 * Usa ws_sr_constancia_inscripcion (requiere habilitación en ARCA)
 */
app.post('/consultar-contribuyente', async (req, res) => {
  try {
    const { cuit, cert, key, cuitConsulta, environment = 'homo' } = req.body;

    if (!cuit || !cert || !key || !cuitConsulta) {
      return res.status(400).json({ error: 'Faltan parámetros: cuit, cert, key, cuitConsulta' });
    }

    // Token específico para el servicio de padrón (distinto al de wsfe)
    const { token, sign } = await getTokenSign(cuit, cert, key, environment, 'ws_sr_constancia_inscripcion');

    // Cliente SOAP del padrón
    const padronUrl = CONFIG[environment].padron;
    const padronClient = await soap.createClientAsync(padronUrl);

    const [result] = await padronClient.getPersona_v2Async({
      token,
      sign,
      cuitRepresentada: cuit,
      idPersona: Number(cuitConsulta)  // ARCA requiere número, no string
    });

    const persona = result.personaReturn?.datosGenerales;

    if (!persona) {
      return res.status(404).json({ success: false, error: 'Contribuyente no encontrado' });
    }

    res.json({
      success: true,
      cuit: cuitConsulta,
      nombre: persona.razonSocial || `${persona.apellido}, ${persona.nombre}`,
      tipoPersona: persona.tipoPersona,
      domicilioFiscal: {
        calle: persona.domicilioFiscal?.direccion || '',
        localidad: persona.domicilioFiscal?.localidad || '',
        provincia: persona.domicilioFiscal?.descripcionProvincia || '',
        codigoPostal: persona.domicilioFiscal?.codPostal || ''
      },
      condicionIva: persona.estadoClave
    });

  } catch (error) {
    console.error('Error en /consultar-contribuyente:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
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
  console.log(`   POST /consultar-contribuyente`);
});
