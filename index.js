import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { PORT, PLANS, LIMITS, AI } from './config.js';
import { db, getUsage, addUsage } from './db.js';
import { authRouter, requireAuth, publicUser } from './auth.js';
import { extractText, extOf, UPLOAD_EXT, IMAGE_EXT } from './files.js';
import { runAgent, buildUserContent, historyToMessages } from './ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => res.json({ ok: true, aiConfigured: Boolean(AI.key), model: AI.model }));
app.use('/api/auth', authRouter);

app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

// ---------- المحادثات ----------
app.get('/api/chats', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id,title,updated_at FROM chats WHERE user_id=? ORDER BY updated_at DESC, id DESC LIMIT 200').all(req.user.id);
  res.json({ chats: rows });
});

function ownChat(req) {
  return db.prepare('SELECT * FROM chats WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
}

app.get('/api/chats/:id', requireAuth, (req, res) => {
  const chat = ownChat(req);
  if (!chat) return res.status(404).json({ error: 'المحادثة غير موجودة' });
  const rows = db.prepare('SELECT id,role,content,meta,created_at FROM messages WHERE chat_id=? ORDER BY id').all(chat.id);
  const messages = rows.map((m) => {
    let meta = {};
    try { meta = JSON.parse(m.meta); } catch {}
    // لا نرسل نص المستندات للواجهة
    return { id: m.id, role: m.role, content: m.content, attachments: meta.attachments || [], files: meta.files || [] };
  });
  res.json({ chat: { id: chat.id, title: chat.title }, messages });
});

app.patch('/api/chats/:id', requireAuth, (req, res) => {
  const chat = ownChat(req);
  if (!chat) return res.status(404).json({ error: 'المحادثة غير موجودة' });
  const title = String(req.body?.title || '').trim().slice(0, 80);
  if (!title) return res.status(400).json({ error: 'العنوان فاضي' });
  db.prepare('UPDATE chats SET title=? WHERE id=?').run(title, chat.id);
  res.json({ ok: true });
});

app.delete('/api/chats/:id', requireAuth, (req, res) => {
  const chat = ownChat(req);
  if (!chat) return res.status(404).json({ error: 'المحادثة غير موجودة' });
  const files = db.prepare('SELECT id,path FROM files WHERE chat_id=? AND user_id=?').all(chat.id, req.user.id);
  for (const f of files) fs.rmSync(f.path, { force: true });
  db.prepare('DELETE FROM files WHERE chat_id=? AND user_id=?').run(chat.id, req.user.id);
  db.prepare('DELETE FROM chats WHERE id=?').run(chat.id);
  res.json({ ok: true });
});

// ---------- الذاكرة ----------
app.get('/api/memories', requireAuth, (req, res) =>
  res.json({ memories: db.prepare('SELECT id,text FROM memories WHERE user_id=? ORDER BY id DESC').all(req.user.id) })
);
app.delete('/api/memories/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM memories WHERE id=? AND user_id=?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

// ---------- رفع الملفات ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join('data', 'uploads', String(req.user.id));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + '.' + extOf(file.originalname)),
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    // multer يقرأ الاسم كـ latin1؛ نصلّحه ليدعم الأسماء العربية
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, UPLOAD_EXT.has(extOf(file.originalname)));
  },
});

const uploadLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'رفع ملفات كتير، استنى شوية' } });

app.post('/api/upload', requireAuth, uploadLimiter, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'الملف أكبر من 15 ميجا' : 'تعذّر رفع الملف' });
    if (!req.file) return res.status(400).json({ error: 'نوع الملف غير مدعوم' });
    const id = crypto.randomBytes(12).toString('hex');
    const ext = extOf(req.file.originalname);
    const kind = IMAGE_EXT.has(ext) ? 'image' : 'doc';
    const mime = kind === 'image' ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'application/octet-stream';
    db.prepare('INSERT INTO files (id,user_id,chat_id,kind,name,path,mime,size) VALUES (?,?,?,?,?,?,?,?)').run(
      id, req.user.id, null, 'upload:' + kind, req.file.originalname, req.file.path, mime, req.file.size
    );
    res.json({ id, name: req.file.originalname, kind });
  });
});

