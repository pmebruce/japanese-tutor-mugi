// Cloudflare backend for the personal mobile edition. No API key reaches the browser.
import { systemPrompt, reminderPrompt, JUDGE_PROMPT, TIP_FIX_SYSTEM, LOOKUP_SYSTEM, defaultPersona } from '../server/prompts.ts';
import { CHAT_REPLY_SCHEMA, JUDGE_SCHEMA, TIP_FIX_SCHEMA, LOOKUP_SCHEMA } from './schemas.ts';
import { readSSE } from '../server/llm/openaiProvider.ts';
import { nameText, personaText } from '../src/game/claudeProtocol.ts';
import { createSession, sessionAuthorized, sessionCookie, sameOrigin, passwordConfigured, passwordMatches, loginPage, readPassword, privateHeaders } from './passwordAuth.ts';

export interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  transaction<T>(f: (s: Storage) => Promise<T>): Promise<T>;
}
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  OPENAI_API_KEY?: string;
  MUGI_ACCESS_CODE?: string;
  OPENAI_MODEL?: string;
  MUGI_DAILY_REQUESTS?: string;
  USAGE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
}
type Ledger = { day: string; requests: number; minute: number; minuteRequests: number; inputTokens: number; outputTokens: number };
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
const error = (message: string, status = 400) => json({ ok: false, message }, status);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
const dailyLimit = (env: Env) => Math.max(1, Math.min(1000, Number(env.MUGI_DAILY_REQUESTS) || 100));
/** One durable, transactionally reserved quota for this personal installation. Restarts do not reset it. */
export class UsageLimiter {
  constructor(private state: { storage: Storage }) {}
  async fetch(req: Request): Promise<Response> {
    const body = await req.json() as { action: string; ip?: string; limit?: number; inputTokens?: number; outputTokens?: number };
    return this.state.storage.transaction(async storage => {
      if (body.action === 'login') {
        const now = Date.now();
        const recent = (await storage.get<{ ip: string; at: number }[]>('loginAttempts') ?? []).filter(a => now - a.at < 15 * 60000);
        if (recent.length >= 60 || recent.filter(a => a.ip === body.ip).length >= 8) return error('登入嘗試太頻繁，請等 15 分鐘再試。', 429);
        recent.push({ ip: body.ip ?? 'unknown', at: now });
        await storage.put('loginAttempts', recent);
        return json({ ok: true });
      }
      const old = await storage.get<Ledger>('ledger');
      const minute = Math.floor(Date.now() / 60000);
      const data: Ledger = old?.day === today() ? old : { day: today(), requests: 0, minute, minuteRequests: 0, inputTokens: 0, outputTokens: 0 };
      if (data.minute !== minute) { data.minute = minute; data.minuteRequests = 0; }
      if (body.action === 'reserve') {
        if (data.requests >= (body.limit ?? 100)) return error('今天的 AI 使用次數已達上限，台灣時間午夜重計。', 429);
        if (data.minuteRequests >= 12) return error('操作太快，請稍候一分鐘再試。', 429);
        data.requests++; data.minuteRequests++;
      } else if (body.action === 'record') {
        data.inputTokens += Math.max(0, Number(body.inputTokens) || 0);
        data.outputTokens += Math.max(0, Number(body.outputTokens) || 0);
      }
      await storage.put('ledger', data);
      return json(data);
    });
  }
}

