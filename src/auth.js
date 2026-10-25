import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_DAYS = 30;
const COOKIE = 'gr_sid';

export function hashPassword(password) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), 64);
  return timingSafeEqual(expected, actual);
}

export async function createSession(db, res, userId) {
  const id = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await db.prepare('INSERT INTO sessions (id, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)')
    .run(id, userId, randomBytes(18).toString('base64url'), expires.toISOString());
  res.cookie(COOKIE, id, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', expires, path: '/'
  });
}

export async function destroySession(db, req, res) {
  const id = req.cookies[COOKIE];
  if (id) await db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  res.clearCookie(COOKIE, { path: '/' });
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Loads req.user, req.csrf and req.unread (unread notifications), and rejects form posts
// without a matching CSRF token.
export function sessionMiddleware(db) {
  return async (req, res, next) => {
    req.cookies = parseCookies(req.headers.cookie);
    const session = req.cookies[COOKIE] && await db.prepare(
      "SELECT s.csrf, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?"
    ).get(req.cookies[COOKIE], new Date().toISOString());
    req.user = session ? { ...session, csrf: undefined } : null;
    req.csrf = session?.csrf ?? null;
    req.unread = req.user
      ? (await db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id)).n
      : 0;
    res.locals.user = req.user;
    res.locals.csrf = req.csrf;
    if (req.method === 'POST' && req.user && !req.path.startsWith('/payments/notify')) {
      const sent = req.body?._csrf ?? req.headers['x-csrf-token'];
      if (sent !== req.csrf) return res.status(403).send('Your session expired. Go back, refresh the page and try again.');
    }
    next();
  };
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    if (!roles.includes(req.user.role)) return res.status(403).send('This page is not available for your account.');
    next();
  };
}

export function homeFor(user) {
  return { passenger: '/passenger', driver: '/driver', admin: '/admin', business: '/business' }[user.role];
}
