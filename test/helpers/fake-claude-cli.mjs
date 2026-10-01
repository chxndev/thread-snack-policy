#!/usr/bin/env node
// 테스트용 가짜 `claude` CLI. 서버가 JASO_CLAUDE_BIN=<이 파일> 로 띄운다.
// `auth status --json` 과 `-p --output-format stream-json|json` 만 흉내 내며,
// 답은 test/e2e/fake-claude.js(브라우저용 가짜 window.claude)의 두뇌를 node:vm 으로 불러와 만든다.
// 환경 변수: FAKE_MODE(hang|usage_limit|nologin|crash|refusal|truncate), FAKE_DELAY_MS(기본 5),
//           FAKE_RATE_STATUS(기본 allowed), FAKE_LOGGED_IN(0이면 로그아웃), FAKE_LOG(호출 기록 파일),
//           FAKE_STATE(두뇌의 호출 횟수 상태 파일 — 호출마다 새 프로세스로 뜨므로 인터뷰 턴·첨삭 번갈이 등
//           두뇌의 상태를 이어 가려면 지정한다. 동시 실행이 1일 때를 전제로 한다)
import fs from 'node:fs';
import vm from 'node:vm';
import { unflattenInput } from '../../jaso/server/lib.mjs';

const VALUE_FLAGS = new Set(['--output-format', '--json-schema', '--model', '--effort', '--system-prompt', '--tools', '--setting-sources', '--permission-prompts', '--fallback-model']);
const FULL_MODEL = { opus: 'claude-opus-4-1-20250805', sonnet: 'claude-sonnet-4-5-20250929', haiku: 'claude-haiku-4-5-20251001' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeLine = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

function parseArgv(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) { opts[a.slice(2)] = argv[i + 1] ?? ''; i += 1; }
    else if (a.startsWith('--')) opts[a.slice(2)] = true;
    else rest.push(a);
  }
  return { opts, rest };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** 코드포인트 기준으로 n조각으로 나눈다 */
function splitChunks(text, n) {
  const cps = Array.from(text);
  if (!cps.length) return [''];
  const size = Math.max(1, Math.ceil(cps.length / n));
  const out = [];
  for (let i = 0; i < cps.length; i += size) out.push(cps.slice(i, i + size).join(''));
  return out;
}

async function loadBrain() {
  const src = fs.readFileSync(new URL('../e2e/fake-claude.js', import.meta.url), 'utf8');
  const sandbox = { window: {}, setTimeout, console };
  vm.runInNewContext(src, sandbox, { filename: 'fake-claude.js' });
  const sample = await sandbox.window.claude.use('sample');
  return { sample, counters: sandbox.window.__fakeCounters };
}

/** FAKE_STATE 파일에 저장된 두뇌 상태(호출 횟수)를 읽어 counters에 덧입힌다 */
function restoreBrainState(counters) {
  const file = process.env.FAKE_STATE;
  if (!file || !counters) return;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(saved)) if (k in counters && Number.isInteger(v)) counters[k] = v;
  } catch { /* 첫 호출이면 파일이 없다 */ }
}

function saveBrainState(counters) {
  const file = process.env.FAKE_STATE;
  if (!file || !counters) return;
  try { fs.writeFileSync(file, JSON.stringify(counters)); } catch { /* 무시 */ }
}

function tierFor(model, effort) {
  if (/opus/i.test(model)) return 'complex';
  if (effort === 'low') return 'quick';
  return 'default';
}

