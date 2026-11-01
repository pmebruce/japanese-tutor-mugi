import { describe, it, expect, vi } from 'vitest';
import worker, { handleApi, prepareCall, UsageLimiter, type Storage } from './index';

const code = 'example-personal-code';
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
  method: body === undefined ? 'GET' : 'POST', headers: { 'X-Mugi-Pair': code, 'Content-Type': 'application/json', ...extra },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const chat = { messages: [{ role: 'user', content: '今日は学校に行きました。' }] };
function upstream(text: string, complete = true) {
  return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n` +
    (complete ? `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 50, output_tokens: 20 } } })}\n\n` : ''),
    { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('private mobile API', () => {
  it('fails closed for pages and API without verified Cloudflare Access, including forged headers', async () => {
    const env = environment();
    for (const path of ['/', '/assets/app.js', '/api/chat/status']) {
      const r = await worker.fetch(request(path, undefined, { 'Cf-Access-Jwt-Assertion': 'forged', 'oai-authenticated-user-email': 'owner@example.com' }), env);
      expect(r.status).toBe(403);
    }
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });
  it('rejects missing usage code and missing server secrets without contacting OpenAI', async () => {
    const env = environment(); const transport = vi.fn();
    expect((await handleApi(new Request('https://mugi.example/api/chat/status'), env, transport)).status).toBe(403);
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
