import { SignJWT, jwtVerify } from 'jose';

const COOKIE = '__Host-mugi-session';
const AGE = 30 * 24 * 60 * 60;
export const privateHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
export const passwordConfigured = (password?: string): password is string => !!password && password.length >= 16 && password.length <= 128;
const sessionKey = async (password: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`mugi-session-v1:${password}`)));
export async function createSession(password: string, origin: string): Promise<string> {
  return new SignJWT({}).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject('owner')
    .setIssuer('mugi-mobile').setAudience(origin).setIssuedAt().setExpirationTime(`${AGE}s`).sign(await sessionKey(password));
}
export async function sessionAuthorized(req: Request, password?: string): Promise<boolean> {
  if (!passwordConfigured(password)) return false;
  const cookies = (req.headers.get('Cookie') ?? '').split(';').map(s => s.trim());
  const matches = cookies.filter(s => s.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) return false;
  const token = matches[0].slice(COOKIE.length + 1);
  if (token.length > 2048) return false;
  try {
    await jwtVerify(token, await sessionKey(password), { issuer: 'mugi-mobile', audience: new URL(req.url).origin,
      subject: 'owner', algorithms: ['HS256'], requiredClaims: ['exp', 'iat', 'sub'], maxTokenAge: `${AGE}s` });
    return true;
  } catch { return false; }
}
export function sameOrigin(req: Request): boolean {
  return req.headers.get('Origin') === new URL(req.url).origin && req.headers.get('Sec-Fetch-Site') !== 'cross-site';
}
export function sessionCookie(token: string, clear = false): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${clear ? 0 : AGE}`;
}
export async function passwordMatches(received: string, password: string): Promise<boolean> {
  const hash = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([hash(received), hash(password)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
// No app scripts/assets, password or API key are included in the public login page.
export function loginPage(message = '', status = 200): Response {
  const safe = message.replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s]!);
  return new Response(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mugi 私人日語家教</title>
<style>body{margin:0;background:#f7f4ed;color:#302c25;font:18px system-ui,-apple-system,sans-serif;min-height:100dvh;display:grid;place-items:center}main{box-sizing:border-box;width:min(90%,420px);padding:30px 24px;background:white;border-radius:24px;box-shadow:0 8px 32px #302c2512}h1{font-size:28px;margin:0 0 10px}p{line-height:1.7;color:#696357}label{display:block;margin-top:24px}input,button{box-sizing:border-box;width:100%;min-height:52px;font:inherit;border-radius:12px;margin-top:12px}input{padding:12px;border:1px solid #aaa}button{background:#375c47;color:white;border:0;font-weight:700}.error{color:#a02727}</style>
<main><h1>Mugi 私人日語家教</h1><p>輸入你的私人密碼，開始練日語。</p>${safe ? `<p class="error" role="alert">${safe}</p>` : ''}<form method="post" action="/auth/login"><label for="password">私人密碼</label><input id="password" name="password" type="password" required minlength="16" maxlength="128" autocomplete="current-password" autocapitalize="none" spellcheck="false"><button type="submit">登入</button></form><p>這台裝置會保持登入 30 天。請勿分享密碼。</p></main></html>`, { status, headers: { ...privateHeaders, 'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" } });
}
/** Read bounded form bytes even when Content-Length is missing or false. */
export async function readPassword(req: Request): Promise<string> {
  if (!(req.headers.get('Content-Type') ?? '').startsWith('application/x-www-form-urlencoded')) throw new Error('format');
  const reader = req.body?.getReader();
  if (!reader) throw new Error('empty');
  let text = ''; let size = 0; const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2048) { await reader.cancel(); throw new Error('large'); }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  const fields = new URLSearchParams(text);
  if (fields.getAll('password').length !== 1) throw new Error('format');
  const password = fields.get('password')!;
  if (password.length > 128) throw new Error('large');
  return password;
}
