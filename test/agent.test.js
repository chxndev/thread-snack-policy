import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgent, upsertExperience, currentText, AgentError } from '../jaso/src/agent.js';
import { fakeClient, makeMessage, text, toolUse, thinking, sampleProject } from './helpers/fake-client.js';

const goodCritique = (over = {}) => JSON.stringify({
  scores: { fit: 5, specificity: 5, structure: 5, relevance: 5, style: 5, authenticity: 5 },
  total: 100, needs_revision: false, must_fix: [], issues: [], strengths: ['구체적'], summary: '좋음', ...over,
});
const weakCritique = () => JSON.stringify({
  scores: { fit: 2, specificity: 2, structure: 3, relevance: 3, style: 4, authenticity: 4 },
  total: 50, needs_revision: true, must_fix: ['문항 요구 누락'],
  issues: [{ quote: '열심히 했습니다', why: '추상적', fix: '수치로', severity: 'high' }], strengths: [], summary: '약함',
});

test('인터뷰: 첫 턴에 ask_user → 답변 → save_experience + ask_user → 종료', async () => {
  const project = sampleProject();
  const client = fakeClient((params, i) => {
    if (i === 0) return makeMessage([thinking(), toolUse('ask_user', { question: '경험 후보를 알려 주세요.', why: '전체 파악', example: '' }, 'tu1')], { stopReason: 'tool_use' });
    if (i === 1) return makeMessage([
      toolUse('save_experience', { id: '', title: '동아리 예산 절감', situation: '2024 동아리', task: '예산 부족', action: '협상', result: '40% 절감', learned: '설득', keywords: ['협상'], question_ids: ['q2'] }, 'tu2'),
      toolUse('ask_user', { question: '그때 가장 어려웠던 점은요?', why: '갈등 파악', example: '예: 의견 충돌' }, 'tu3'),
    ], { stopReason: 'tool_use' });
    if (i === 2) return makeMessage([
      toolUse('save_experience', { id: project.experiences[0].id, title: '', situation: '', task: '', action: '회의 주재', result: '', learned: '', keywords: [], question_ids: ['q2', 'q1'] }, 'tu4'),
      toolUse('finish_interview', { summary: '요약', writer_notes: 'q2에 카드1' }, 'tu5'),
    ], { stopReason: 'tool_use' });
    throw new Error('unexpected call ' + i);
  });
  const usage = [];
  const agent = createAgent({ client, settings: { model: 'claude-opus-5-5' }, onUsage: (u) => usage.push(u) });

  const deltas = [];
  const r1 = await agent.interviewStart(project, { onQuestionDelta: (q) => deltas.push(q) });
  assert.equal(r1.type, 'question');
  assert.equal(project.interview.status, 'waiting');
  assert.equal(project.interview.pending.toolUseId, 'tu1');
  assert.deepEqual(deltas, ['경험 후보를 알려 주세요.']);
  // 첫 요청 파라미터 검증
  const p0 = client.calls[0];
  assert.equal(p0.model, 'claude-opus-5-5');
  assert.equal(p0.fallbacks, 'default');
  assert.deepEqual(p0.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(p0.tools.length, 3);
  assert.equal(p0.tools[0].eager_input_streaming, true);
  assert.equal(p0.tools[0].strict, true);
  assert.deepEqual(p0.cache_control, { type: 'ephemeral' });
  assert.equal(p0.output_config.effort, 'medium');
  assert.ok(!('thinking' in p0), 'thinking은 생략(adaptive 기본)');
  assert.match(p0.messages[0].content, /네이버/);

  const r2 = await agent.interviewAnswer(project, '동아리 예산 절감 경험이 있어요.', {});
  assert.equal(r2.type, 'question');
  assert.equal(project.experiences.length, 1);
  assert.equal(project.experiences[0].title, '동아리 예산 절감');
  // 두 번째 요청: 이전 assistant 내용(thinking 포함)이 그대로 되돌아가고, tool_result가 한 user 메시지에 담긴다
  const p1 = client.calls[1];
  assert.equal(p1.messages.length, 3);
  assert.equal(p1.messages[1].role, 'assistant');
  assert.equal(p1.messages[1].content[0].type, 'thinking');
  assert.deepEqual(p1.messages[2].content, [{ type: 'tool_result', tool_use_id: 'tu1', content: '동아리 예산 절감 경험이 있어요.' }]);

  const r3 = await agent.interviewAnswer(project, '의견 충돌이요.', {});
  assert.equal(r3.type, 'done');
  assert.equal(project.interview.status, 'done');
  assert.equal(project.interview.summary, '요약');
  assert.equal(project.interview.writerNotes, 'q2에 카드1');
  // 갱신: 빈 값은 유지, 채워진 값만 덮어씀
  assert.equal(project.experiences.length, 1);
  assert.equal(project.experiences[0].action, '회의 주재');
  assert.equal(project.experiences[0].title, '동아리 예산 절감');
  assert.deepEqual(project.experiences[0].questionIds, ['q2', 'q1']);
  // 세 번째 요청의 user 메시지: save 결과 + ask 답변이 한 메시지에
  const p2 = client.calls[2];
  const last = p2.messages[p2.messages.length - 1];
  assert.equal(last.content.length, 2);
  assert.equal(last.content[0].tool_use_id, 'tu2');
  assert.equal(last.content[1].tool_use_id, 'tu3');
  assert.equal(usage.length, 3);
  assert.equal(project.interview.questionCount, 2);
});

test('인터뷰: 도구 없이 텍스트만 오면 질문으로 취급하고, 다음 답변은 일반 텍스트로 보낸다', async () => {
  const project = sampleProject();
  const client = fakeClient((params, i) => {
    if (i === 0) return makeMessage([text('어떤 프로젝트를 하셨나요?')]);
    if (i === 1) return makeMessage([toolUse('finish_interview', { summary: 's', writer_notes: 'n' })], { stopReason: 'tool_use' });
  });
  const agent = createAgent({ client });
  const r = await agent.interviewStart(project, {});
  assert.equal(r.type, 'question');
  assert.equal(r.question.question, '어떤 프로젝트를 하셨나요?');
  await agent.interviewAnswer(project, '스프링 프로젝트요', {});
  assert.equal(client.calls[1].messages[2].content, '스프링 프로젝트요');
  assert.equal(project.interview.status, 'done');
});

test('인터뷰: 잘못된 도구 입력은 is_error tool_result로 돌려준다', async () => {
  const project = sampleProject();
  const client = fakeClient((params, i) => {
    if (i === 0) return makeMessage([toolUse('save_experience', { id: '', title: 123 }, 'bad'), toolUse('ask_user', { question: 'q', why: '', example: '' }, 'ok')], { stopReason: 'tool_use' });
    if (i === 1) return makeMessage([toolUse('finish_interview', { summary: 's', writer_notes: '' })], { stopReason: 'tool_use' });
  });
  const agent = createAgent({ client });
  await agent.interviewStart(project, {});
  assert.equal(project.experiences.length, 0);
  await agent.interviewAnswer(project, '답', {});
  const sent = client.calls[1].messages[2].content;
  assert.equal(sent[0].tool_use_id, 'bad');
  assert.equal(sent[0].is_error, true);
  assert.match(sent[0].content, /INVALID_JSON/);
});

test('인터뷰 강제 종료: 모델이 계속 질문해도 done으로 처리', async () => {
  const project = sampleProject();
  const client = fakeClient((params, i) => {
    if (i === 0) return makeMessage([toolUse('ask_user', { question: 'q1', why: '', example: '' }, 'a')], { stopReason: 'tool_use' });
    return makeMessage([toolUse('ask_user', { question: 'q2', why: '', example: '' }, 'b')], { stopReason: 'tool_use' });
  });
  const agent = createAgent({ client });
  await agent.interviewStart(project, {});
  const r = await agent.interviewFinish(project, {});
  assert.equal(r.type, 'done');
  assert.equal(r.forced, true);
  assert.equal(project.interview.status, 'done');
  assert.match(client.calls[1].messages[2].content[0].content, /마치길 원합니다/);
});

test('인터뷰: refusal 은 AgentError(refusal)', async () => {
  const project = sampleProject();
  const client = fakeClient(() => makeMessage([text('')], { stopReason: 'refusal' }));
  const agent = createAgent({ client });
  await assert.rejects(() => agent.interviewStart(project, {}), (e) => e instanceof AgentError && e.code === 'refusal');
});

test('complete: 초안 → 첨삭(약함) → 수정 → 첨삭(좋음) → 글자수 조정', async () => {
  const project = sampleProject();
  upsertExperience(project, { id: '', title: '팀 프로젝트 갈등 조정', situation: '2024 캡스톤', task: '역할 분담 갈등', action: '주간 회의 도입', result: '기한 내 완료', learned: '소통', keywords: ['소통'], question_ids: ['q2'] }, 'manual');
  const q = project.questions[1];
  const stages = [];
  const client = fakeClient((params, i) => {
    const sys = params.system[0].text;
    if (i === 0) return makeMessage([text('```\n[갈등을 대화로]\n초안입니다. 열심히 했습니다.\n```')]);
    if (i === 1) { assert.match(sys, /인사담당자/); assert.equal(params.output_config.format.type, 'json_schema'); return makeMessage([text(weakCritique())]); }
    if (i === 2) { assert.match(params.messages[0].content, /반드시 수정/); return makeMessage([text('수정본. ' + '가'.repeat(1100))]); }
    if (i === 3) return makeMessage([text(goodCritique())]);
    if (i === 4) { assert.match(params.messages[0].content, /줄여서/); return makeMessage([text('최종. ' + '가'.repeat(940))]); }
    throw new Error('too many calls ' + i);
  });
  const agent = createAgent({ client, settings: { effort: 'high', maxRevisions: 2 } });
  const ans = await agent.complete(project, q, { onStage: (s) => stages.push(s) });
  assert.deepEqual(stages, ['draft', 'critique', 'revise', 'critique', 'length', 'done']);
  assert.equal(ans.status, 'done');
  assert.equal(ans.versions.length, 3);
  assert.deepEqual(ans.versions.map((v) => v.label), ['초안', '첨삭 반영 1', '글자수 조정']);
  assert.equal(ans.versions[0].text, '[갈등을 대화로]\n초안입니다. 열심히 했습니다.');
  assert.equal(ans.versions[0].critique.total, 55);
  assert.equal(ans.versions[0].critique.needs_revision, true);
  // 두 번째 첨삭은 점수는 좋지만 글자수 초과 → needs_revision true 였을 것. 하지만 maxRevisions 소진 후 글자수 조정만 수행
  assert.equal(ans.versions[1].critique.length.status, 'over');
  assert.match(currentText(ans), /^최종/);
  assert.equal(client.calls[0].output_config.effort, 'high');
  assert.equal(client.calls[1].output_config.effort, 'medium');
  assert.equal(client.calls[0].system[0].cache_control.type, 'ephemeral');
});

test('complete: 좋은 초안이면 첨삭 한 번으로 끝난다 / 다른 문항 답변이 프롬프트에 포함된다', async () => {
  const project = sampleProject();
  project.answers.q1 = { versions: [{ id: 'v1', label: '초안', text: '이미 쓴 지원동기 답변', createdAt: 1, critique: null }], currentVersionId: 'v1', status: 'done' };
  const client = fakeClient((params, i) => {
    if (i === 0) { assert.match(params.messages[0].content, /이미 쓴 지원동기 답변/); return makeMessage([text('가'.repeat(950))]); }
    if (i === 1) return makeMessage([text(goodCritique())]);
    throw new Error('too many');
  });
  const agent = createAgent({ client });
  const ans = await agent.complete(project, project.questions[1], {});
  assert.equal(ans.versions.length, 1);
  assert.equal(ans.status, 'done');
});

test('critique: JSON 형식 오류는 AgentError(parse)', async () => {
  const project = sampleProject();
  const client = fakeClient(() => makeMessage([text('{"scores": {}}')]));
  const agent = createAgent({ client });
  await assert.rejects(() => agent.critique(project, project.questions[0], '본문'), (e) => e.code === 'parse');
});

test('editAnswer: 새 버전을 추가하고 현재 버전으로 만든다', async () => {
  const project = sampleProject();
  project.answers.q1 = { versions: [{ id: 'v1', label: '초안', text: '원본', createdAt: 1, critique: null }], currentVersionId: 'v1', status: 'done' };
  const client = fakeClient((params) => { assert.match(params.messages[0].content, /더 간결하게/); return makeMessage([text('간결본')]); });
  const agent = createAgent({ client });
  const v = await agent.editAnswer(project, project.questions[0], '더 간결하게', {});
  assert.equal(v.text, '간결본');
  assert.equal(currentText(project.answers.q1), '간결본');
  assert.equal(project.answers.q1.versions.length, 2);
});

test('설정: 폴백 끄기 / 프록시 사용 시 eager 스트리밍 생략 / 폴백 미지원 모델', async () => {
  const project = sampleProject();
  const client = fakeClient(() => makeMessage([toolUse('finish_interview', { summary: 's', writer_notes: '' })], { stopReason: 'tool_use' }));
  await createAgent({ client, settings: { fallbacks: false, baseURL: 'https://proxy.example' } }).interviewStart(project, {});
  assert.ok(!('fallbacks' in client.calls[0]));
  assert.ok(!('betas' in client.calls[0]));
  assert.ok(!('eager_input_streaming' in client.calls[0].tools[0]));
  await createAgent({ client, settings: { model: 'claude-haiku-4-5' } }).interviewStart(sampleProject(), {});
  assert.ok(!('fallbacks' in client.calls[1]));
});

test('중단(signal)하면 AgentError(aborted)', async () => {
  const project = sampleProject();
  const ctrl = new AbortController();
  const client = fakeClient(async () => { ctrl.abort(); return makeMessage([text('x')]); });
  const agent = createAgent({ client });
  await assert.rejects(() => agent.draft(project, project.questions[0], { signal: ctrl.signal }), (e) => e.code === 'aborted');
});

test('인터뷰 중단 후 interviewResume이 마지막 user 턴을 다시 보내 이어간다', async () => {
  const project = sampleProject();
  const ctrl = new AbortController();
  let calls = 0;
  const client = fakeClient(async (params, i) => {
    calls++;
    if (i === 0) return makeMessage([toolUse('ask_user', { question: 'q1', why: '', example: '' }, 'a')], { stopReason: 'tool_use' });
    if (i === 1) { ctrl.abort(); return makeMessage([text('x')]); } // 답변 전송 중 중단
    if (i === 2) return makeMessage([toolUse('ask_user', { question: 'q2', why: '', example: '' }, 'b')], { stopReason: 'tool_use' });
  });
  const agent = createAgent({ client });
  await agent.interviewStart(project, {});
  await assert.rejects(() => agent.interviewAnswer(project, '답변', { signal: ctrl.signal }), (e) => e.code === 'aborted');
  assert.equal(project.interview.status, 'idle', '중단 후 재개 가능한 상태');
  assert.equal(project.interview.messages.at(-1).role, 'user', '히스토리는 user 턴으로 끝남');
  const r = await agent.interviewResume(project, {});
  assert.equal(r.type, 'question');
  assert.equal(r.question.question, 'q2');
  assert.equal(project.interview.status, 'waiting');
  // 재개 요청은 같은 히스토리(첫 질문 + 답변 tool_result)를 그대로 다시 보낸다
  assert.equal(client.calls[2].messages.length, 3);
  assert.equal(client.calls[2].messages[2].content[0].tool_use_id, 'a');
  assert.equal(calls, 3);
});

test('interviewResume: pending 질문이 있으면 API 호출 없이 waiting으로 복구', async () => {
  const project = sampleProject();
  const client = fakeClient(() => makeMessage([toolUse('ask_user', { question: 'q1', why: '', example: '' }, 'a')], { stopReason: 'tool_use' }));
  const agent = createAgent({ client });
  await agent.interviewStart(project, {});
  project.interview.status = 'idle'; // 새로고침으로 running→idle 된 상황
  const r = await agent.interviewResume(project, {});
  assert.equal(r.type, 'question');
  assert.equal(client.calls.length, 1);
});

test('complete 중단 시 오류 메시지를 남기지 않는다', async () => {
  const project = sampleProject();
  const ctrl = new AbortController();
  const client = fakeClient(async () => { ctrl.abort(); return makeMessage([text('x')]); });
  const agent = createAgent({ client });
  await assert.rejects(() => agent.complete(project, project.questions[0], { signal: ctrl.signal }), (e) => e.code === 'aborted');
  assert.equal(project.answers.q1.status, 'idle');
  assert.equal(project.answers.q1.error, '');
});
