import { describe, it, expect, vi } from 'vitest';
import worker, { handleApi, prepareCall, UsageLimiter, type Storage } from './index';

import { createSession } from './passwordAuth';

const code = 'example-personal-code';
const token = await createSession(code, 'https://mugi.example');
function environment() {
  const records = new Map<string, unknown>();
  let lock: Promise<unknown> = Promise.resolve();
  const storage: Storage = {
    async get<T>(key: string) { return records.get(key) as T | undefined; },
    async put(key: string, value: unknown) { records.set(key, structuredClone(value)); },
    transaction<T>(f: (s: Storage) => Promise<T>): Promise<T> {
      const result = lock.then(() => f(storage)); lock = result.catch(() => {}); return result;
    },
  };
  const limiter = new UsageLimiter({ storage });
  return {
    ASSETS: { fetch: vi.fn(async () => new Response('app')) },
    OPENAI_API_KEY: 'dummy-test-only', MUGI_ACCESS_CODE: code,
    USAGE: { idFromName: () => 'single-owner', get: () => ({ fetch: (req: Request) => limiter.fetch(req) }) },
  };
}
const request = (path: string, body?: unknown, extra: Record<string, string> = {}) => new Request(`https://mugi.example${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { Cookie: `__Host-mugi-session=${token}`, 'Content-Type': 'application/json', ...extra },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const chat = { messages: [{ role: 'user', content: '今日は学校に行きました。' }] };
function upstream(text: string, complete = true) {
  return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n` +
    (complete ? `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 50, output_tokens: 20 } } })}\n\n` : ''),
    { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('private mobile API', () => {
  it('fails closed for pages and API without session, including forged identity and old pairing headers', async () => {
    const env = environment();
    for (const path of ['/', '/assets/app.js', '/api/chat/status']) {
      const r = await worker.fetch(request(path, undefined, { Cookie: '', 'Cf-Access-Jwt-Assertion': 'forged', 'X-Mugi-Pair': code }), env);
      expect(r.status).toBe(401);
    }
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });
  it('rejects missing session and missing server secrets without contacting OpenAI', async () => {
    const env = environment(); const transport = vi.fn();
    expect((await handleApi(new Request('https://mugi.example/api/chat/status'), env, transport)).status).toBe(401);
    expect((await handleApi(request('/api/chat', chat), { ...env, OPENAI_API_KEY: '' }, transport)).status).toBe(503);
    expect(transport).not.toHaveBeenCalled();
  });
  it('rejects cross-origin requests, malformed messages, and excessive context before reserving quota', async () => {
    const env = environment(); const transport = vi.fn();
    expect((await handleApi(request('/api/chat', chat, { Origin: 'https://elsewhere.example' }), env, transport)).status).toBe(403);
    for (const messages of [[{ role: 'system', content: 'bypass' }], [{ role: 'user', content: 'x'.repeat(2001) }], Array.from({ length: 20 }, () => ({ role: 'user', content: 'x'.repeat(1500) }))]) {
      expect((await handleApi(request('/api/chat', { messages }), env, transport)).status).toBe(400);
    }
    const status = await (await handleApi(request('/api/mobile/status'), env)).json();
    expect(status.requests).toBe(0); expect(transport).not.toHaveBeenCalled();
  });
  it('enforces one durable daily quota even for concurrent requests', async () => {
    const env = { ...environment(), MUGI_DAILY_REQUESTS: '2' };
    const transport = vi.fn(async () => upstream('{"ok":true,"feedback":"正確"}'));
    const result = await Promise.all(Array.from({ length: 7 }, () => handleApi(request('/api/chat/judge', { target: '学校', said: 'がっこう' }), env, transport)));
    expect(result.filter(r => r.status === 200)).toHaveLength(2);
    expect(result.filter(r => r.status === 429)).toHaveLength(5);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('streams chat in the existing frontend protocol; never reveals the API key', async () => {
    const env = environment(); const answer = JSON.stringify({ segments: [{ lang: 'ja', text: 'こんにちは。', gloss: '你好。' }], tip: '', tone: 'greet' });
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      expect(sent.model).toBe('gpt-4.1-mini'); expect(sent.store).toBe(false); expect(sent.max_output_tokens).toBe(1600);
      return upstream(answer);
    });
    const response = await handleApi(request('/api/chat', chat), env, transport);
    const text = await response.text();
    expect(text).toContain('"type":"delta"'); expect(text).toContain('"type":"done"'); expect(text).not.toContain(env.OPENAI_API_KEY);
  });
  it('does not mark a dropped or malformed response successful', async () => {
    for (const [text, complete] of [['{', true], ['{}', false]] as const) {
      const r = await handleApi(request('/api/chat', chat), environment(), vi.fn(async () => upstream(text, complete)));
      const body = await r.text(); expect(body).toContain('"type":"error"'); expect(body).not.toContain('"type":"done"');
    }
  });
  it('returns actionable billing errors and ignores client model overrides', async () => {
    const transport = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ error: { code: 'insufficient_quota' } }, { status: 429 }));
    const r = await handleApi(request('/api/chat', { ...chat, model: 'expensive', openaiModel: 'expensive' }), environment(), transport);
    expect(r.status).toBe(429); expect((await r.json()).message).toContain('Plus');
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).model).toBe('gpt-4.1-mini');
  });
  it('does not claim API mode is a logged-in ChatGPT subscription', async () => {
    const r = await handleApi(request('/api/openai/status'), environment());
    expect(await r.json()).toMatchObject({ signedIn: false, planEnabled: false, apiMode: true });
  });
  it('keeps lookup and correction schemas separate', () => {
    expect(prepareCall('/api/lookup', { q: '你好怎麼說' }).name).toBe('mugi_lookup');
    expect(prepareCall('/api/chat/fix-tip', { tip: '修正' }).name).toBe('mugi_tip');
  });
});

