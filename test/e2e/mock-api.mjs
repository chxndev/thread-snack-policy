// 브라우저 E2E용 Anthropic Messages API 모의 응답기.
// 요청의 system 프롬프트·tools·output_config로 어느 단계인지 판별해 SSE 스트림을 돌려준다.

function chunks(str, n) {
  const out = [];
  for (let i = 0; i < str.length; i += n) out.push(str.slice(i, i + n));
  return out.length ? out : [''];
}

/** Message 객체 → SSE 본문 */
export function toSSE(message) {
  const ev = [];
  const push = (type, data) => ev.push(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  push('message_start', {
    type: 'message_start',
    message: { id: 'msg_mock', type: 'message', role: 'assistant', model: message.model ?? 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 } },
  });
  message.content.forEach((block, index) => {
    if (block.type === 'thinking') {
      push('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      push('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'mock-signature' } });
      push('content_block_stop', { type: 'content_block_stop', index });
    } else if (block.type === 'text') {
      push('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const c of chunks(block.text, 24)) push('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: c } });
      push('content_block_stop', { type: 'content_block_stop', index });
    } else if (block.type === 'tool_use') {
      push('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      for (const c of chunks(JSON.stringify(block.input), 20)) push('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: c } });
      push('content_block_stop', { type: 'content_block_stop', index });
    }
  });
  push('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: 320 } });
  push('message_stop', { type: 'message_stop' });
  return ev.join('');
}

const text = (t) => ({ type: 'text', text: t });
const tool = (name, input, id) => ({ type: 'tool_use', id, name, input });

function userText(body) {
  const last = body.messages[body.messages.length - 1];
  if (typeof last.content === 'string') return last.content;
  return last.content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? String(b.content) : '')).join('\n');
}
function firstUserText(body) {
  const first = body.messages[0];
  return typeof first.content === 'string' ? first.content : first.content.map((b) => b.text ?? '').join('\n');
}

const DRAFT_Q1 = '[성능 개선으로 증명한 집요함]\n저는 문제의 원인을 끝까지 파고들어 수치로 결과를 만드는 개발자입니다. 2024년 캡스톤 프로젝트에서 응답 지연이 3초를 넘는 API를 맡아, 프로파일링으로 N+1 쿼리를 찾아내고 배치 조회로 바꿔 평균 응답 시간을 0.4초로 줄였습니다. 네이버의 대규모 트래픽 환경에서도 같은 방식으로 병목을 찾아 개선하겠습니다. 처음에는 캐시를 붙이자는 팀원 의견이 많았지만, 근본 원인을 먼저 확인하자고 설득해 측정 결과를 공유했습니다. 그 과정에서 숫자로 말하는 습관이 협업을 빠르게 만든다는 것을 배웠습니다. 입사 후에는 검색 플랫폼의 안정성을 책임지는 엔지니어로 성장하고 싶습니다.';
const DRAFT_Q2 = '[역할을 다시 나눈 회의]\n갈등의 원인은 감정이 아니라 불명확한 역할이라고 판단해 회의 방식을 바꿨습니다. 2024년 캡스톤 프로젝트 초반, 두 팀원이 같은 기능을 중복 구현하면서 서로를 탓하는 상황이 생겼습니다. 저는 주간 회의를 도입해 각자의 담당 범위를 문서로 고정하고, 매주 완료 기준을 함께 확인했습니다. 그 결과 중복 작업이 사라졌고 프로젝트를 기한 안에 완료해 학과 발표에서 우수 팀으로 선정되었습니다. 갈등은 사람의 문제가 아니라 구조의 문제일 때가 많다는 것을 배웠고, 네이버에서도 명확한 합의로 팀의 속도를 높이는 개발자가 되겠습니다.';

const WEAK = JSON.stringify({
  scores: { fit: 3, specificity: 2, structure: 4, relevance: 3, style: 4, authenticity: 4 },
  total: 0, needs_revision: true,
  must_fix: ['문항이 요구한 "입사 후 목표"가 마지막 한 문장에 그쳐 구체성이 부족합니다.'],
  issues: [{ quote: '검색 플랫폼의 안정성을 책임지는', why: '어떤 역할로 무엇을 하겠다는 것인지 불분명', fix: '담당하고 싶은 시스템과 1~2년 내 목표를 구체적으로', severity: 'high' }],
  strengths: ['수치(3초→0.4초)가 명확함'], summary: '경험은 좋으나 목표 서술이 약함',
});
const GOOD = JSON.stringify({
  scores: { fit: 5, specificity: 5, structure: 5, relevance: 4, style: 5, authenticity: 5 },
  total: 0, needs_revision: false, must_fix: [], issues: [],
  strengths: ['두괄식', '수치 근거'], summary: '바로 제출해도 좋은 수준',
});

