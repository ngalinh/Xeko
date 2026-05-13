require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

const PORT = parseInt(process.env.PORT || '4001', 10);
const API_KEY = process.env.API_KEY || 'change-this-image-server-secret';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR || './data/uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const app = express();

function requireApiKey(req, res, next) {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const ACCEPTED_IMAGE_EXTS = /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i;

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const now = new Date();
      const dateDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const targetDir = path.join(UPLOADS_DIR, dateDir);
      fs.mkdirSync(targetDir, { recursive: true });
      req._dateDir = dateDir;
      cb(null, targetDir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 20,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || ACCEPTED_IMAGE_EXTS.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error(`File "${file.originalname}" không phải ảnh (${file.mimetype})`));
    }
  },
});

app.get('/health', (req, res) => {
  res.json({ ok: true, uploadsDir: UPLOADS_DIR });
});

app.post('/upload', requireApiKey, upload.array('images', 20), (req, res) => {
  const files = req.files || [];
  const dateDir = req._dateDir;
  const urls = files.map((f) => {
    const relPath = `/img/${dateDir}/${path.basename(f.path)}`;
    return PUBLIC_URL ? `${PUBLIC_URL}${relPath}` : relPath;
  });
  res.json({ urls });
});

app.get('/img/:date/:filename', (req, res) => {
  const { date, filename } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || /[/\\]/.test(filename)) {
    return res.status(400).send('Bad request');
  }
  const filePath = path.join(UPLOADS_DIR, date, filename);
  if (!filePath.startsWith(UPLOADS_DIR)) return res.status(400).send('Bad request');
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

app.use((err, req, res, next) => {
  console.error('[image-server error]', err.message);
  res.status(400).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`[image-server] listening on :${PORT}, uploads → ${UPLOADS_DIR}`);
});