async function usage(env: Env, action: string, extra = {}): Promise<Response> {
  const stub = env.USAGE.get(env.USAGE.idFromName('personal-mobile'));
  return stub.fetch(new Request('https://usage.internal/', { method: 'POST', body: JSON.stringify({ action, limit: dailyLimit(env), ...extra }) }));
}
function textField(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || [...value].length > max) throw new Error(`請檢查輸入內容（${key}）。`);
  return value.trim();
}
export function prepareCall(path: string, body: Record<string, unknown>) {
  if (path === '/api/chat') {
    if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 40) throw new Error('對話內容格式不正確。');
    const input = body.messages.map(raw => {
      if (!raw || typeof raw !== 'object') throw new Error('對話內容格式不正確。');
      const m = raw as Record<string, unknown>;
      if (!['user', 'assistant'].includes(String(m.role))) throw new Error('對話角色不正確。');
      return { role: m.role as 'user' | 'assistant', content: textField(m, 'content', 2000) };
    });
    // Limit context as well as the final answer; a client cannot submit an unbounded history.
    if (input.reduce((n, m) => n + [...m.content].length, 0) > 24000) throw new Error('對話太長，請開啟新的對話。');
    const persona = typeof body.persona === 'string' ? personaText(body.persona) : undefined;
    const name = typeof body.name === 'string' ? nameText(body.name) : undefined;
    if ((persona?.length ?? 0) > 400 || (name?.length ?? 0) > 16) throw new Error('人物設定太長。');
    return { instructions: systemPrompt('Mugi', persona, name) + '\n' + reminderPrompt(), input, schema: CHAT_REPLY_SCHEMA, name: 'mugi_reply' };
  }
  if (path === '/api/lookup') return { instructions: LOOKUP_SYSTEM, input: [{ role: 'user', content: textField(body, 'q', 1000) }], schema: LOOKUP_SCHEMA, name: 'mugi_lookup' };
  if (path === '/api/chat/judge') return { instructions: JUDGE_PROMPT, input: [{ role: 'user', content: JSON.stringify({ target: textField(body, 'target', 1000), said: textField(body, 'said', 1000) }) }], schema: JUDGE_SCHEMA, name: 'mugi_judge' };
  if (path === '/api/chat/fix-tip') return { instructions: TIP_FIX_SYSTEM, input: [{ role: 'user', content: textField(body, 'tip', 2000) }], schema: TIP_FIX_SCHEMA, name: 'mugi_tip' };
  throw new Error('沒有這個功能。');
}
function upstreamMessage(status: number, code?: string): string {
  if (['insufficient_quota', 'credit_balance_exhausted', 'billing_hard_limit_reached', 'usage_limit_reached'].includes(code ?? '')) return 'OpenAI API 尚無可用額度，請到 Platform 加值或檢查帳單設定。Plus 月費不包含 API 用量。';
  if (code === 'invalid_api_key' || status === 401 || status === 403) return 'AI 連線設定需要更新，請由擁有者檢查 Cloudflare Secret。';
  if (['model_not_found', 'invalid_json_schema', 'unsupported_value', 'unsupported_parameter'].includes(code ?? '')) return 'AI 模型或回覆格式設定不相容，請檢查模型設定。';
  if (code === 'rate_limit_exceeded' || status === 429) return 'AI 目前額度不足或請求太頻繁，請稍後再試。';
  return 'AI 暫時無法回應，請稍後再試。';
}

class MobileStreamError extends Error {}
function streamEventError(ev: Record<string, unknown>): MobileStreamError {
  const response = ev.response as { error?: { code?: string }; incomplete_details?: { reason?: string } } | undefined;
  const nested = ev.error as { code?: string } | undefined;
  const code = response?.error?.code || nested?.code || (typeof ev.code === 'string' ? ev.code : undefined);
  if (response?.incomplete_details?.reason === 'max_output_tokens') return new MobileStreamError('AI 回覆太長，超過本次輸出上限。請改問較短的問題。');
  return new MobileStreamError(code ? upstreamMessage(0, code) : 'AI 服務回傳未完成的回覆，請稍後再試。');
}