export function createMockApi() {
  const counters = { interview: 0, critic: 0, writer: 0, jd: 0, prep: 0 };
  const log = [];

  function respond(body) {
    const system = Array.isArray(body.system) ? body.system.map((b) => b.text).join('\n') : String(body.system ?? '');
    const model = body.model;
    const u = userText(body);
    log.push({ model, system: system.slice(0, 30), user: u.slice(0, 80), tools: !!body.tools, format: !!body.output_config?.format, betas: body.betas, fallbacks: body.fallbacks, cache: body.cache_control });

    if (body.tools) {
      counters.interview += 1;
      const n = counters.interview;
      if (n === 1) {
        return { model, stop_reason: 'tool_use', content: [
          { type: 'thinking' },
          tool('ask_user', { question: '먼저 자소서 문항들에 쓸 수 있을 만한 경험 후보를 2~3개만 간단히 알려 주세요.', why: '전체 그림을 먼저 잡으려고요.', example: '예: 캡스톤 프로젝트, 동아리 운영, 인턴' }, 'toolu_ask1'),
        ] };
      }
      if (n === 2) {
        return { model, stop_reason: 'tool_use', content: [
          tool('save_experience', { id: '', title: '캡스톤 API 응답 3초→0.4초 개선', situation: '2024년 캡스톤 프로젝트, 4인 팀', task: '응답 지연 API 개선', action: '프로파일링으로 N+1 쿼리 발견, 배치 조회로 변경', result: '평균 응답 0.4초', learned: '근본 원인 측정의 중요성', keywords: ['성능 개선', '문제 해결'], question_ids: ['q1'] }, 'toolu_save1'),
          tool('ask_user', { question: '그 프로젝트에서 팀원과 의견이 갈렸던 순간이 있었나요? 어떻게 풀었는지 구체적으로 알려 주세요.', why: '협업 문항에 쓸 갈등 경험을 찾고 있어요.', example: '' }, 'toolu_ask2'),
        ] };
      }
      if (u.includes('마치길 원합니다') || n >= 3) {
        return { model, stop_reason: 'tool_use', content: [
          tool('save_experience', { id: '', title: '주간 회의 도입으로 역할 갈등 해결', situation: '2024년 캡스톤 초반', task: '기능 중복 구현과 팀원 갈등', action: '주간 회의 도입, 담당 범위 문서화', result: '기한 내 완료, 우수 팀 선정', learned: '갈등은 구조 문제', keywords: ['협업', '소통'], question_ids: ['q2'] }, 'toolu_save2'),
          tool('finish_interview', { summary: '문제의 근본 원인을 측정으로 찾고 구조로 해결하는 지원자.', writer_notes: 'q1은 성능 개선 카드, q2는 주간 회의 카드를 중심으로.' }, 'toolu_fin'),
        ] };
      }
    }
    if (body.output_config?.format) {
      if (system.includes('채용 분석가')) {
        counters.jd += 1;
        return { model, content: [text(JSON.stringify({
          company: '네이버', role: '백엔드 개발', level: 'new',
          questions: [
            { text: '지원하신 부문을 결정한 계기와, 입사 후 성장 목표를 작성해 주세요.', limit: 1000, mode: 'unknown', type: 'motivation' },
            { text: '팀원과 협업하며 갈등을 해결한 경험을 작성해 주세요.', limit: 700, mode: 'with', type: 'teamwork' },
          ],
          competencies: ['Java/Spring', '대규모 트래픽', '문제 해결'], talent: '도전과 협업을 중시', notes: '수치 기반 성과를 강조',
        }))] };
      }
      if (system.includes('면접관')) {
        counters.prep += 1;
        return { model, content: [text(JSON.stringify({ questions: [
          { question: 'N+1 쿼리를 어떻게 발견했고, 캐시 대신 배치 조회를 택한 이유는 무엇인가요?', intent: '기술 판단의 근거 검증', strategy: '프로파일링 도구와 측정 수치를 순서대로 말한다.', based_on: 'q1' },
          { question: '주간 회의를 도입할 때 반대는 없었나요?', intent: '갈등 조정 과정의 진정성', strategy: '반대 의견과 설득 과정을 구체적 장면으로.', based_on: 'q2' },
        ] }))] };
      }
      counters.critic += 1;
      return { model, content: [text(counters.critic % 2 === 1 ? WEAK : GOOD)] };
    }
    // 작성자
    counters.writer += 1;
    const isQ2 = /\[문항\]\nq2\.|\[작성할 문항\]\nq2\./.test(u);
    const base = isQ2 ? DRAFT_Q2 : DRAFT_Q1;
    if (u.includes('[첨삭 결과]')) return { model, content: [text(base.replace('입사 후에는', '입사 후 2년 안에는 검색 인프라 팀에서 장애 대응 자동화를 맡고,').replace('성장하고 싶습니다.', '성장하겠습니다.'))] };
    if (u.includes('내용과 구조는 유지하고 글자수만')) {
      // 현재 답변을 목표 범위에 맞춰 실제로 줄이거나 늘린다
      const cur = (u.match(/\[현재 답변\]\n([\s\S]*?)\n현재 글자수:/) ?? [])[1] ?? base;
      const [, lo, hi] = u.match(/목표 (\d+)~(\d+)자/) ?? [];
      const min = Number(lo ?? 0); const max = Number(hi ?? 0);
      let out = cur;
      const filler = ' 당시 팀원들과 매일 15분씩 진행 상황을 맞추며 병목을 함께 확인했습니다.';
      while (max && Array.from(out).length < min) out += filler;
      if (max && Array.from(out).length > max) out = Array.from(out).slice(0, max - 1).join('') + '.';
      return { model, content: [text(out)] };
    }
    if (u.includes('[이미 작성된 버전')) return { model, content: [text(base.replace('[', '[대안 ').replace('저는 문제의', '결과부터 말씀드리면, 저는 문제의'))] };
    if (u.includes('[수정할 구간')) return { model, content: [text(base.replace('숫자로 말하는 습관', '측정값을 공유하는 습관'))] };
    if (u.includes('[사용자 요청]')) return { model, content: [text(base + '\n(요청 반영)')] };
    return { model, content: [text(base)] };
  }

  return { respond, counters, log };
}
