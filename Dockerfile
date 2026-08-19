# Dockerfile
# -----------------------------------------------------------------------
# ใช้ตอน deploy ขึ้นแพลตฟอร์มที่รับ Docker image (Render, Railway, Fly.io,
# VPS ของตัวเอง ฯลฯ) ไม่จำเป็นต้องใช้ตอนพัฒนาในเครื่อง (ใช้ npm start ตรงๆ ได้)
# -----------------------------------------------------------------------
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