app.get('/api/files/:id', requireAuth, (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id=? AND user_id=?').get(String(req.params.id), req.user.id);
  if (!f || !fs.existsSync(f.path)) return res.status(404).json({ error: 'الملف غير موجود' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.type(f.mime);
  res.download(path.resolve(f.path), f.name);
});

// ---------- الشات (SSE) ----------
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => 'u' + (req.user?.id ?? 'anon'),
  message: { error: 'بتبعت بسرعة، استنى شوية' },
});

app.post('/api/chat', requireAuth, chatLimiter, async (req, res) => {
  const { message, chatId, attachmentIds } = req.body || {};
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return res.status(400).json({ error: 'اكتب رسالة' });
  if (text.length > 20000) return res.status(400).json({ error: 'الرسالة طويلة جدًا' });
  const ids = Array.isArray(attachmentIds) ? attachmentIds.slice(0, 5).map(String) : [];

  const user = req.user;
  const limit = (PLANS[user.plan] || PLANS.free).daily;
  if (getUsage(user.id) >= limit)
    return res.status(429).json({ error: `وصلت للحد اليومي (${limit} رسالة) في خطتك. رقّي الخطة أو ارجع بكرة.` });

  let chat;
  if (chatId) {
    chat = db.prepare('SELECT * FROM chats WHERE id=? AND user_id=?').get(Number(chatId), user.id);
    if (!chat) return res.status(404).json({ error: 'المحادثة غير موجودة' });
  }

  // المرفقات: لازم تكون ملكًا للمستخدم
  const atts = ids
    .map((id) => db.prepare("SELECT * FROM files WHERE id=? AND user_id=? AND kind LIKE 'upload:%'").get(id, user.id))
    .filter(Boolean);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    if (!chat) {
      const title = text.replace(/\s+/g, ' ').slice(0, 50);
      const info = db.prepare('INSERT INTO chats (user_id,title) VALUES (?,?)').run(user.id, title);
      chat = { id: info.lastInsertRowid, title };
    }
    send('chat', { chatId: chat.id, title: chat.title });

    // نص المستندات + الصور
    const docs = [];
    const images = [];
    for (const a of atts) {
      db.prepare('UPDATE files SET chat_id=? WHERE id=?').run(chat.id, a.id);
      if (a.kind === 'upload:image') images.push(a);
      else {
        send('status', { text: '📎 بقرأ الملف: ' + a.name });
        let t = '';
        try { t = await extractText(a.path, a.name); } catch (e) { console.error('extract failed', e.message); }
        docs.push({ name: a.name, text: t || '(تعذّرت قراءة محتوى الملف)' });
      }
    }

    const hist = db
      .prepare('SELECT role,content,meta FROM (SELECT id,role,content,meta FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT ?) ORDER BY id')
      .all(chat.id, LIMITS.historyMessages);
    const memories = db.prepare('SELECT text FROM memories WHERE user_id=? ORDER BY id').all(user.id);

    addUsage(user.id);
    const userMeta = {
      attachments: atts.map((a) => ({ id: a.id, name: a.name, kind: a.kind.split(':')[1] })),
      docs,
      imageNames: images.map((i) => i.name),
    };
    db.prepare('INSERT INTO messages (chat_id,role,content,meta) VALUES (?,?,?,?)').run(chat.id, 'user', text, JSON.stringify(userMeta));

    const { text: answer, files } = await runAgent({
      userId: user.id,
      chatId: chat.id,
      history: historyToMessages(hist),
      userContent: buildUserContent(text, docs, images),
      memories,
      send,
    });

    db.prepare('INSERT INTO messages (chat_id,role,content,meta) VALUES (?,?,?,?)').run(chat.id, 'assistant', answer, JSON.stringify({ files }));
    db.prepare("UPDATE chats SET updated_at=datetime('now') WHERE id=?").run(chat.id);
    send('text', { content: answer });
    send('done', { usedToday: getUsage(user.id), dailyLimit: limit });
  } catch (e) {
    console.error('chat error:', e.message);
    send('error', { message: e.userMessage || 'حصل خطأ غير متوقع. جرّب تاني.' });
  } finally {
    res.end();
  }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'غير موجود' }));

app.use((err, _req, res, _next) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'خطأ في الخادم' });
});

app.listen(PORT, () => {
  console.log(`أفق شغّال على http://localhost:${PORT}`);
  if (!AI.key) console.warn('تنبيه: AI_API_KEY غير مضبوط في .env');
});
