const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { Pool } = require('pg');

require('dotenv').config();

let config = {};
const configPath = path.join(__dirname, 'config.json');
if (fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

const app = express();
const PORT = process.env.PORT || config.port || 5000;
const JWT_SECRET = process.env.JWT_SECRET || config.jwtSecret;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || config.adminUsername;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || config.adminPasswordHash;

/* ── PostgreSQL Pool ── */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});
async function query(sql, params) {
  const client = await pool.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

/* ── DB init ── */
async function initDB() {
  await query(`CREATE TABLE IF NOT EXISTS fonts (
    id BIGINT PRIMARY KEY, title TEXT NOT NULL, title_en TEXT DEFAULT '',
    description_ar TEXT DEFAULT '', description_en TEXT DEFAULT '',
    download_url TEXT DEFAULT '', font_file TEXT,
    images JSONB DEFAULT '[]', weights JSONB DEFAULT '[]',
    is_paid BOOLEAN DEFAULT FALSE, license TEXT DEFAULT '',
    free_weights JSONB DEFAULT '[]', paid_weights JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS social_links (
    id BIGINT PRIMARY KEY, platform TEXT DEFAULT '',
    url TEXT DEFAULT '', icon TEXT DEFAULT 'default',
    icon_svg TEXT DEFAULT '', sort_order INT DEFAULT 0
  )`);
  await query(`CREATE TABLE IF NOT EXISTS work_links (
    id BIGINT PRIMARY KEY, platform TEXT DEFAULT '',
    url TEXT DEFAULT '', icon TEXT DEFAULT 'default',
    icon_svg TEXT DEFAULT '', sort_order INT DEFAULT 0
  )`);
  await query(`CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value JSONB)`);
  await query(`ALTER TABLE social_links ADD COLUMN IF NOT EXISTS icon_svg TEXT DEFAULT ''`);
  await query(`ALTER TABLE work_links ADD COLUMN IF NOT EXISTS icon_svg TEXT DEFAULT ''`);
  await query(`INSERT INTO stats(key,value) VALUES('main','{"totalVisits":0,"todayDate":"","todayVisits":0,"fontViews":{},"fontDownloads":{}}') ON CONFLICT(key) DO NOTHING`);
}

/* ── Multer ── */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 30 * 1024 * 1024 } });
const fontUpload = upload.fields([{ name: 'images', maxCount: 10 }, { name: 'fontFile', maxCount: 1 }]);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache'); res.setHeader('Expires', '0'); next();
});

app.use('/uploads', (req, res, next) => {
  const referer = req.headers['referer'] || req.headers['referrer'] || '';
  const host = req.headers['host'] || '', origin = req.headers['origin'] || '';
  const fontExt = /\.(otf|ttf|woff|woff2)$/i.test(req.path);
  if (fontExt) {
    const fromSameHost = [host,'localhost','127.0.0.1'].some(h => h && (referer.includes(h)||origin.includes(h)));
    const fromReplit = referer.includes('.replit.dev')||referer.includes('.repl.co')||origin.includes('.replit.dev')||origin.includes('.repl.co');
    if (!fromSameHost && !fromReplit && referer !== '') return res.status(403).json({ error: 'Access denied' });
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(otf|ttf|woff|woff2)$/i.test(filePath)) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'inline');
    }
  }
}));

function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

/* ── AUTH ── */
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USERNAME) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  const ok = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  if (!ok) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  res.json({ token: jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' }) });
});

/* ── CONTENT ── */
const toLink = r => ({ id: Number(r.id), platform: r.platform, url: r.url, icon: r.icon, iconSvg: r.icon_svg || '' });
const toFont = r => ({
  id: Number(r.id), title: r.title, titleEn: r.title_en,
  descriptionAr: r.description_ar, descriptionEn: r.description_en,
  downloadUrl: r.download_url, fontFile: r.font_file,
  images: r.images || [], weights: r.weights || [],
  isPaid: r.is_paid, license: r.license,
  freeWeights: r.free_weights || [], paidWeights: r.paid_weights || [],
  createdAt: r.created_at
});

