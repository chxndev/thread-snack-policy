import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { costFromMessage, estimateCost, isToolJsonError, describeError } from '../jaso/src/api.js';

test('costFromMessage: 폴백 iterations가 있으면 시도별 모델 단가로 합산한다', () => {
  const msg = {
    model: 'claude-opus-4-8',
    usage: {
      input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      iterations: [
        { type: 'message', model: 'claude-fable-5-1', input_tokens: 1000, output_tokens: 3000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ],
    },
  };
  const c = costFromMessage(msg, 'claude-fable-5-1');
  assert.equal(c.tokens.output, 3500);
  assert.equal(c.fallbackRan, true);
  const expected = (1000 * 10 + 3000 * 50) / 1e6 + (1000 * 5 + 500 * 25) / 1e6;
  assert.ok(Math.abs(c.usd - expected) < 1e-9);
  const plain = costFromMessage({ model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 10 } }, 'claude-opus-5-5');
  assert.equal(plain.fallbackRan, false);
  assert.ok(Math.abs(plain.usd - (100 * 4 + 10 * 20) / 1e6) < 1e-9);
  assert.equal(estimateCost('nope', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), null);
});

test('isToolJsonError는 SDK의 도구 입력 파싱 오류만 잡는다', () => {
  assert.equal(isToolJsonError(new Anthropic.AnthropicError('Unable to parse tool parameter JSON from model. x')), true);
  assert.equal(isToolJsonError(new Anthropic.AnthropicError('other')), false);
  assert.equal(isToolJsonError(new TypeError('Unable to parse tool parameter JSON')), false);
});

test('describeError는 AgentError 메시지를 그대로 쓴다', () => {
  assert.equal(describeError({ name: 'AgentError', message: '멈춤' }), '멈춤');
});
