# API de Facturación Electrónica ARCA

API REST para emitir facturas electrónicas con ARCA (ex AFIP) - Soporta múltiples emisores (CUITs).

## Características

- ✅ Soporte para múltiples CUITs/emisores
- ✅ Cache automático de tokens (12 horas)
- ✅ Firma CMS con OpenSSL
- ✅ Todos los tipos de comprobante (A, B, C, etc.)
- ✅ Homologación y Producción
- ✅ Listo para deploy en Docker

## Requisitos

- Node.js 18+
- OpenSSL instalado
- Certificados de ARCA (.crt y .key) por cada CUIT

## Instalación Local

```bash
# Clonar o copiar los archivos
cd arca-api

# Instalar dependencias
npm install

# Iniciar servidor
npm start
```

## Deploy con Docker

```bash
# Construir imagen
docker build -t arca-api .

# Ejecutar
docker run -p 3000:3000 arca-api
```

## Deploy en Railway/Render

1. Crear nuevo proyecto desde GitHub
2. Conectar el repositorio
3. El deploy es automático

## Endpoints

### Health Check
```
GET /health
```

### Verificar Estado ARCA
```
GET /dummy?environment=homo|prod
```

### Obtener Último Comprobante
```
POST /ultimo-comprobante
Content-Type: application/json

{
  "cuit": "20123456789",
  "cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
  "key": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----",
  "puntoVenta": 1,
  "tipoComprobante": 6,
  "environment": "homo"
}
```

### Crear Factura
```
POST /crear-factura
Content-Type: application/json

{
  "cuit": "20123456789",
  "cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
  "key": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----",
  "environment": "homo",
  "factura": {
    "PtoVta": 1,
    "CbteTipo": 6,
    "Concepto": 1,
    "DocTipo": 99,
    "DocNro": 0,
    "CbteDesde": 1,
    "CbteHasta": 1,
    "CbteFch": "20250605",
    "ImpTotal": 121,
    "ImpTotConc": 0,
    "ImpNeto": 100,
    "ImpOpEx": 0,
    "ImpIVA": 21,
    "ImpTrib": 0,
    "MonId": "PES",
    "MonCotiz": 1,
    "CondicionIVAReceptorId": 5,
    "Iva": [
      {
        "Id": 5,
        "BaseImp": 100,
        "Importe": 21
      }
    ]
  }
}
```

### Consultar Comprobante
```
POST /consultar-comprobante
Content-Type: application/json

{
  "cuit": "20123456789",
  "cert": "...",
  "key": "...",
  "puntoVenta": 1,
  "tipoComprobante": 6,
  "numeroComprobante": 1,
  "environment": "homo"
}
```

### Obtener Tipos (Comprobante, Documento, IVA, etc.)
```
POST /tipos-comprobante
POST /tipos-documento
POST /tipos-iva
POST /condiciones-iva-receptor
POST /puntos-venta

Body:
{
  "cuit": "20123456789",
  "cert": "...",
  "key": "...",
  "environment": "homo"
}
```

## Tipos de Comprobante Comunes

| Código | Descripción |
|--------|-------------|
| 1 | Factura A |
| 2 | Nota de Débito A |
| 3 | Nota de Crédito A |
| 6 | Factura B |
| 7 | Nota de Débito B |
| 8 | Nota de Crédito B |
| 11 | Factura C |
| 12 | Nota de Débito C |
| 13 | Nota de Crédito C |

## Tipos de Documento

| Código | Descripción |
|--------|-------------|
| 80 | CUIT |
| 86 | CUIL |
| 96 | DNI |
| 99 | Consumidor Final |

## Tipos de IVA

| Código | Alícuota |
|--------|----------|
| 3 | 0% |
| 4 | 10.5% |
| 5 | 21% |
| 6 | 27% |
| 8 | 5% |
| 9 | 2.5% |

## Condición IVA Receptor

| Código | Descripción |
|--------|-------------|
| 1 | IVA Responsable Inscripto |
| 4 | IVA Sujeto Exento |
| 5 | Consumidor Final |
| 6 | Responsable Monotributo |

## Ejemplo de Uso desde n8n

### Nodo HTTP Request - Crear Factura

**URL:** `https://tu-api.railway.app/crear-factura`
**Method:** POST
**Headers:** `Content-Type: application/json`

**Body:**
```json
{
  "cuit": "{{ $json.emisor.cuit }}",
  "cert": "{{ $json.emisor.certificado }}",
  "key": "{{ $json.emisor.clavePrivada }}",
  "environment": "prod",
  "factura": {
    "PtoVta": {{ $json.puntoVenta }},
    "CbteTipo": {{ $json.tipoComprobante }},
    "Concepto": 1,
    "DocTipo": {{ $json.cliente.tipoDoc }},
    "DocNro": {{ $json.cliente.nroDoc }},
    "CbteDesde": {{ $json.numeroComprobante }},
    "CbteHasta": {{ $json.numeroComprobante }},
    "CbteFch": "{{ $json.fecha }}",
    "ImpTotal": {{ $json.total }},
    "ImpNeto": {{ $json.neto }},
    "ImpIVA": {{ $json.iva }},
    "ImpTotConc": 0,
    "ImpOpEx": 0,
    "ImpTrib": 0,
    "CondicionIVAReceptorId": {{ $json.cliente.condicionIva }},
    "Iva": [
      {
        "Id": 5,
        "BaseImp": {{ $json.neto }},
        "Importe": {{ $json.iva }}
      }
    ]
  }
}
```

## Environments

| Valor | Descripción |
|-------|-------------|
| `homo` | Homologación/Testing |
| `prod` | Producción |

## Errores Comunes

- **10016**: Número de comprobante incorrecto → Consultar último comprobante primero
- **10242**: Falta CondicionIVAReceptorId → Agregar el campo (obligatorio desde abril 2025)
- **10015**: Error en documento del receptor → Verificar DocTipo y DocNro

## Seguridad

⚠️ **Importante**: Esta API maneja certificados sensibles. Recomendaciones:

1. Usar HTTPS siempre
2. No exponer públicamente sin autenticación
3. Agregar un API Key o JWT para proteger los endpoints
4. Considerar almacenar certificados en un vault seguro

## Licencia

MIT
