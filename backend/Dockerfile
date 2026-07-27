FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY backend/package.json ./
RUN npm install --production

# Copy server code
COPY backend/server.js ./

# Copy frontend files directly into the image
COPY frontend/ ./frontend/

EXPOSE 4000

CMD ["node", "server.js"]
