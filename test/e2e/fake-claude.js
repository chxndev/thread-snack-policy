// 브라우저에 주입되는 가짜 window.claude (아티팩트 뷰어 흉내). page.addInitScript로 로드된다.
(function () {
  const DRAFT_Q1 = '[성능 개선으로 증명한 집요함]\n저는 문제의 원인을 끝까지 파고들어 수치로 결과를 만드는 개발자입니다. 2024년 캡스톤 프로젝트에서 응답 지연이 3초를 넘는 API를 맡아, 프로파일링으로 N+1 쿼리를 찾아내고 배치 조회로 바꿔 평균 응답 시간을 0.4초로 줄였습니다. 네이버의 대규모 트래픽 환경에서도 같은 방식으로 병목을 찾아 개선하겠습니다. 처음에는 캐시를 붙이자는 팀원 의견이 많았지만, 근본 원인을 먼저 확인하자고 설득해 측정 결과를 공유했습니다. 그 과정에서 숫자로 말하는 습관이 협업을 빠르게 만든다는 것을 배웠습니다. 입사 후에는 검색 플랫폼의 안정성을 책임지는 엔지니어로 성장하고 싶습니다.';
  const DRAFT_Q2 = '[역할을 다시 나눈 회의]\n갈등의 원인은 감정이 아니라 불명확한 역할이라고 판단해 회의 방식을 바꿨습니다. 2024년 캡스톤 프로젝트 초반, 두 팀원이 같은 기능을 중복 구현하면서 서로를 탓하는 상황이 생겼습니다. 저는 주간 회의를 도입해 각자의 담당 범위를 문서로 고정하고, 매주 완료 기준을 함께 확인했습니다. 그 결과 중복 작업이 사라졌고 프로젝트를 기한 안에 완료해 학과 발표에서 우수 팀으로 선정되었습니다. 갈등은 사람의 문제가 아니라 구조의 문제일 때가 많다는 것을 배웠고, 네이버에서도 명확한 합의로 팀의 속도를 높이는 개발자가 되겠습니다.';
  const WEAK = { scores: { fit: 3, specificity: 2, structure: 4, relevance: 3, style: 4, authenticity: 4 }, total: 0, needs_revision: true, must_fix: ['입사 후 목표가 구체적이지 않음'], issues: [{ quote: '검색 플랫폼의 안정성을 책임지는', why: '불분명', fix: '구체적으로', severity: 'high' }], strengths: ['수치'], summary: '목표 서술 약함' };
  const GOOD = { scores: { fit: 5, specificity: 5, structure: 5, relevance: 4, style: 5, authenticity: 5 }, total: 0, needs_revision: false, must_fix: [], issues: [], strengths: ['두괄식', '수치 근거'], summary: '바로 제출해도 좋은 수준' };
  const counters = { interview: 0, critic: 0, writer: 0, jd: 0, prep: 0 };
  window.__fakeCalls = [];

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  async function stream(opts, text) {
    if (opts && typeof opts.onText === 'function') {
      const mid = Math.max(1, Math.floor(text.length / 2));
      opts.onText({ text: text.slice(0, mid), delta: text.slice(0, mid) });
      await delay(5);
      opts.onText({ text, delta: text.slice(mid) });
    }
  }

  function respond(input, opts, kind) {
    const tier = (opts && opts.modelTier) || 'default';
    window.__fakeCalls.push({ kind, tier, cache: opts && opts.cache, turns: Array.isArray(input) ? input.length : 0, head: (Array.isArray(input) ? input[0].content : input).slice(0, 40) });
    if (Array.isArray(input)) {
      counters.interview += 1;
      const n = counters.interview;
      const last = input[input.length - 1].content;
      if (n === 1) return { saved: [], question: { question: '먼저 자소서 문항들에 쓸 수 있을 만한 경험 후보를 2~3개만 간단히 알려 주세요.', why: '전체 그림을 먼저 잡으려고요.', example: '예: 캡스톤 프로젝트, 동아리 운영, 인턴' }, finish: null };
      if (n === 2) return { saved: [{ id: '', title: '캡스톤 API 응답 3초→0.4초 개선', situation: '2024년 캡스톤 프로젝트, 4인 팀', task: '응답 지연 API 개선', action: '프로파일링으로 N+1 쿼리 발견, 배치 조회로 변경', result: '평균 응답 0.4초', learned: '근본 원인 측정의 중요성', keywords: ['성능 개선', '문제 해결'], question_ids: ['q1'] }], question: { question: '그 프로젝트에서 팀원과 의견이 갈렸던 순간이 있었나요? 어떻게 풀었는지 구체적으로 알려 주세요.', why: '협업 문항에 쓸 갈등 경험을 찾고 있어요.', example: '' }, finish: null };
      if (!/저장됨: id=exp_/.test(last)) throw { code: 'invalid_request', message: 'expected save note in the user turn' };
      return { saved: [{ id: '', title: '주간 회의 도입으로 역할 갈등 해결', situation: '2024년 캡스톤 초반', task: '기능 중복 구현과 팀원 갈등', action: '주간 회의 도입, 담당 범위 문서화', result: '기한 내 완료, 우수 팀 선정', learned: '갈등은 구조 문제', keywords: ['협업', '소통'], question_ids: ['q2'] }], question: null, finish: { summary: '문제의 근본 원인을 측정으로 찾고 구조로 해결하는 지원자.', writer_notes: 'q1은 성능 개선 카드, q2는 주간 회의 카드를 중심으로.' } };
    }
    const u = input;
    if (/채용 분석가/.test(u)) { counters.jd += 1; return { company: '네이버', role: '백엔드 개발', level: 'new', questions: [{ text: '지원하신 부문을 결정한 계기와, 입사 후 성장 목표를 작성해 주세요.', limit: 1000, mode: 'unknown', type: 'motivation' }, { text: '팀원과 협업하며 갈등을 해결한 경험을 작성해 주세요.', limit: 700, mode: 'with', type: 'teamwork' }], competencies: ['Java/Spring', '대규모 트래픽', '문제 해결'], talent: '도전과 협업을 중시', notes: '수치 기반 성과를 강조' }; }
    if (/면접관/.test(u)) { counters.prep += 1; return { questions: [{ question: 'N+1 쿼리를 어떻게 발견했나요?', intent: '기술 판단 검증', strategy: '측정 수치를 순서대로.', based_on: 'q1' }, { question: '주간 회의 도입에 반대는 없었나요?', intent: '진정성', strategy: '반대 의견과 설득 과정.', based_on: 'q2' }] }; }
    if (/평가위원/.test(u)) { counters.critic += 1; return counters.critic % 2 === 1 ? WEAK : GOOD; }
    counters.writer += 1;
    const isQ2 = /\[문항\]\nq2\.|\[작성할 문항\]\nq2\./.test(u);
    const base = isQ2 ? DRAFT_Q2 : DRAFT_Q1;
    if (/\[첨삭 결과\]/.test(u)) return base.replace('입사 후에는', '입사 후 2년 안에는 검색 인프라 팀에서 장애 대응 자동화를 맡고,').replace('성장하고 싶습니다.', '성장하겠습니다.');
    if (/내용과 구조는 유지하고 글자수만/.test(u)) {
      const cur = (u.match(/\[현재 답변\]\n([\s\S]*?)\n현재 글자수:/) || [])[1] || base;
      const m = u.match(/목표 (\d+)~(\d+)자/); const min = m ? Number(m[1]) : 0; const max = m ? Number(m[2]) : 0;
      let out = cur; const filler = ' 당시 팀원들과 매일 15분씩 진행 상황을 맞추며 병목을 함께 확인했습니다.';
      while (max && Array.from(out).length < min) out += filler;
      if (max && Array.from(out).length > max) out = Array.from(out).slice(0, max - 1).join('') + '.';
      return out;
    }
    if (/\[이미 작성된 버전/.test(u)) return base.replace('[', '[대안 ');
    if (/\[수정할 구간/.test(u)) return base.replace('숫자로 말하는 습관', '측정값을 공유하는 습관');
    if (/\[사용자 요청\]/.test(u)) return base + '\n(요청 반영)';
    return base;
  }

  async function sample(input, opts) {
    await delay(5);
    const out = respond(input, opts, 'text');
    const text = typeof out === 'string' ? out : JSON.stringify(out);
    await stream(opts, text);
    return { text, truncated: false, modelTierApplied: (opts && opts.modelTier) || 'default' };
  }
  sample.json = async function (input, opts) {
    await delay(5);
    const out = respond(input, opts, 'json');
    const text = typeof out === 'string' ? out : JSON.stringify(out);
    await stream(opts, text);
    return JSON.parse(text);
  };
  sample.limits = async () => ({ maxPromptBytes: 262144 });
  window.__fakeCounters = counters;
  window.claude = {
    use: async (name) => {
      await delay(20);
      if (name === 'sample') return sample;
      if (name === 'downloads') return { save: async ({ filename, data }) => { window.__saved = { filename, size: String(data).length }; } };
      return null;
    },
  };
})();