export async function handleApi(req: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (!env.OPENAI_API_KEY || !passwordConfigured(env.MUGI_ACCESS_CODE)) return error('手機版尚未完成連線設定，請先設定 API 金鑰與至少 16 字的私人密碼。', 503);
  const origin = req.headers.get('Origin');
  if ((origin && origin !== new URL(req.url).origin) || req.headers.get('Sec-Fetch-Site') === 'cross-site') return error('不接受跨網站請求。', 403);
  if (!await sessionAuthorized(req, env.MUGI_ACCESS_CODE)) return json({ error: 'login_required', message: '登入已到期，請重新登入。' }, 401);
  const model = env.OPENAI_MODEL || 'gpt-4.1-mini';
  if (req.method === 'GET') {
    if (path === '/api/chat/status') return json({ ok: true, model, personas: { Mugi: defaultPersona('Mugi') } });
    if (path === '/api/openai/status') return json({ signedIn: false, planEnabled: false, models: [], apiMode: true });
    if (path === '/api/tts/status') return json({ azure: false, google: false, voicevox: false, voices: { azure: { zh: [], ja: [] }, google: { zh: [], ja: [] }, voicevox: { zh: [], ja: [] } } });
    if (path === '/api/mobile/status') { const r = await usage(env, 'status'); return json({ ...await r.json() as object, limit: dailyLimit(env), model }); }
    return error('沒有這個功能。', 404);
  }
  if (req.method !== 'POST') return error('不支援此操作。', 405);
  if (!['/api/chat', '/api/lookup', '/api/chat/judge', '/api/chat/fix-tip'].includes(path)) return error('手機版不提供這個電腦端設定。', 404);
  if (!(req.headers.get('Content-Type') ?? '').startsWith('application/json')) return error('請使用 JSON 格式。', 415);
  let call: ReturnType<typeof prepareCall>;
  try {
    // Incremental byte limit stops clients with missing or dishonest Content-Length.
    const reader = req.body?.getReader();
    if (!reader) return error('沒有輸入內容。');
    let size = 0; let raw = ''; const decoder = new TextDecoder();
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 128000) { await reader.cancel(); return error('輸入內容太長。', 413); } raw += decoder.decode(value, { stream: true }); }
    raw += decoder.decode();
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return error('輸入格式不正確。');
    call = prepareCall(path, body);
  } catch (e) { return error(e instanceof SyntaxError ? '輸入格式不正確。' : e instanceof Error ? e.message : '請檢查輸入內容。'); }
  const reserved = await usage(env, 'reserve');
  if (!reserved.ok) return reserved;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  const cancel = () => controller.abort();
  req.signal.addEventListener('abort', cancel, { once: true });
  if (req.signal.aborted) controller.abort();
  let response: Response;
  try {
    response = await fetcher('https://api.openai.com/v1/responses', {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, instructions: call.instructions, input: call.input, store: false, stream: true,
        max_output_tokens: 1600, ...(model.startsWith('gpt-5') ? { reasoning: { effort: 'low' } } : {}),
        text: { format: { type: 'json_schema', name: call.name, strict: true, schema: call.schema } } }),
    });
  } catch { clearTimeout(timeout); req.signal.removeEventListener('abort', cancel); return error('連線逾時或中斷，請稍後再試。', 504); }
  if (!response.ok) {
    clearTimeout(timeout); req.signal.removeEventListener('abort', cancel);
    const body = await response.json().catch(() => ({})) as { error?: { code?: string } };
    return error(upstreamMessage(response.status, body.error?.code), response.status === 429 ? 429 : 502);
  }
  const streamMessage = (e: unknown): string => e instanceof MobileStreamError ? e.message : controller.signal.aborted ? 'AI 回覆逾時或連線已取消，請稍後再試。' : 'AI 回覆中斷或格式不完整，請再試一次。';
  async function collect(onDelta: (s: string) => void): Promise<string> {
    let result = ''; let completed = false;
    try {
      for await (const ev of readSSE(response.body)) {
        if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') { result += ev.delta; onDelta(ev.delta); }
        if (ev.type === 'response.completed') {
          const r = ev.response as { usage?: { input_tokens?: number; output_tokens?: number } };
          completed = true;
          await usage(env, 'record', { inputTokens: r?.usage?.input_tokens, outputTokens: r?.usage?.output_tokens });
        }
        if (['error', 'response.failed', 'response.incomplete'].includes(String(ev.type))) throw streamEventError(ev);
        if (ev.type === 'response.refusal.delta') throw new MobileStreamError('AI 無法回答這個內容，請換個日語練習問題。');
      }
      if (!completed || !result) throw new Error('AI 連線中斷，請再試一次。');
      JSON.parse(result); // Incomplete JSON is never reported as a successful answer.
      return result;
    } finally { clearTimeout(timeout); req.signal.removeEventListener('abort', cancel); }
  }
  if (path === '/api/chat') {
    const encoder = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(sink) {
        const send = (value: unknown) => { if (!closed) sink.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); };
        try { const result = await collect(text => send({ type: 'delta', text })); send({ type: 'done', text: result }); }
        catch (e) { send({ type: 'error', message: streamMessage(e) }); }
        finally { if (!closed) { closed = true; sink.close(); } }
      },
      cancel() { closed = true; controller.abort(); },
    });
    return new Response(stream, { headers: { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8' } });
  }
  try {
    const raw = await collect(() => {}); const answer = JSON.parse(raw);
    return path === '/api/lookup' ? json({ ok: true, answer, raw }) : path === '/api/chat/fix-tip' ? json({ ok: true, tip: answer.tip }) : json(answer);
  } catch (e) { return error(streamMessage(e), 502); }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const path = new URL(req.url).pathname;
      if (!passwordConfigured(env.MUGI_ACCESS_CODE)) return new Response('私人日語家教尚未設定完成，請擁有者在 Cloudflare 設定至少 16 字的 MUGI_ACCESS_CODE Secret。', { status: 503, headers: { ...privateHeaders, 'Content-Type': 'text/plain; charset=utf-8' } });
      if (path === '/auth/login') {
        if (req.method === 'GET') return loginPage();
        if (req.method !== 'POST') return error('不支援此操作。', 405);
        if (!sameOrigin(req)) return loginPage('登入頁已更新，請重新整理後再登入。', 403);
        // Cloudflare supplies CF-Connecting-IP; never trust client X-Forwarded-For.
        const ip = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(req.headers.get('CF-Connecting-IP') ?? 'unknown'))), b => b.toString(16).padStart(2, '0')).join('');
        const allowed = await usage(env, 'login', { ip });
        if (!allowed.ok) return loginPage('登入嘗試太頻繁，請等 15 分鐘再試。', 429);
        let password: string;
        try { password = await readPassword(req); } catch { return loginPage('請檢查密碼格式。', 400); }
        if (!await passwordMatches(password, env.MUGI_ACCESS_CODE)) return loginPage('密碼不正確，請再試一次。', 401);
        const token = await createSession(env.MUGI_ACCESS_CODE, new URL(req.url).origin);
        return new Response(null, { status: 303, headers: { ...privateHeaders, Location: '/', 'Set-Cookie': sessionCookie(token) } });
      }
      if (path === '/auth/logout') {
        if (req.method !== 'POST') return error('不支援此操作。', 405);
        if (!sameOrigin(req)) return error('不接受跨網站請求。', 403);
        return new Response(null, { status: 303, headers: { ...privateHeaders, Location: '/auth/login', 'Set-Cookie': sessionCookie('', true) } });
      }
      if (!await sessionAuthorized(req, env.MUGI_ACCESS_CODE)) {
        if (path.startsWith('/api/')) return json({ error: 'login_required', message: '請先登入。' }, 401);
        if (req.method === 'GET' && req.headers.get('Sec-Fetch-Dest') === 'document') return new Response(null, { status: 303, headers: { ...privateHeaders, Location: '/auth/login' } });
        return loginPage('', 401);
      }
      if (path.startsWith('/api/')) return await handleApi(req, env);
      const response = await env.ASSETS.fetch(req);
      const secured = new Response(response.body, response);
      for (const [name, value] of Object.entries(privateHeaders)) secured.headers.set(name, value);
      return secured;
    } catch { return error('服務暫時無法使用，請稍後再試。', 503); }
  },
};
