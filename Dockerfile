FROM node:20-alpine

# Instalar OpenSSL (necesario para firmar)
RUN apk add --no-cache openssl

WORKDIR /app

# Copiar package.json e instalar dependencias
COPY package*.json ./
RUN npm install --production

# Copiar código
COPY server.js ./

# Puerto
EXPOSE 3000

# Comando de inicio
CMD ["node", "server.js"]