const loginRequest = (password: string, origin = 'https://mugi.example') => new Request('https://mugi.example/auth/login', {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '192.0.2.1' },
  body: new URLSearchParams({ password }),
});
describe('private password login', () => {
  it('serves only a password form before login and fails closed if unconfigured', async () => {
    const env = environment();
    const page = await worker.fetch(new Request('https://mugi.example/'), env);
    expect(await page.text()).toContain('action="/auth/login"');
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    const setup = await worker.fetch(new Request('https://mugi.example/'), { ...env, MUGI_ACCESS_CODE: '' });
    expect(setup.status).toBe(503);
  });
  it('issues a protected cookie, unlocks assets and API, and clears it on logout', async () => {
    const env = environment();
    const login = await worker.fetch(loginRequest(code), env);
    expect(login.status).toBe(303);
    const cookie = login.headers.get('Set-Cookie')!;
    expect(cookie).toContain('HttpOnly; Secure; SameSite=Strict');
    expect(cookie).not.toContain(code);
    const authHeaders = { Cookie: cookie.split(';')[0] };
    const page = await worker.fetch(new Request('https://mugi.example/', { headers: authHeaders }), env);
    expect(await page.text()).toBe('app');
    expect(page.headers.get('Cache-Control')).toContain('no-store');
    const status = await worker.fetch(new Request('https://mugi.example/api/mobile/status', { headers: authHeaders }), env);
    expect(status.status).toBe(200);
    const logout = await worker.fetch(new Request('https://mugi.example/auth/logout', { method: 'POST', headers: { ...authHeaders, Origin: 'https://mugi.example' } }), env);
    expect(logout.status).toBe(303); expect(logout.headers.get('Set-Cookie')).toContain('Max-Age=0');
    const after = await worker.fetch(new Request('https://mugi.example/api/mobile/status'), env);
    expect(after.status).toBe(401);
    expect(after.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  });
  it('rejects wrong passwords, forged, expired, wrong-site and rotated-password sessions', async () => {
    const env = environment();
    expect((await worker.fetch(loginRequest('wrong-password-123'), env)).status).toBe(401);
    const { SignJWT } = await import('jose');
    const key = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`mugi-session-v1:${code}`)));
    const expired = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject('owner').setIssuer('mugi-mobile').setAudience('https://mugi.example').setIssuedAt(1).setExpirationTime(2).sign(key);
    for (const bad of ['forged', token.slice(0, -5) + 'abcde', expired, await createSession(code, 'https://other.example')]) {
      expect((await worker.fetch(request('/api/chat/status', undefined, { Cookie: `__Host-mugi-session=${bad}` }), env)).status).toBe(401);
    }
    expect((await worker.fetch(request('/api/chat/status'), { ...env, MUGI_ACCESS_CODE: 'new-private-password-123' })).status).toBe(401);
  });
  it('blocks cross-site login/logout and bounds submitted form bytes', async () => {
    const env = environment();
    expect((await worker.fetch(loginRequest(code, 'https://attacker.example'), env)).status).toBe(403);
    expect((await worker.fetch(new Request('https://mugi.example/auth/logout', { method: 'POST', headers: { Origin: 'https://attacker.example' } }), env)).status).toBe(403);
    expect((await worker.fetch(loginRequest('x'.repeat(4000)), env)).status).toBe(400);
    const login = await worker.fetch(new Request('https://mugi.example/auth/login'), env);
    expect(login.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    // Native form submissions need a real same-origin Origin for the CSRF check.
    expect(login.headers.get('Referrer-Policy')).toBe('same-origin');
  });
  it('limits concurrent login guesses durably and allows login after the window expires', async () => {
    const env = environment();
    try {
      vi.useFakeTimers();
      const attempts = await Promise.all(Array.from({ length: 12 }, () => worker.fetch(loginRequest('wrong-password-123'), env)));
      expect(attempts.filter(r => r.status === 429)).toHaveLength(4);
      expect((await worker.fetch(loginRequest(code), env)).status).toBe(429);
      vi.setSystemTime(Date.now() + 16 * 60000);
      expect((await worker.fetch(loginRequest(code), env)).status).toBe(303);
    } finally { vi.useRealTimers(); }
  });
});

describe('upstream failures after HTTP 200', () => {
  const failed = (ev: unknown) => vi.fn(async () => new Response(`data: ${JSON.stringify(ev)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }));
  it('preserves streamed credit failures for chat and lookup without exposing upstream secrets', async () => {
    for (const event of [
      { type: 'error', code: 'insufficient_quota', message: 'secret-upstream-details' },
      { type: 'response.failed', response: { error: { code: 'credit_balance_exhausted', message: 'secret-upstream-details' } } },
      { type: 'error', error: { code: 'billing_hard_limit_reached' } },
    ]) {
      for (const [path, body] of [['/api/chat', chat], ['/api/lookup', { q: '你好' }]] as const) {
        const response = await handleApi(request(path, body), environment(), failed(event));
        const text = await response.text();
        expect(text).toContain('API 尚無可用額度'); expect(text).toContain('Plus');
        expect(text).not.toContain('secret-upstream-details'); expect(text).not.toContain('"type":"done"');
      }
    }
  });
  it('distinguishes stream rate limits and output length limits from missing credits', async () => {
    for (const [event, message] of [
      [{ type: 'error', code: 'rate_limit_exceeded' }, '請求太頻繁'],
      [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }, '超過本次輸出上限'],
    ] as const) {
      const response = await handleApi(request('/api/chat', chat), environment(), failed(event));
      expect(await response.text()).toContain(message);
    }
  });
});
