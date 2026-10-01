#!/usr/bin/env node
// jaso 운영자 구독 서버: 정적 파일을 내주고, /api/sample 요청을 운영자의 claude.ai 구독으로
// Claude Code CLI(`claude -p`, headless)를 띄워 중계한다. API 키는 쓰지 않는다.
// 실행: node jaso/server/server.mjs  (설정은 환경 변수, 목록은 README 참고)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cleanModelText } from '../src/text.js';
import {
  parseConfig, flattenInput, buildArgs, childEnv, spawnSpec, createStreamParser, classifyFailure,
  pickText, modelIdFrom, usageFrom, checkAuth, keyDigest, createRateLimiter, resolveStatic, mimeFor,
  clientIp, makeFailure, RequestError, SYSTEM_PROMPT, TIER_NAMES,
} from './lib.mjs';

const SEC_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
});
const JSON_TYPE = 'application/json; charset=utf-8';
const RECHECK_INTERVAL_MS = 5 * 60 * 1000;
const PING_INTERVAL_MS = 15000;
const KILL_GRACE_MS = 3000;
const STDERR_CAP = 8192;

export function createApp(cfg, { env = process.env, log = createLogger(cfg.logLevel) } = {}) {
  const digest = cfg.accessKey ? keyDigest(cfg.accessKey) : null;
  const authMode = cfg.accessKey ? 'key' : 'open';
  const sampleLimiter = createRateLimiter(cfg.rateLimit);
  const authFailLimiter = createRateLimiter(cfg.authFailLimit);
  const spec = spawnSpec(cfg.claudeBin);
  const children = new Set();
  const queue = { active: 0, waiting: [] };
  const loginState = { ok: null, method: '', checkedAt: 0, detail: '', rechecking: null };
  let usageWindow = null;
  let shuttingDown = false;

  // ───────────── 자식 CLI 실행 ─────────────

  /**
   * CLI 한 번 실행. 프롬프트는 stdin으로 넘긴다(프로세스 목록에 노출되지 않도록).
   * @returns {{ promise: Promise<object>, kill: Function }}
   */
  function runClaude(args, { input = '', timeoutMs, firstOutputTimeoutMs, onEvent, collectStdout = false } = {}) {
    let child;
    let killTimer = null;
    let firstTimer = null;
    let totalTimer = null;
    let timedOut = false;
    let settled = false;
    let stderr = '';
    let stdoutText = '';
    let accumulated = '';
    let result = null;
    let lastRateLimit = null;
    let spawnError = null;
    const parser = createStreamParser();

    const kill = () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill('SIGTERM'); } catch { /* 이미 종료됨 */ }
      if (!killTimer) {
        killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 무시 */ } }, KILL_GRACE_MS);
        killTimer.unref();
      }
    };

    const promise = new Promise((resolve) => {
      const finish = (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(firstTimer);
        clearTimeout(totalTimer);
        clearTimeout(killTimer);
        if (child) children.delete(child);
        for (const ev of parser.end()) handle(ev);
        resolve({ result, text: accumulated, stderr, stdout: stdoutText, exitCode, signal, lastRateLimit, timedOut, spawnError });
      };
      const handle = (ev) => {
        if (ev.type === 'first_output') clearTimeout(firstTimer);
        else if (ev.type === 'delta') accumulated += ev.text;
        else if (ev.type === 'rateLimit') lastRateLimit = ev.info;
        else if (ev.type === 'result') result = ev.result;
        try { onEvent?.(ev); } catch (err) { log.error('이벤트 처리 오류', err?.message); }
      };

      try {
        child = spawn(spec.cmd, [...spec.prefix, ...args], { cwd: cfg.workDir, env: childEnv(env, cfg), stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        spawnError = err;
        stderr = String(err?.message ?? err);
        finish(null, null);
        return;
      }
      children.add(child);
      child.on('error', (err) => {
        spawnError = err;
        stderr += (stderr ? '\n' : '') + String(err?.message ?? err);
        // ENOENT 등은 'close'가 오지 않을 수 있다
        setTimeout(() => finish(null, null), 0);
      });
      child.on('close', (code, signal) => finish(code, signal));
      child.stdin.on('error', () => { /* 자식이 먼저 끝나면 EPIPE — 무시 */ });
      child.stdout.on('data', (chunk) => {
        if (collectStdout) stdoutText += chunk.toString('utf8');
        for (const ev of parser.feed(chunk)) handle(ev);
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < STDERR_CAP) stderr += chunk.toString('utf8');
      });
      try {
        child.stdin.end(input);
      } catch { /* 무시 */ }
      if (firstOutputTimeoutMs) {
        firstTimer = setTimeout(() => { timedOut = 'first'; kill(); }, firstOutputTimeoutMs);
      }
      if (timeoutMs) {
        totalTimer = setTimeout(() => { timedOut = timedOut || 'total'; kill(); }, timeoutMs);
      }
    });
    return { promise, kill };
  }

  // ───────────── 로그인 상태 ─────────────

  async function checkLogin() {
    const now = Date.now();
    const status = await runClaude(['auth', 'status', '--json'], { timeoutMs: 15000, collectStdout: true }).promise;
    if (status.spawnError && status.spawnError.code === 'ENOENT') {
      Object.assign(loginState, { ok: false, method: '', checkedAt: now, detail: 'claude CLI를 찾을 수 없습니다' });
      log.error(`claude CLI를 찾을 수 없습니다: ${cfg.claudeBin} — JASO_CLAUDE_BIN 을 확인하세요`);
      return;
    }
    let info = null;
    try { info = JSON.parse(String(status.stdout || '').trim()); } catch { info = null; }
    if (!info || typeof info !== 'object') {
      if (status.timedOut) Object.assign(loginState, { ok: null, method: '', checkedAt: now, detail: '로그인 상태 확인이 시간 안에 끝나지 않았습니다' });
      else Object.assign(loginState, { ok: null, method: '', checkedAt: now, detail: '로그인 상태를 확인하지 못했습니다' });
      log.warn(`claude auth status 해석 실패 (exit ${status.exitCode})`);
      return;
    }
    const method = typeof info.authMethod === 'string' ? info.authMethod : '';
    if (!info.loggedIn) {
      Object.assign(loginState, { ok: false, method, checkedAt: now, detail: 'claude 로그인이 되어 있지 않습니다' });
      log.error('claude 로그인이 되어 있지 않습니다. 서비스 사용자로 `claude auth login` 을 실행하거나 CLAUDE_CODE_OAUTH_TOKEN 을 설정하세요.');
      return;
    }
    Object.assign(loginState, { ok: true, method, checkedAt: now, detail: '' });
    if (cfg.loginProbe) await probeLogin();
  }

  async function probeLogin() {
    const tier = cfg.tiers.default;
    const args = buildArgs({ model: tier.model, effort: 'low', fallbackModel: cfg.fallbackModel, systemPrompt: SYSTEM_PROMPT });
    const out = await runClaude(args, { input: 'ping', timeoutMs: 90000, firstOutputTimeoutMs: 90000 }).promise;
    if (out.lastRateLimit) rememberUsage(out.lastRateLimit);
    const failure = classifyFailure(out);
    loginState.checkedAt = Date.now();
    if (failure && failure.code !== 'refused') {
      loginState.ok = false;
      loginState.detail = failure.code === 'timeout' ? '로그인 확인 호출이 응답하지 않았습니다(토큰 만료 가능)' : failure.message;
      log.error(`시작 시 로그인 점검 실패: ${failure.code}`);
      return;
    }
    loginState.ok = true;
    loginState.detail = '';
    log.info('로그인 점검 성공');
  }

  /** nologin 상태면 5분에 한 번만 재확인한다. true = 진행 가능 */
  async function ensureLogin() {
    if (loginState.ok !== false) return true;
    if (Date.now() - loginState.checkedAt < RECHECK_INTERVAL_MS) return false;
    if (!loginState.rechecking) {
      loginState.rechecking = checkLogin().catch((err) => log.error('로그인 재확인 오류', err?.message)).finally(() => { loginState.rechecking = null; });
    }
    await loginState.rechecking;
    return loginState.ok !== false;
  }

  function rememberUsage(info) {
    if (!info || typeof info !== 'object') return;
    usageWindow = {
      status: typeof info.status === 'string' ? info.status : 'unknown',
      resetsAt: Number.isFinite(Number(info.resetsAt)) ? Number(info.resetsAt) : null,
      type: typeof info.rateLimitType === 'string' ? info.rateLimitType : null,
    };
  }

  // ───────────── 대기열 ─────────────

  function acquireSlot(onQueued) {
    if (queue.active < cfg.concurrency) {
      queue.active += 1;
      return { promise: Promise.resolve(), cancel: () => {} };
    }
    if (queue.waiting.length >= cfg.maxQueue) throw new RequestError(503, 'busy');
    let entry;
    const promise = new Promise((resolve, reject) => {
      entry = { resolve, reject, onQueued };
      queue.waiting.push(entry);
    });
    try { onQueued?.(queue.waiting.length); } catch { /* 무시 */ }
    const cancel = () => {
      const i = queue.waiting.indexOf(entry);
      if (i >= 0) {
        queue.waiting.splice(i, 1);
        entry.reject(new RequestError(499, 'aborted'));
        notifyPositions();
      }
    };
    return { promise, cancel };
  }

  function releaseSlot() {
    queue.active = Math.max(0, queue.active - 1);
    const next = queue.waiting.shift();
    if (next) {
      queue.active += 1;
      next.resolve();
      notifyPositions();
    }
  }

  function notifyPositions() {
    queue.waiting.forEach((w, i) => { try { w.onQueued?.(i + 1); } catch { /* 무시 */ } });
  }

  // ───────────── 응답 헬퍼 ─────────────

  function headersFor(extra = {}) {
    return { ...SEC_HEADERS, ...extra };
  }

  function sendJson(ctx, status, obj, extra = {}) {
    if (ctx.done || ctx.res.headersSent) return;
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    ctx.status = status;
    ctx.outBytes += body.length;
    ctx.res.writeHead(status, headersFor({ 'content-type': JSON_TYPE, 'cache-control': 'no-store', 'content-length': body.length, ...extra }));
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : body);
    ctx.done = true;
  }

  function sseStart(ctx) {
    if (ctx.sse || ctx.done || ctx.res.headersSent) return;
    ctx.sse = true;
    ctx.status = 200;
    ctx.res.writeHead(200, headersFor({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive' }));
    ctx.res.flushHeaders();
    ctx.ping = setInterval(() => sseRaw(ctx, ': ping\n\n'), PING_INTERVAL_MS);
    ctx.ping.unref();
  }

  function sseRaw(ctx, s) {
    if (ctx.done || ctx.aborted) return;
    try { ctx.res.write(s); ctx.outBytes += Buffer.byteLength(s); } catch { /* 소켓이 닫힘 */ }
  }

  function sseEvent(ctx, event, data) {
    sseRaw(ctx, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function sseEnd(ctx) {
    if (ctx.done) return;
    ctx.done = true;
    clearInterval(ctx.ping);
    try { ctx.res.end(); } catch { /* 무시 */ }
  }

  function failureBody(f) {
    const body = { code: f.code, message: f.message };
    if (f.resetsAt !== undefined) body.resetsAt = f.resetsAt;
    if (f.retryAfterSec !== undefined) body.retryAfterSec = f.retryAfterSec;
    if (f.detail) body.detail = f.detail;
    return body;
  }

  function sendFailure(ctx, f) {
    ctx.errorCode = f.code;
    if (ctx.sse) {
      ctx.status = f.status;
      sseEvent(ctx, 'error', failureBody(f));
      sseEnd(ctx);
      return;
    }
    const extra = {};
    if (f.code === 'unauthorized') extra['www-authenticate'] = 'Bearer';
    if (f.retryAfterSec) extra['retry-after'] = String(f.retryAfterSec);
    sendJson(ctx, f.status, failureBody(f), extra);
  }

  // ───────────── 본문 읽기 ─────────────

  function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let settled = false;
      const done = (fn) => { if (!settled) { settled = true; fn(); } };
      const len = Number(req.headers['content-length']);
      if (Number.isFinite(len) && len > maxBytes) {
        done(() => reject(new RequestError(413, 'prompt_too_large')));
        req.resume();
        return;
      }
      req.on('data', (c) => {
        if (settled) return;
        size += c.length;
        if (size > maxBytes) {
          done(() => reject(new RequestError(413, 'prompt_too_large')));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => done(() => resolve(Buffer.concat(chunks))));
      req.on('error', () => done(() => reject(new RequestError(499, 'aborted'))));
      req.on('close', () => done(() => reject(new RequestError(499, 'aborted'))));
    });
  }

  // ───────────── /api/sample ─────────────

  function parseSampleBody(raw) {
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { throw new RequestError(400, 'invalid_request', { detail: 'body is not JSON' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, 'invalid_request', { detail: 'body must be an object' });
    const tier = body.modelTier === undefined || body.modelTier === null || body.modelTier === '' ? 'default' : body.modelTier;
    if (!TIER_NAMES.includes(tier)) throw new RequestError(400, 'invalid_request', { detail: 'modelTier is invalid' });
    let schema = null;
    if (body.schema !== undefined && body.schema !== null) {
      if (typeof body.schema !== 'object' || Array.isArray(body.schema)) throw new RequestError(400, 'invalid_request', { detail: 'schema must be an object' });
      schema = body.schema;
    }
    const flat = flattenInput(body.input);
    return { tier, schema, stream: body.stream === true, ...flat };
  }

  async function handleSample(ctx) {
    const { req, res } = ctx;
    if (req.method !== 'POST') {
      sendJson(ctx, 405, { code: 'method_not_allowed', message: makeFailure(405, 'method_not_allowed').message }, { allow: 'POST' });
      return;
    }
    const ip = ctx.ip;
    // 인증 실패가 잦은 IP는 먼저 막는다
    const authGate = authFailLimiter.check(ip);
    if (!authGate.ok) return sendFailure(ctx, makeFailure(429, 'rate_limited', { retryAfterSec: authGate.retryAfterSec }));
    if (authMode === 'key' && !checkAuth(req.headers.authorization, digest)) {
      authFailLimiter.hit(ip);
      req.resume();
      return sendFailure(ctx, makeFailure(401, 'unauthorized'));
    }
    const rate = sampleLimiter.hit(ip);
    if (!rate.ok) {
      req.resume();
      return sendFailure(ctx, makeFailure(429, 'rate_limited', { retryAfterSec: rate.retryAfterSec }));
    }

    // 교차 사이트의 '단순 요청'(text/plain POST)으로 운영자 구독을 쓰지 못하게 JSON 본문만 받는다
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
      req.resume();
      return sendFailure(ctx, makeFailure(400, 'invalid_request', { detail: 'Content-Type 은 application/json 이어야 합니다' }));
    }
    const raw = await readBody(req, cfg.maxBodyBytes);
    ctx.inBytes = raw.length;
    const parsed = parseSampleBody(raw);
    ctx.tier = parsed.tier;
    if (parsed.bytes > cfg.maxInputBytes) throw new RequestError(413, 'prompt_too_large');
    const streaming = parsed.stream || String(req.headers.accept ?? '').includes('text/event-stream');

    if (!(await ensureLogin())) return sendFailure(ctx, makeFailure(503, 'nologin', { detail: loginState.detail }));
    if (ctx.aborted) return;
    if (shuttingDown) return sendFailure(ctx, makeFailure(503, 'busy'));

    // 대기열
    const slot = acquireSlot((position) => {
      if (!streaming) return;
      sseStart(ctx);
      sseEvent(ctx, 'queued', { position });
    });
    ctx.cancelWait = slot.cancel;
    try {
      await slot.promise;
    } catch (err) {
      // 대기 중 클라이언트가 떠났거나(응답 불필요), 종료 중이라 거절됨(busy 로 알린다)
      if (!ctx.aborted && err instanceof RequestError) sendFailure(ctx, err.failure);
      return;
    }
    ctx.cancelWait = null;
    ctx.holdsSlot = true;
    if (ctx.aborted) { releaseSlot(); ctx.holdsSlot = false; return; }
    // 자리를 잡았으면 스트리밍 헤더를 바로 내보낸다 (이후 오류는 error 이벤트로 전달)
    if (streaming) sseStart(ctx);

    const tierCfg = cfg.tiers[parsed.tier];
    const args = buildArgs({ model: tierCfg.model, effort: tierCfg.effort, schema: parsed.schema, fallbackModel: cfg.fallbackModel, systemPrompt: SYSTEM_PROMPT });
    let accumulated = '';
    const run = runClaude(args, {
      input: parsed.prompt,
      timeoutMs: cfg.totalTimeoutMs,
      firstOutputTimeoutMs: cfg.firstOutputTimeoutMs,
      onEvent: (ev) => {
        if (ev.type === 'delta') {
          accumulated += ev.text;
          if (streaming && !ctx.aborted) {
            sseStart(ctx);
            sseEvent(ctx, 'delta', { text: accumulated, delta: ev.text });
          }
        } else if (ev.type === 'rateLimit') {
          rememberUsage(ev.info);
        }
      },
    });
    ctx.killChild = run.kill;
    let out;
    try {
      out = await run.promise;
    } finally {
      ctx.killChild = null;
      releaseSlot();
      ctx.holdsSlot = false;
    }
    if (ctx.aborted) return;

    const failure = classifyFailure(out);
    if (failure) {
      if (failure.code === 'nologin') {
        // health 는 인증 없이 볼 수 있으므로 CLI 의 stderr 는 로그에만 남기고 고정 문구만 공개한다
        Object.assign(loginState, { ok: false, checkedAt: Date.now(), detail: '요청 처리 중 로그인 오류' });
        log.error('요청 처리 중 로그인 오류', failure.detail || '');
      }
      return sendFailure(ctx, failure);
    }
    const result = out.result;
    let text = pickText(result, out.text);
    let data = null;
    if (parsed.schema) {
      if (result.structured_output && typeof result.structured_output === 'object') {
        data = result.structured_output;
      } else {
        try {
          const v = JSON.parse(cleanModelText(text));
          if (v && typeof v === 'object') data = v;
        } catch { /* 아래에서 invalid_json */ }
        if (data === null) return sendFailure(ctx, makeFailure(502, 'invalid_json'));
      }
      if (!text.trim()) text = JSON.stringify(data);
    }
    if (!text.trim() && data === null) return sendFailure(ctx, makeFailure(502, 'empty_completion'));

    const payload = {
      text,
      truncated: result.stop_reason === 'max_tokens',
      modelTierApplied: parsed.tier,
      model: modelIdFrom(result, tierCfg.model),
      data,
      usage: usageFrom(result),
      costUsd: typeof result.total_cost_usd === 'number' && Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null,
    };
    if (streaming) {
      sseStart(ctx);
      sseEvent(ctx, 'done', payload);
      sseEnd(ctx);
    } else {
      sendJson(ctx, 200, payload);
    }
  }

  // ───────────── /api/health ─────────────

  function healthBody() {
    return {
      service: 'jaso',
      runtime: 'server',
      version: '1',
      auth: authMode,
      login: { ok: loginState.ok, method: loginState.method, checkedAt: loginState.checkedAt, detail: loginState.detail },
      queue: { active: queue.active, waiting: queue.waiting.length, concurrency: cfg.concurrency, maxQueue: cfg.maxQueue },
      usageWindow,
      limits: { maxPromptBytes: cfg.maxInputBytes },
      tiers: cfg.tiers,
    };
  }

  function handleHealth(ctx) {
    if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') {
      return sendJson(ctx, 405, { code: 'method_not_allowed', message: makeFailure(405, 'method_not_allowed').message }, { allow: 'GET, HEAD' });
    }
    sendJson(ctx, 200, healthBody());
  }

  // ───────────── 정적 파일 ─────────────

  function sendText(ctx, status, text, extra = {}) {
    if (ctx.done || ctx.res.headersSent) return;
    const body = Buffer.from(text, 'utf8');
    ctx.status = status;
    ctx.outBytes += body.length;
    ctx.res.writeHead(status, headersFor({ 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length, ...extra }));
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : body);
    ctx.done = true;
  }

  function redirect(ctx, to) {
    ctx.status = 302;
    ctx.res.writeHead(302, headersFor({ location: to, 'content-length': 0 }));
    ctx.res.end();
    ctx.done = true;
  }

  let realRootCache = null;
  async function realPathAllowed(file) {
    try {
      realRootCache ??= await fs.promises.realpath(cfg.root);
      const real = await fs.promises.realpath(file);
      const rel = path.relative(realRootCache, real);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
      const segs = rel.split(path.sep);
      if (segs[0] === 'jaso') return segs.length >= 2 && segs[1].toLowerCase() !== 'server';
      return segs.length === 1 && segs[0].toLowerCase().endsWith('.html');
    } catch {
      return false;
    }
  }

  async function handleStatic(ctx, pathname) {
    const { req, res } = ctx;
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(ctx, 405, '허용되지 않는 요청 방식입니다.', { allow: 'GET, HEAD' });
    if (pathname === '/' || pathname === '/jaso') return redirect(ctx, '/jaso/');
    const file = resolveStatic(cfg.root, pathname);
    if (!file) return sendText(ctx, 404, '찾을 수 없습니다.');
    let st;
    try { st = await fs.promises.stat(file); } catch { return sendText(ctx, 404, '찾을 수 없습니다.'); }
    if (!st.isFile()) return sendText(ctx, 404, '찾을 수 없습니다.');
    // 심볼릭 링크·대소문자 무시 파일 시스템을 거쳐도 실제 경로가 허용 범위인지 다시 확인한다
    if (!(await realPathAllowed(file))) return sendText(ctx, 404, '찾을 수 없습니다.');
    const lastModified = new Date(Math.floor(st.mtimeMs / 1000) * 1000);
    const ims = req.headers['if-modified-since'];
    if (ims) {
      const since = Date.parse(ims);
      if (Number.isFinite(since) && lastModified.getTime() <= since) {
        ctx.status = 304;
        res.writeHead(304, headersFor({ 'cache-control': 'no-cache', 'last-modified': lastModified.toUTCString() }));
        res.end();
        ctx.done = true;
        return;
      }
    }
    const headers = headersFor({
      'content-type': mimeFor(file),
      'content-length': st.size,
      'cache-control': 'no-cache',
      'last-modified': lastModified.toUTCString(),
    });
    ctx.status = 200;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); ctx.done = true; return; }
    ctx.outBytes += st.size;
    await new Promise((resolve) => {
      const stream = fs.createReadStream(file);
      // 응답이 끝까지 쓰였으면 정상 완료 (close 리스너의 중단 판정보다 먼저 표시)
      res.on('finish', () => { ctx.done = true; });
      stream.on('error', () => { try { res.destroy(); } catch { /* 무시 */ } resolve(); });
      stream.on('close', resolve);
      res.on('close', () => { stream.destroy(); resolve(); });
      stream.pipe(res);
    });
  }

  // ───────────── 요청 분배 ─────────────

  function onRequest(req, res) {
    const started = Date.now();
    const ctx = { req, res, ip: clientIp(req, cfg.trustProxy), status: 0, inBytes: 0, outBytes: 0, tier: '-', done: false, sse: false, aborted: false, ping: null, killChild: null, cancelWait: null, holdsSlot: false, errorCode: '' };
    let pathname = '/';
    try { pathname = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { pathname = '/'; }
    ctx.path = pathname;

    res.on('close', () => {
      clearInterval(ctx.ping);
      if (!ctx.done) {
        // 응답을 끝내기 전에 연결이 끊김 = 클라이언트 중단
        ctx.aborted = true;
        ctx.done = true;
        if (ctx.cancelWait) { try { ctx.cancelWait(); } catch { /* 무시 */ } }
        if (ctx.killChild) { try { ctx.killChild(); } catch { /* 무시 */ } }
        ctx.status = ctx.status || 499;
      }
      log.request({ ip: ctx.ip, method: req.method, path: pathname, status: ctx.status, ms: Date.now() - started, tier: ctx.tier, inBytes: ctx.inBytes, outBytes: ctx.outBytes, code: ctx.errorCode || (ctx.aborted ? 'aborted' : '') });
    });
    res.on('error', () => { /* 끊긴 소켓에 쓴 경우 */ });

    const run = async () => {
      if (pathname === '/api/health') return handleHealth(ctx);
      if (pathname === '/api/sample') return handleSample(ctx);
      if (pathname.startsWith('/api/')) return sendJson(ctx, 404, { code: 'not_found', message: makeFailure(404, 'not_found').message });
      return handleStatic(ctx, pathname);
    };
    run().catch((err) => {
      if (ctx.aborted) return;
      if (err instanceof RequestError) {
        if (err.code === 'aborted') return;
        req.resume();
        return sendFailure(ctx, err.failure);
      }
      log.error('요청 처리 중 예외', err?.stack || err?.message || String(err));
      sendFailure(ctx, makeFailure(500, 'internal'));
    }).catch(() => { /* 응답 중 오류까지 삼킨다 */ });
  }

  const server = http.createServer(onRequest);
  server.on('clientError', (err, socket) => {
    if ((err && err.code === 'ECONNRESET') || !socket.writable) return socket.destroy();
    try { socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'); } catch { socket.destroy(); }
  });
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 65000;

  const sweeper = setInterval(() => { sampleLimiter.sweep(); authFailLimiter.sweep(); }, 60000);
  sweeper.unref();

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('종료 신호 수신, 정리 중…');
    clearInterval(sweeper);
    for (const w of [...queue.waiting]) { try { w.reject(new RequestError(503, 'busy')); } catch { /* 무시 */ } }
    queue.waiting.length = 0;
    for (const child of children) { try { child.kill('SIGTERM'); } catch { /* 무시 */ } }
    server.close(() => tryExit());
    server.closeIdleConnections?.();
    const forced = setTimeout(() => { server.closeAllConnections?.(); process.exit(0); }, 5000);
    forced.unref();
    const poll = setInterval(() => { if (children.size === 0) { server.closeAllConnections?.(); } }, 200);
    poll.unref();
    function tryExit() { clearTimeout(forced); clearInterval(poll); process.exit(0); }
  }

  return { server, cfg, checkLogin, healthBody, shutdown, children, queue, loginState };
}

// ───────────── 로그 ─────────────

export function createLogger(level = 'info') {
  const order = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
  const lvl = order[level] ?? order.info;
  const write = (s) => { try { process.stderr.write(`${s}\n`); } catch { /* 무시 */ } };
  const stamp = () => new Date().toISOString();
  return {
    error: (...a) => { if (lvl >= 1) write(`${stamp()} ERROR ${a.filter(Boolean).join(' ')}`); },
    warn: (...a) => { if (lvl >= 2) write(`${stamp()} WARN ${a.filter(Boolean).join(' ')}`); },
    info: (...a) => { if (lvl >= 3) write(`${stamp()} INFO ${a.filter(Boolean).join(' ')}`); },
    // 요청 한 줄: 내용(프롬프트·응답)은 절대 남기지 않는다
    request: (r) => { if (lvl >= 3) write(`${stamp()} ${r.ip} ${r.method} ${r.path} ${r.status} ${r.ms}ms tier=${r.tier} in=${r.inBytes} out=${r.outBytes}${r.code ? ` code=${r.code}` : ''}`); },
  };
}

// ───────────── 진입점 ─────────────

async function main() {
  const cfg = parseConfig(process.env);
  const log = createLogger(cfg.logLevel);
  if (!cfg.accessKey && !cfg.allowAnon) {
    process.stderr.write([
      'JASO_ACCESS_KEY 가 설정되지 않았습니다. 방문자가 쓸 접속 키를 만들어 환경 변수 JASO_ACCESS_KEY 에 넣어 주세요.',
      '  예) node -e "process.stdout.write(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"',
      '  로컬에서 키 없이 시험하려면 JASO_ALLOW_ANON=1 을 설정하세요.',
      '',
    ].join('\n'));
    process.exit(2);
  }
  try { fs.mkdirSync(cfg.workDir, { recursive: true }); } catch (err) { log.error(`작업 폴더를 만들 수 없습니다: ${cfg.workDir} (${err?.message})`); }
  if (!fs.existsSync(path.join(cfg.root, 'jaso', 'index.html'))) log.warn(`정적 루트에 jaso/index.html 이 없습니다: ${cfg.root}`);

  const app = createApp(cfg, { log });
  try { await app.checkLogin(); } catch (err) { log.error('로그인 상태 확인 중 오류', err?.message); }

  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(cfg.port, cfg.host, () => resolve());
  }).catch((err) => {
    log.error(`포트를 열 수 없습니다: ${cfg.host}:${cfg.port} (${err?.code || err?.message})`);
    process.exit(1);
  });
  const addr = app.server.address();
  const host = addr.family === 'IPv6' && !addr.address.startsWith('[') ? `[${addr.address}]` : addr.address;
  process.stdout.write(`jaso server listening on http://${host}:${addr.port}/\n`);
  log.info(`auth=${cfg.accessKey ? 'key' : 'open'} login=${app.loginState.ok} concurrency=${cfg.concurrency} bin=${cfg.claudeBin}`);

  process.on('SIGTERM', app.shutdown);
  process.on('SIGINT', app.shutdown);
  process.on('uncaughtException', (err) => { log.error('처리되지 않은 예외', err?.stack || String(err)); });
  process.on('unhandledRejection', (err) => { log.error('처리되지 않은 거부', err?.stack || String(err)); });
}

const isEntry = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (isEntry) main();

