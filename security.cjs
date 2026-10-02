'use strict';
const crypto = require('node:crypto');

class AppError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
function safeEqual(a, b) {
  const left = Buffer.from(String(a || '')), right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}
function headers(res) {
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}
function authorizeSource(req, origin) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw new AppError('LOOPBACK_ONLY', 403);
  if (req.headers.host !== new URL(origin).host) throw new AppError('INVALID_HOST', 403);
  if (req.headers.origin && req.headers.origin !== origin) throw new AppError('INVALID_ORIGIN', 403);
  if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) throw new AppError('CROSS_SITE_BLOCKED', 403);
}
function authorize(req, origin, session, mutation = false) {
  authorizeSource(req, origin);
  if (!safeEqual(req.headers['x-mmm-session'], session)) throw new AppError('SESSION_REQUIRED', 401);
  if (mutation && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AppError('JSON_REQUIRED', 415);
}
async function readBody(req, limit = 256 * 1024) {
  if (Number(req.headers['content-length']) > limit) { req.resume(); throw new AppError('REQUEST_TOO_LARGE', 413); }
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) { chunks.length = 0; throw new AppError('REQUEST_TOO_LARGE', 413); }
    chunks.push(chunk);
  }
  try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || Array.isArray(body) || typeof body !== 'object') throw Error();
    return body;
  } catch { throw new AppError('INVALID_JSON'); }
}
function text(value, max = 16000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new AppError('INVALID_TEXT');
  return value.trim();
}
function id(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new AppError('INVALID_ID'); return value; }
function json(res, status, body) { headers(res); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
module.exports = { AppError, safeEqual, headers, authorizeSource, authorize, readBody, text, id, json };