app.get('/api/content', async (req, res) => {
  try {
    const [soc, work, fnt] = await Promise.all([
      query('SELECT * FROM social_links ORDER BY sort_order'),
      query('SELECT * FROM work_links ORDER BY sort_order'),
      query('SELECT * FROM fonts ORDER BY created_at ASC')
    ]);
    res.json({ socialLinks: soc.rows.map(toLink), workLinks: work.rows.map(toLink), fonts: fnt.rows.map(toFont) });
  } catch(e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.put('/api/social-links', authMiddleware, async (req, res) => {
  try {
    await query('DELETE FROM social_links');
    for (let i = 0; i < req.body.length; i++) {
      const l = req.body[i];
      await query('INSERT INTO social_links(id,platform,url,icon,icon_svg,sort_order) VALUES($1,$2,$3,$4,$5,$6)',
        [l.id, l.platform, l.url||'', l.icon||'default', l.iconSvg||'', i]);
    }
    res.json({ success: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.put('/api/work-links', authMiddleware, async (req, res) => {
  try {
    await query('DELETE FROM work_links');
    for (let i = 0; i < req.body.length; i++) {
      const l = req.body[i];
      await query('INSERT INTO work_links(id,platform,url,icon,icon_svg,sort_order) VALUES($1,$2,$3,$4,$5,$6)',
        [l.id, l.platform, l.url||'', l.icon||'default', l.iconSvg||'', i]);
    }
    res.json({ success: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

/* ── FONTS ── */
app.post('/api/fonts', authMiddleware, fontUpload, async (req, res) => {
  try {
    const { title, titleEn, descriptionAr, descriptionEn, downloadUrl, weights, isPaid, license, freeWeights, paidWeights } = req.body;
    const images = ((req.files||{})['images']||[]).map(f => '/uploads/'+f.filename);
    const fontFile = ((req.files||{})['fontFile']||[])[0];
    const pw = w => w ? w.split(',').map(x => x.trim()).filter(Boolean) : [];
    const id = Date.now();
    await query(`INSERT INTO fonts(id,title,title_en,description_ar,description_en,download_url,font_file,images,weights,is_paid,license,free_weights,paid_weights)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id,title,titleEn||'',descriptionAr||'',descriptionEn||'',downloadUrl||'',
       fontFile?'/uploads/'+fontFile.filename:null,
       JSON.stringify(images),JSON.stringify(pw(weights)),isPaid==='true',
       license||'',JSON.stringify(pw(freeWeights)),JSON.stringify(pw(paidWeights))]);
    res.json({ id, title, titleEn:titleEn||'', descriptionAr:descriptionAr||'', descriptionEn:descriptionEn||'',
      downloadUrl:downloadUrl||'', fontFile:fontFile?'/uploads/'+fontFile.filename:null,
      images, weights:pw(weights), isPaid:isPaid==='true', license:license||'',
      freeWeights:pw(freeWeights), paidWeights:pw(paidWeights) });
  } catch(e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.put('/api/fonts/:id', authMiddleware, fontUpload, async (req, res) => {
  try {
    const id = req.params.id;
    const { title, titleEn, descriptionAr, descriptionEn, downloadUrl, weights, isPaid, license, freeWeights, paidWeights } = req.body;
    const fontFile = ((req.files||{})['fontFile']||[])[0];
    const newImages = ((req.files||{})['images']||[]);
    const ex = await query('SELECT * FROM fonts WHERE id=$1', [id]);
    if (!ex.rows.length) return res.status(404).json({ error: 'Not found' });
    const f = ex.rows[0];
    const pw = (w, fallback) => w !== undefined ? w.split(',').map(x=>x.trim()).filter(Boolean) : fallback;
    await query(`UPDATE fonts SET title=$1,title_en=$2,description_ar=$3,description_en=$4,download_url=$5,font_file=$6,images=$7,weights=$8,is_paid=$9,license=$10,free_weights=$11,paid_weights=$12 WHERE id=$13`,
      [title, titleEn||'', descriptionAr||'', descriptionEn||'', downloadUrl||'',
       fontFile?'/uploads/'+fontFile.filename:f.font_file,
       JSON.stringify(newImages.length?newImages.map(fi=>'/uploads/'+fi.filename):f.images),
       JSON.stringify(pw(weights, f.weights)),
       isPaid!==undefined?isPaid==='true':f.is_paid, license||'',
       JSON.stringify(pw(freeWeights, f.free_weights)),
       JSON.stringify(pw(paidWeights, f.paid_weights)), id]);
    const updated = (await query('SELECT * FROM fonts WHERE id=$1', [id])).rows[0];
    res.json(toFont(updated));
  } catch(e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.delete('/api/fonts/:id', authMiddleware, async (req, res) => {
  try { await query('DELETE FROM fonts WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch(e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

/* ── STATS ── */
async function getStats() {
  const r = await query("SELECT value FROM stats WHERE key='main'");
  return r.rows[0]?.value || { totalVisits:0, todayDate:'', todayVisits:0, fontViews:{}, fontDownloads:{} };
}
async function saveStats(s) {
  if (!s.fontDownloads) s.fontDownloads = {};
  await query("UPDATE stats SET value=$1 WHERE key='main'", [JSON.stringify(s)]);
}

app.post('/api/track-visit', async (req, res) => {
  try {
    const s = await getStats(); const today = new Date().toISOString().slice(0,10);
    if (s.todayDate !== today) { s.todayDate = today; s.todayVisits = 0; }
    s.totalVisits = (s.totalVisits||0)+1; s.todayVisits = (s.todayVisits||0)+1;
    await saveStats(s); res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

app.post('/api/track-font/:id', async (req, res) => {
  try {
    const s = await getStats();
    if (!s.fontViews) s.fontViews = {};
    s.fontViews[req.params.id] = (s.fontViews[req.params.id]||0)+1;
    await saveStats(s); res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

app.post('/api/track-download/:id', async (req, res) => {
  try {
    const s = await getStats();
    if (!s.fontDownloads) s.fontDownloads = {};
    s.fontDownloads[req.params.id] = (s.fontDownloads[req.params.id]||0)+1;
    await saveStats(s); res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const [sr, fr] = await Promise.all([
      query("SELECT value FROM stats WHERE key='main'"),
      query('SELECT id,title,title_en FROM fonts')
    ]);
    const s = sr.rows[0]?.value || { totalVisits:0, todayDate:'', todayVisits:0, fontViews:{}, fontDownloads:{} };
    const today = new Date().toISOString().slice(0,10);
    if (s.todayDate !== today) s.todayVisits = 0;
    const fontViews = fr.rows.map(f => ({
      id: Number(f.id), title: f.title, en: f.title_en||'',
      views: s.fontViews?.[String(f.id)]||0,
      downloads: s.fontDownloads?.[String(f.id)]||0
    })).sort((a,b) => b.views - a.views);
    res.json({ totalVisits:s.totalVisits||0, todayVisits:s.todayVisits||0, fontViews });
  } catch(e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.use((req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

/* ── START ── */
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
  if (PORT !== 80) {
    app.listen(80, '0.0.0.0', () => console.log('Server also running on port 80'))
       .on('error', () => console.log('Port 80 not available'));
  }
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
