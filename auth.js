import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import crypto from 'crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { db, getUsage } from './db.js';
import { IS_PROD, PLANS } from './config.js';

function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  fs.mkdirSync('data', { recursive: true });
  const p = 'data/jwt.secret';
  if (!fs.existsSync(p)) fs.writeFileSync(p, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(p, 'utf8').trim();
}
const SECRET = loadSecret();
const COOKIE = 'ofoq_session';

const cookieOpts = {
  httpOnly: true,
  sameSite: 'lax',
  secure: IS_PROD,
  maxAge: 30 * 24 * 3600 * 1000,
  path: '/',
};

function publicUser(u) {
  const plan = PLANS[u.plan] ? u.plan : 'free';
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    plan,
    planLabel: PLANS[plan].label,
    dailyLimit: PLANS[plan].daily,
    usedToday: getUsage(u.id),
  };
}

export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: 'سجّل الدخول أولًا' });
  try {
    const { uid } = jwt.verify(token, SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
    if (!user) return res.status(401).json({ error: 'الجلسة غير صالحة' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'انتهت الجلسة، سجّل الدخول من جديد' });
  }
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات كتير، جرّب بعد شوية' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const authRouter = Router();

authRouter.post('/register', authLimiter, (req, res) => {
  const { email, password, name } = req.body || {};
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim()) || email.length > 200)
    return res.status(400).json({ error: 'البريد الإلكتروني غير صحيح' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 200)
    return res.status(400).json({ error: 'كلمة المرور لازم تكون 8 أحرف على الأقل' });
  const cleanName = (typeof name === 'string' && name.trim() ? name.trim() : email.split('@')[0]).slice(0, 60);
  const em = email.trim().toLowerCase();
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(em))
    return res.status(409).json({ error: 'البريد ده مسجّل بالفعل' });
  const hash = bcrypt.hashSync(password, 11);
  const info = db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?,?,?)').run(em, cleanName, hash);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  res.cookie(COOKIE, jwt.sign({ uid: user.id }, SECRET, { expiresIn: '30d' }), cookieOpts);
  res.json({ user: publicUser(user) });
});

authRouter.post('/login', authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string')
    return res.status(400).json({ error: 'أدخل البريد وكلمة المرور' });
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'البريد أو كلمة المرور غير صحيحة' });
  res.cookie(COOKIE, jwt.sign({ uid: user.id }, SECRET, { expiresIn: '30d' }), cookieOpts);
  res.json({ user: publicUser(user) });
});

authRouter.post('/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

export { publicUser };