async function main() {
  const { opts, rest } = parseArgv(process.argv.slice(2));
  if (rest.includes('auth') && rest.includes('status')) {
    writeLine({ loggedIn: process.env.FAKE_LOGGED_IN !== '0', authMethod: 'claude.ai', apiProvider: 'firstParty' });
    return;
  }

  const mode = process.env.FAKE_MODE || '';
  const delay = Number(process.env.FAKE_DELAY_MS ?? 5) || 0;
  const format = opts['output-format'] || 'text';
  const model = String(opts.model || 'sonnet');
  const effort = String(opts.effort || 'medium');
  const hasSchema = typeof opts['json-schema'] === 'string';
  const fullModel = FULL_MODEL[model] || model;
  const nowSec = Math.floor(Date.now() / 1000);
  const rateInfo = () => ({ status: process.env.FAKE_RATE_STATUS || 'allowed', resetsAt: nowSec + 3600, rateLimitType: 'five_hour', overageStatus: 'none' });
  const baseResult = {
    type: 'result', subtype: 'success', is_error: false, result: '', stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { [fullModel]: { costUSD: 0.001 } }, total_cost_usd: 0.001, num_turns: 1, permission_denials: [], api_error_status: null, session_id: 'fake', duration_ms: 10,
  };

  if (mode === 'hang') {
    // 아무것도 출력하지 않고 살아 있는다 (서버가 타임아웃으로 죽여야 함)
    setInterval(() => {}, 1 << 30);
    await new Promise(() => {});
    return;
  }
  if (mode === 'nologin') {
    process.stderr.write('Not logged in · Please run /login\n');
    process.exitCode = 1;
    return;
  }
  if (mode === 'crash') {
    process.stderr.write('boom\n');
    process.exitCode = 1;
    return;
  }

  const raw = await readStdin();
  const input = unflattenInput(raw);
  const inputKind = Array.isArray(input) ? 'messages' : 'string';
  if (process.env.FAKE_LOG) {
    try { fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ model, effort, hasSchema, inputKind, turns: Array.isArray(input) ? input.length : 0, format })}\n`); } catch { /* 무시 */ }
  }

  const emitPrelude = () => {
    if (format !== 'stream-json') return;
    writeLine({ type: 'active_goal', goal: null });
    writeLine({ type: 'system', subtype: 'init', apiKeySource: 'none', model: fullModel, session_id: 'fake', tools: [] });
  };

  if (mode === 'usage_limit') {
    emitPrelude();
    const info = { ...rateInfo(), status: 'rejected' };
    const result = { ...baseResult, subtype: 'error_during_execution', is_error: true, result: "You've hit your usage limit", api_error_status: 429 };
    if (format === 'stream-json') writeLine({ type: 'rate_limit_event', rate_limit_info: info });
    writeLine(result);
    process.exitCode = 1;
    return;
  }

  let text = '';
  let structured;
  try {
    const { sample, counters } = await loadBrain();
    restoreBrainState(counters);
    const modelTier = tierFor(model, effort);
    const r = await sample(input, { modelTier });
    saveBrainState(counters);
    text = String(r.text ?? '');
    if (hasSchema) {
      try { const v = JSON.parse(text); if (v && typeof v === 'object') structured = v; } catch { structured = undefined; }
    }
  } catch (err) {
    emitPrelude();
    writeLine({ ...baseResult, subtype: 'error_during_execution', is_error: true, result: `fake brain error: ${err && err.message ? err.message : JSON.stringify(err)}` });
    process.exitCode = 1;
    return;
  }

  const stopReason = mode === 'refusal' ? 'refusal' : mode === 'truncate' ? 'max_tokens' : hasSchema && structured ? 'tool_use' : 'end_turn';
  if (mode === 'refusal') text = '';
  const result = { ...baseResult, result: text, stop_reason: stopReason };
  if (hasSchema && structured) result.structured_output = structured;

  if (format !== 'stream-json') {
    writeLine(result);
    return;
  }

  emitPrelude();
  writeLine({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model: fullModel, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } } } });
  const asJson = hasSchema && structured;
  writeLine({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: asJson ? { type: 'tool_use', id: 'toolu_fake', name: 'StructuredOutput', input: {} } : { type: 'text', text: '' } } });
  const chunks = splitChunks(text, 3);
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0 && delay) await sleep(delay);
    const delta = asJson ? { type: 'input_json_delta', partial_json: chunks[i] } : { type: 'text_delta', text: chunks[i] };
    writeLine({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta } });
  }
  writeLine({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  writeLine({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 50 } } });
  writeLine({ type: 'stream_event', event: { type: 'message_stop' } });
  writeLine({ type: 'assistant', message: { id: 'msg_fake', type: 'message', role: 'assistant', model: fullModel, content: asJson ? [{ type: 'tool_use', id: 'toolu_fake', name: 'StructuredOutput', input: structured }] : [{ type: 'text', text }], stop_reason: stopReason } });
  writeLine({ type: 'rate_limit_event', rate_limit_info: rateInfo() });
  writeLine(result);
}

main().catch((err) => {
  process.stderr.write(`fake-claude-cli failed: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
