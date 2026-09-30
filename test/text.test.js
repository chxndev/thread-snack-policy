import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countWithSpaces, countWithoutSpaces, countBytes2, judgeLength, describeLength,
  cleanModelText, validateSchema, textStats, targetRange,
} from '../jaso/src/text.js';

test('공백 포함 글자수는 코드포인트 기준이며 줄바꿈을 1자로 센다', () => {
  assert.equal(countWithSpaces('안녕 하세요'), 6);
  assert.equal(countWithSpaces('a\r\nb'), 3);
  assert.equal(countWithSpaces('😀😀'), 2);
  assert.equal(countWithSpaces(''), 0);
  assert.equal(countWithSpaces(null), 0);
});

test('공백 제외 글자수는 모든 공백 문자를 뺀다', () => {
  assert.equal(countWithoutSpaces('안녕 하세요\n반갑습니다\t!'), 11);
});

test('바이트(2byte) 계산: 한글 2, ASCII 1', () => {
  assert.equal(countBytes2('한a'), 3);
  assert.equal(countBytes2('가나다\n'), 7);
});

test('targetRange는 제한의 90%~100%', () => {
  assert.deepEqual(targetRange(1000), { min: 900, max: 1000 });
  assert.deepEqual(targetRange(0), { min: 0, max: 0 });
  assert.deepEqual(targetRange('500'), { min: 450, max: 500 });
});

test('judgeLength가 초과·부족·범위 내를 판정한다', () => {
  assert.equal(judgeLength('가'.repeat(950), 1000).status, 'ok');
  assert.equal(judgeLength('가'.repeat(1001), 1000).status, 'over');
  assert.equal(judgeLength('가'.repeat(1001), 1000).diff, 1);
  assert.equal(judgeLength('가'.repeat(800), 1000).status, 'under');
  assert.equal(judgeLength('가'.repeat(800), 1000).diff, -100);
  assert.equal(judgeLength('가나', 0).status, 'none');
  assert.equal(judgeLength('가 '.repeat(500), 500, 'without').status, 'ok');
  assert.equal(judgeLength('가 '.repeat(500), 500, 'with').status, 'over');
});

test('describeLength 문구', () => {
  const j = judgeLength('가'.repeat(1050), 1000);
  assert.match(describeLength(j), /1050자 \/ 제한 1000자.*50자 초과/);
  assert.match(describeLength(judgeLength('가나', 0)), /제한 없음/);
});

test('cleanModelText가 코드펜스와 라벨을 제거한다', () => {
  assert.equal(cleanModelText('```\n본문입니다.\n```'), '본문입니다.');
  assert.equal(cleanModelText('답변: 본문'), '본문');
  assert.equal(cleanModelText('  본문 \r\n둘째 줄 '), '본문 \n둘째 줄');
});

test('validateSchema: required/type/enum/additionalProperties/items', () => {
  const schema = {
    type: 'object', additionalProperties: false,
    required: ['q', 'n'],
    properties: {
      q: { type: 'string' }, n: { type: 'integer' },
      mode: { type: 'string', enum: ['a', 'b'] },
      tags: { type: 'array', items: { type: 'string' } },
    },
  };
  assert.deepEqual(validateSchema({ q: 'x', n: 1 }, schema), []);
  assert.ok(validateSchema({ q: 'x' }, schema).some((e) => e.includes('n: required')));
  assert.ok(validateSchema({ q: 'x', n: 1.5 }, schema).some((e) => e.includes('integer')));
  assert.ok(validateSchema({ q: 'x', n: 1, mode: 'z' }, schema).some((e) => e.includes('enum')));
  assert.ok(validateSchema({ q: 'x', n: 1, extra: 1 }, schema).some((e) => e.includes('unexpected')));
  assert.ok(validateSchema({ q: 'x', n: 1, tags: ['a', 2] }, schema).some((e) => e.includes('tags[1]')));
  assert.equal(validateSchema('nope', schema).length, 1);
});

test('textStats가 문장 수와 문단 수를 센다', () => {
  const s = textStats('첫 문장입니다. 둘째 문장입니다!\n\n셋째 문장입니다.');
  assert.equal(s.sentences, 3);
  assert.equal(s.paragraphs, 2);
  assert.equal(s.longSentences, 0);
});
