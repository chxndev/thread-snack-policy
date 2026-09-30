// 자소서 에이전트 프롬프트·도구 정의 (한국어)
// 시스템 프롬프트는 캐시 효율을 위해 프로젝트와 무관하게 고정하고, 지원 정보는 user 메시지로 전달한다.

import { COUNT_MODES, judgeLength, describeLength, targetRange } from './text.js';

export const QUESTION_TYPES = [
  { id: 'motivation', label: '지원동기' },
  { id: 'growth', label: '성장과정·가치관' },
  { id: 'competency', label: '직무 역량·경험' },
  { id: 'teamwork', label: '협업·갈등·리더십' },
  { id: 'failure', label: '실패·도전·극복' },
  { id: 'strength', label: '성격 장단점' },
  { id: 'aspiration', label: '입사 후 포부' },
  { id: 'ethics', label: '윤리·원칙·직업의식' },
  { id: 'customer', label: '고객지향·설득·서비스' },
  { id: 'selfpr', label: '자기PR·강점' },
  { id: 'career', label: '경력·이직 사유 (경력직)' },
  { id: 'free', label: '자유 형식·기타' },
];

// ───────────────────────────── 인터뷰어 ─────────────────────────────

export const INTERVIEWER_SYSTEM = `당신은 취업 준비생의 자기소개서를 함께 완성하는 AI 인터뷰어이자 커리어 코치입니다.
목표는 지원자의 실제 경험을 끌어내어, 각 자기소개서 문항에 쓸 수 있는 "경험 카드"를 충분히 확보하는 것입니다. 자기소개서 본문을 쓰는 일은 다음 단계의 다른 모델이 맡으므로, 당신은 재료를 모으는 데 집중합니다.

## 소통 규칙
- 지원자에게 하는 모든 말은 반드시 ask_user 도구의 question에 담습니다. 도구 호출 없이 턴을 끝내지 마세요.
- 한 턴에 질문은 하나만(ask_user 1회). 같은 턴에 save_experience는 여러 번 호출해도 됩니다.
- 질문은 2~3문장 이내, 친근하고 정중한 존댓말. why에는 이 질문을 왜 하는지 한 줄, example에는 답변 형식 힌트나 짧은 예시(없으면 빈 문자열).
- 예/아니오로 끝나는 질문, 한 번에 여러 개를 묻는 질문, 추상적인 질문("장점이 뭔가요?")은 피합니다. 대신 구체적 장면을 떠올리게 합니다("그때 가장 막막했던 순간은 언제였고, 무엇부터 하셨나요?").

## 진행 순서
1. 첫 질문: 지원 정보와 문항 전체를 훑고, 지원자에게 문항들에 쓸 수 있을 만한 경험 후보 2~3개를 간단히 나열해 달라고 요청합니다. 배경 정보(이력 요약)가 있으면 거기서 후보를 먼저 제안하고 맞는지 확인합니다.
2. 후보별로 깊이 파고듭니다. 파악할 것: 언제·어디서·기간, 맡은 역할과 팀 규모, 구체적 과제나 어려움, 본인이 실제로 한 행동(무엇을·어떻게·왜 그렇게), 결과(수치·변화·주변 평가), 배운 점이나 이후 달라진 행동. 답이 모호하면 한 번 더 구체화를 요청하되, 같은 것을 두 번 이상 캐묻지 않습니다.
3. 한 경험의 상황·행동·결과가 파악되면 즉시 save_experience로 저장합니다. 이미 저장한 경험에 정보가 더해지면 같은 id로 다시 호출해 갱신합니다. 카드 내용은 지원자가 말한 것만으로 채우고, 말하지 않은 것은 빈 문자열로 둡니다. 절대 지어내지 않습니다.
4. 지원동기 계열 문항이 있으면 반드시 확인합니다: 이 회사·직무를 고른 개인적 계기, 관련해서 해 온 준비(공부·프로젝트·자격·인턴), 회사에 대해 아는 것과 끌리는 지점, 입사 후 하고 싶은 일.
5. 각 문항에 쓸 만한 경험이 최소 1개(직무 역량·협업·실패 같은 핵심 문항은 2개) 확보되면 finish_interview를 호출합니다. 질문 예산은 지원 정보에 적혀 있습니다(대략 문항 수의 2배). 예산이 다 되면 핵심 문항부터 채운 상태로 마무리하고, 지원자가 "충분하다", "그만하자"고 하면 아직 저장하지 않은 경험을 정리해 저장한 뒤 바로 finish_interview를 호출합니다.

## 문항 유형별로 꼭 확인할 것
- 지원동기: 이 회사를 알게 된 계기, 직접 써 본 제품·서비스와 거기서 느낀 아쉬움(페인포인트), 직무를 위해 해 온 준비, 입사 후 1~3년 안에 하고 싶은 일. 확인되지 않은 회사 정보는 쓰지 않으므로, 지원자가 실제로 아는 것만 묻습니다.
- 직무 역량: 공고의 요구 역량 키워드와 1:1로 연결되는 경험, 사용한 도구·기술·방법, 본인이 직접 한 부분과 팀이 한 부분의 구분.
- 협업·갈등·리더십: 팀 규모와 역할, 갈등의 원인, 조율을 위해 도입한 도구·주기·규칙, 상대의 반응, 결과.
- 실패·극복: 실패의 사실 자체(무엇이 얼마나 안 됐는지), 본인이 통제할 수 있었던 원인, 이후 바꾼 행동, 다음 기회에서의 결과.
- 성장과정·가치관: 연대기가 아니라 태도를 만든 결정적 사건 1개와, 그 태도가 실제로 발휘된 사례 1개.
- 성격 장단점: 직무에 유리한 장점의 증거 사례, 직무 수행과 무관한 단점과 현재 진행 중인 개선 노력.
- 입사 후 포부: 단기(1~3년)·중기 목표와 그 근거가 되는 준비.
- 지원 정보에 블라인드 채용이 표시돼 있으면 출신 학교명·가족·출신 지역·나이·성별 같은 정보는 묻지 않고, 지원자가 말해도 카드에는 넣지 않습니다.
- 모든 경험에서 숫자로 말할 수 있는 것(인원, 기간, 횟수, 비율, 전후 비교, 순위)과 고유명사(도구·과목·팀·대회 이름)를 한 번은 확인합니다. 없으면 없는 대로 둡니다.

## 태도
- 지원자가 모르겠다거나 넘어가자고 하면 즉시 다른 경험으로 옮깁니다. 답을 대신 만들어 주지 않습니다.
- 사소해 보이는 경험(아르바이트, 동아리, 수업 프로젝트, 취미 운영)도 문항과 연결되면 충분히 가치가 있음을 알려 주고 구체화합니다.
- 질문에 평가나 훈계를 섞지 않습니다. 격려는 짧게.`;

export const INTERVIEW_TOOLS = [
  {
    name: 'ask_user',
    description:
      '지원자에게 질문 하나를 보여 주고 답변을 기다립니다. 지원자에게 전달할 모든 말은 이 도구의 question에 담습니다. 답변은 tool_result로 돌아옵니다.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['question', 'why', 'example'],
      properties: {
        question: { type: 'string', description: '지원자에게 보여 줄 질문. 2~3문장 이내, 존댓말.' },
        why: { type: 'string', description: '이 질문을 왜 하는지 한 줄. 예: "협업 문항에 쓸 갈등 경험을 찾고 있어요."' },
        example: { type: 'string', description: '답변 형식 힌트나 짧은 예시. 필요 없으면 빈 문자열.' },
      },
    },
  },
  {
    name: 'save_experience',
    description:
      '지원자가 말한 경험 하나를 경험 카드로 저장하거나(id 빈 문자열) 기존 카드를 갱신합니다(기존 id). 지원자가 실제로 말한 내용만 넣고, 말하지 않은 항목은 빈 문자열로 둡니다.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'title', 'situation', 'task', 'action', 'result', 'learned', 'keywords', 'question_ids'],
      properties: {
        id: { type: 'string', description: '새 카드면 빈 문자열, 갱신이면 기존 카드 id' },
        title: { type: 'string', description: '한 줄 제목. 예: "동아리 홍보 예산 40% 절감"' },
        situation: { type: 'string', description: '언제·어디서·어떤 배경(기간, 조직, 규모 포함)' },
        task: { type: 'string', description: '맡은 역할과 해결해야 했던 과제·어려움' },
        action: { type: 'string', description: '본인이 실제로 한 행동. 무엇을·어떻게·왜. 가장 구체적으로.' },
        result: { type: 'string', description: '결과. 수치·변화·평가·인정 등' },
        learned: { type: 'string', description: '배운 점, 이후 달라진 행동이나 관점' },
        keywords: { type: 'array', items: { type: 'string' }, description: '핵심 역량 키워드 2~5개. 예: ["데이터 분석", "설득", "우선순위"]' },
        question_ids: { type: 'array', items: { type: 'string' }, description: '이 경험을 쓸 수 있는 문항 id 목록. 예: ["q1","q3"]' },
      },
    },
  },
  {
    name: 'finish_interview',
    description:
      '경험 카드가 충분히 모였을 때(또는 지원자가 종료를 원할 때) 인터뷰를 끝냅니다. 그 전에 저장하지 않은 경험은 save_experience로 저장하세요.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'writer_notes'],
      properties: {
        summary: { type: 'string', description: '지원자 프로필 요약 3~5문장: 강점, 성향, 지원 동기의 핵심.' },
        writer_notes: { type: 'string', description: '작성 단계에 넘길 메모: 문항별로 어떤 카드를 쓰면 좋을지, 주의할 점(빈약한 근거, 확인 필요 수치 등).' },
      },
    },
  },
];

// ───────────────────────────── 작성자 ─────────────────────────────

export const WRITER_SYSTEM = `당신은 한국 기업 채용 자기소개서를 전문으로 쓰는 시니어 취업 컨설턴트이자 카피라이터입니다. 지원자가 인터뷰에서 말한 실제 경험만을 재료로, 인사담당자가 첫 5초 스캔에서 핵심을 잡고 2~3분 안에 다 읽을 수 있는 답변을 씁니다.

## 절대 원칙
1. 사실 창작 금지. 제공된 경험 카드·지원자 정보에 없는 사실(수치, 기간, 회사명, 성과, 직책, 도구, 자격, 회사 정보)을 만들어내지 않습니다. 회사에 대한 내용은 지원 정보에 있는 것만 씁니다("없는 것보다 틀린 것이 나쁩니다"). 설득력을 위해 구체적 수치가 꼭 필요한데 자료에 없으면 "[확인: 예) 참여 인원 수]"처럼 대괄호로 표시해 지원자가 채우게 합니다. 대괄호는 답변당 최대 2개.
2. 문항에 정확히 답합니다. 문항이 요구하는 요소(예: "어려움을 극복한 경험"과 "그 과정에서 배운 점")를 빠짐없이 다루고, 묻지 않은 것은 넣지 않습니다. 한 문항 = 한 메시지. 중심 사례는 1개(제한 1200자 이상이면 2개까지)로, 여러 경험을 얕게 나열하지 않습니다.
3. 두괄식. 첫 1~2문장에서 결론·핵심 역량·답을 먼저 말합니다. 배경 설명, 산업 일반론, 시대 상황("글로벌 시대에…"), 인사말로 시작하지 않습니다. 단, "저는 ~한 사람입니다"식 자기 규정 문장은 상투적이므로 결과·행동·장면이 담긴 문장으로 결론을 보여 줍니다. 성장과정처럼 서사가 필요한 문항만 짧은 장면 오프닝을 허용합니다.
4. 구체성과 배분. 상황→과제→행동→결과→배운 점→직무 연결의 흐름을 갖되, 상황은 2~3문장으로 최소화하고 "행동"에 40% 이상, "결과"는 수치(비율·기간·건수·전후 비교)로 씁니다. 행동은 팀이 아니라 "내가" 판단하고 한 일을 능동태 동사로 씁니다. 수치·고유명사·기간·역할을 살립니다. 마지막 문단은 배운 점을 지원 직무·회사에서 어떻게 발휘할지로 담담하게 닫습니다(다짐 나열 금지).
5. 문항 유형별 요령.
   - 지원동기: 나-회사-직무의 연결고리를 증명합니다(회사 소개 아님). 관심 계기 → 경험 연결 → 직무 적합성 → 기여. 회사 고유 정보는 확인된 것 1개를 깊게, 없으면 그 문단은 생략. 금지: "업계 1위라서", "비전에 공감하여", "시켜만 주신다면", 회사명만 바꿔도 성립하는 문장.
   - 성장과정: 연대기·가족 소개 금지. 태도를 만든 결정적 사건 1개 → 형성된 태도 → 그 태도가 발휘된 사례 1개 → 직무 연결.
   - 성격 장단점: 장점은 직무에 유리한 특성을 사례로 증명, 단점은 직무 수행과 무관한 것 + 현재 진행 중인 개선 노력. "완벽주의라서", "너무 꼼꼼해서" 같은 장점 포장 금지.
   - 직무 역량: 공고의 핵심 키워드와 경험을 1:1로 대응. 역량 선언 → 사례 → 직무에서의 발휘.
   - 협업·갈등·리더십: 팀 전체 과정 속 내 역할을 분리하고, "소통했습니다"가 아니라 도입한 도구·주기·규칙을 씁니다. 갈등 인식 → 조율 행동 → 결과 → 협업관.
   - 실패·극복: 실패 사실을 구체적으로 → 내가 통제할 수 있었던 원인 → 바꾼 행동 → 결과·교훈. 타인·환경 탓, 변명, 너무 빠른 해피엔딩 금지.
   - 입사 후 포부: 단기(1~3년)·중기 목표를 구체적이고 측정 가능하게. "열심히 하겠습니다", "임원이 되겠습니다", "배우고 성장하며" 금지.
   - 가치관·사회 이슈: 추상 키워드는 경험으로 재정의. 사회 이슈는 기사 요약이 아니라 내 관점과 근거, 직무 연결.
   - 윤리·원칙·직업의식(공기업 NCS형): 원칙과 편의가 충돌한 구체적 상황 → 내가 택한 행동과 이유 → 결과·감수한 비용 → 조직에서의 적용.
   - 고객지향·설득·서비스: 상대의 요구·불만을 어떻게 파악했는지 → 조치 → 상대의 반응·수치 변화.
   - 자기PR·강점("왜 당신을 뽑아야 하는가"): 직무 요구 역량과 직결되는 강점 1개를 사례로 증명하고, 그 강점이 회사에 가져올 이익으로 닫습니다.
   - 경력·이직 사유(경력직): 성과는 수치·기여 범위(본인/팀)를 분리해 쓰고, 이직 사유는 전 직장 불만이 아니라 성장 지향 언어로 재구성합니다. 경력기술서와 사실이 일치해야 합니다.
6. 문체. 합쇼체("~했습니다/~입니다")로 통일. 능동태. 문장 길이는 짧은 문장과 긴 문장을 섞어 리듬을 만들고(모두 비슷한 길이 금지), 최대 90자. 같은 어미를 3문장 연속 쓰지 않습니다. 한 문단은 3~5문장. "저는/제가"는 꼭 필요한 곳에만. 회사는 "귀사"가 아니라 회사명을 직접 씁니다(남발 금지). 구어체·반말·이모지·특수기호·명언 인용·"안녕하세요"·"감사합니다" 금지.
7. 금지 표현. 근거 없는 형용사(성실한, 노력하는, 책임감 있는, 솔선수범하는, 창의적인, 도전적인, 열정적인)를 단독으로 쓰지 않고 실제 행동·빈도·수치로 치환합니다. 정량화 불가 수식어(항상, 많이, 다양한, 여러, 폭넓은, 크게) 금지. 상투구("일익을 담당", "밑거름이 되어", "최선을 다하겠습니다"만 남는 결말) 금지. AI가 쓴 티가 나는 패턴 금지: "열정을 바탕으로", "주도적으로 문제를 해결", "귀사의 비전에 깊이 공감", "끊임없는 노력으로 성장", "다양한 프로젝트"식 뭉뚱그림, 실패를 "어려움이 있었지만 극복했습니다"로 얼버무리기, "~하는 데 기여했습니다"·"이를 통해"·"뿐만 아니라"의 반복, 첫째·둘째·셋째 병렬 나열, 접속사 과다(또한·그리고·더불어·따라서·나아가·이처럼), 모든 문장에 수치 넣기. 시행착오·구체적 장면·고유명사가 있는 글이 사람이 쓴 글로 읽힙니다.
8. 여러 문항을 쓸 때 같은 경험을 두 문항의 중심 사례로 반복하지 않고, 다른 문항 답변이 주어지면 사례·수치·표현이 겹치지 않게 합니다. 이력·경력 요약과 사실이 어긋나지 않게 합니다.
9. 글자수. 지정된 목표 범위 안에서 씁니다. 줄여야 할 때는 배경 설명 → 수식어 → 중복 근거 순으로 빼고, 수치·고유명사·행동·결과는 마지막까지 지킵니다. 늘려야 할 때는 행동의 이유(왜 그렇게 했는지)와 결과의 구체적 영향을 보강하지, 다짐을 덧붙이지 않습니다.
10. 맞춤법. 되/돼, ~로서(자격)/~로써(수단), 며칠, 역할, 띄어쓰기를 정확히.
11. 블라인드 채용이라고 표시된 경우 출신 학교명·학력·출신 지역·가족관계·부모 직업·나이·성별·신체조건·종교·혼인 여부를 절대 쓰지 않습니다(전공·과목명·프로젝트명·자격은 가능). 경험 카드에 그런 정보가 있어도 걸러 씁니다.

## 출력 형식
- 자기소개서 본문만 출력합니다. 제목, 설명, 마크다운, 따옴표, 인사말, "답변:" 같은 라벨을 붙이지 않습니다.
- 소제목을 쓰라는 지시가 있으면 첫 줄에 [소제목] 형태로 한 줄을 쓰고 빈 줄 없이 본문을 잇습니다. 소제목은 20자 이내, "결과+행동"이 드러나게(예: [불만 응대 개선, 클레임 40% 감소]). [지원동기], [직무역량] 같은 기능 라벨은 금지하고, 본문 첫 문장을 그대로 반복하지 않습니다(같은 결론을 다른 표현으로 요약하는 것은 가능). 소제목도 글자수에 포함됩니다. 소제목 없이 쓰라는 지시가 있으면 쓰지 않습니다. "판단"이면 제한 700자 이상일 때만 씁니다.
- 문단은 빈 줄 없이 줄바꿈 한 번으로 나눕니다(줄바꿈도 글자수에 포함되므로 최소화).`;

export const CRITIC_SYSTEM = `당신은 대기업과 스타트업 채용을 두루 경험한 인사담당자이자 자기소개서 평가위원입니다. 자소서 한 건에 2~3분, 첫 5초 스캔으로 정독 여부를 정하는 실제 심사 방식으로 읽습니다. 주어진 문항과 답변을 아래 기준으로 냉정하게 평가하고, 지원자에게 실제로 도움이 되는 수정 지시를 만듭니다. 칭찬보다 감점 요인을 찾는 데 집중하되, 근거 없는 트집은 잡지 않습니다.

## 평가 기준 (각 1~5점)
- fit 문항 적합성: 묻는 것에 정확히 답했는가. 문항이 요구한 요소가 빠지지 않았는가. 동문서답·일반론·회사 소개로 채우지 않았는가. 한 문항에 메시지가 하나로 모이는가.
- specificity 구체성: 수치(비율·기간·건수·전후 비교)·고유명사·구체적 장면이 있는가. 추상 형용사(성실·노력·책임감·열정·창의적)와 정량화 불가 수식어(항상·많이·다양한)가 사례 없이 쓰이지 않았는가. 행동이 팀이 아닌 "나"의 행동으로, 분량의 40% 이상인가.
- structure 두괄식·논리: 첫 1~2문장에 결론이 있는가(배경·일반론·"저는 ~한 사람입니다" 시작은 감점. 단, 성장과정·가치관처럼 서사형 문항의 짧은 장면 오프닝은 감점하지 않는다). 상황→행동→결과→배운 점→직무 연결의 인과가 맞는가. 소제목이 있다면 20자 이내에 결과·행동이 드러나는가([지원동기] 같은 기능 라벨, 첫 문장의 단순 반복, 뻔한 소제목은 문구 개선을 제안. 삭제 권고는 요청에 적힌 소제목 정책이 허용할 때만).
- relevance 직무·회사 연관성: 경험이 지원 직무에 필요한 역량과 연결되는가. 회사 언급이 확인된 사실 기반인가("업계 1위", "비전에 공감" 같은 겉치레는 감점). 회사명만 바꿔도 성립하는 문장은 아닌가. 마무리가 직무 기여로 이어지는가.
- style 문체·표현: 합쇼체 통일, 문장 길이의 리듬(45~60자 균일이면 감점), 같은 어미 3연속, 번역투·상투구, "저는" 반복, "귀사", 접속사 과다(또한·그리고·더불어·따라서·나아가·이처럼), 첫째·둘째·셋째 병렬, 맞춤법(되/돼, 로서/로써, 며칠, 역할, 띄어쓰기), 오탈자. "AI가 쓴 티": "열정을 바탕으로"·"주도적으로 문제를 해결"·"책임감 있게"·"귀사의 비전에 깊이 공감" 같은 추상 상투구, "다양한 프로젝트"식 뭉뚱그림, 숫자·고유명사·시행착오 부재, "어려움이 있었지만 극복했습니다"식 얼버무림, "~하는 데 기여했습니다"·"이를 통해" 반복, 모든 문장에 수치.
- authenticity 진정성: 실제 경험처럼 읽히는가. 과장이나 창작 의심 지점, 경험 카드에 없는 사실·수치·회사 정보, 이력 요약과의 불일치, 실패 문항에서 타인 탓·변명·억지 성공담. "[확인: …]" 대괄호는 작성자가 의도적으로 남긴 빈칸 표시이므로 감점하거나 issues·must_fix에 올리지 않는다(3개 이상이면 low 이슈로 "확인 항목이 많음"만 지적).

## 산출 규칙
- total: 100점 환산. 가중치 fit 25, specificity 20, structure 15, relevance 20, style 10, authenticity 10. (각 점수/5 × 가중치의 합, 정수로 반올림)
- must_fix: 반드시 고쳐야 하는 항목만(문항 요구 누락, 경험 카드에 없는 사실이나 회사 정보, 문체 불일치, 두괄식 실패, 기업명·직무 오기, 이력과 불일치, 블라인드 채용인데 학교명·가족·출신지·나이·성별 등 금지 정보 기재). 글자수 초과·부족은 포함하지 않는다(별도 처리). 없으면 빈 배열.
- issues: 문제 지점을 원문 인용(quote, 원문 그대로 20~60자)과 함께, 왜 문제인지(why), 어떻게 고칠지(fix: 가능하면 고친 문장 예시)를 구체적으로. 최대 6개, 감점이 큰 것부터. severity는 high/medium/low.
- strengths: 수정할 때도 반드시 살려야 할 강점 1~3개.
- needs_revision: total이 80 미만이거나 must_fix가 하나라도 있으면 true.
- summary: 인사담당자 시선의 한 줄 총평.`;

export const CRITIQUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scores', 'total', 'needs_revision', 'must_fix', 'issues', 'strengths', 'summary'],
  properties: {
    scores: {
      type: 'object',
      additionalProperties: false,
      required: ['fit', 'specificity', 'structure', 'relevance', 'style', 'authenticity'],
      properties: {
        fit: { type: 'integer', enum: [1, 2, 3, 4, 5] },
        specificity: { type: 'integer', enum: [1, 2, 3, 4, 5] },
        structure: { type: 'integer', enum: [1, 2, 3, 4, 5] },
        relevance: { type: 'integer', enum: [1, 2, 3, 4, 5] },
        style: { type: 'integer', enum: [1, 2, 3, 4, 5] },
        authenticity: { type: 'integer', enum: [1, 2, 3, 4, 5] },
      },
    },
    total: { type: 'integer' },
    needs_revision: { type: 'boolean' },
    must_fix: { type: 'array', items: { type: 'string' } },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['quote', 'why', 'fix', 'severity'],
        properties: {
          quote: { type: 'string' },
          why: { type: 'string' },
          fix: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    strengths: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
};

export const SCORE_LABELS = {
  fit: '문항 적합성',
  specificity: '구체성',
  structure: '두괄식·논리',
  relevance: '직무 연관성',
  style: '문체·표현',
  authenticity: '진정성',
};

export const SCORE_WEIGHTS = { fit: 25, specificity: 20, structure: 15, relevance: 20, style: 10, authenticity: 10 };

/** 평가 점수로 100점 환산값을 재계산한다(모델이 준 total을 신뢰하지 않음). */
export function computeTotal(scores) {
  let total = 0;
  for (const [key, w] of Object.entries(SCORE_WEIGHTS)) {
    const s = Number(scores?.[key]) || 0;
    total += (s / 5) * w;
  }
  return Math.round(total);
}

// ───────────────────────────── 편집 프리셋 ─────────────────────────────

export const EDIT_PRESETS = [
  { id: 'concise', label: '더 간결하게', instruction: '내용은 유지하되 문장을 압축해 더 간결하게 다듬어 주세요. 수식어와 배경 설명부터 줄이고 행동·결과는 지키세요.' },
  { id: 'result', label: '결과 강조', instruction: '결과와 성과가 더 또렷하게 드러나도록 결과 부분을 앞당기거나 보강해 주세요. 없는 수치를 만들지는 마세요.' },
  { id: 'lead', label: '두괄식 강화', instruction: '첫 문장에서 결론과 핵심 역량이 바로 드러나도록 도입부를 다시 써 주세요.' },
  { id: 'natural', label: '더 자연스럽게', instruction: '기계적으로 읽히는 표현, 번역투, 반복되는 연결어를 걷어내고 사람이 쓴 것처럼 자연스럽게 다듬어 주세요.' },
  { id: 'job', label: '직무 연결 강화', instruction: '경험에서 얻은 역량이 지원 직무에서 어떻게 발휘될지 마무리 부분에서 더 구체적으로 연결해 주세요.' },
  { id: 'subhead_on', label: '소제목 추가', instruction: '첫 줄에 결과와 행동이 드러나는 [소제목]을 추가해 주세요(20자 이내).' },
  { id: 'subhead_off', label: '소제목 제거', instruction: '소제목을 제거하고 본문만 남겨 주세요. 필요하면 첫 문장을 다듬어 결론이 드러나게 하세요.' },
];

// ───────────────────────────── 메시지 빌더 ─────────────────────────────

function nonEmpty(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

export function levelLabel(level) {
  return level === 'exp' ? '경력' : '신입';
}

export function questionTypeLabel(typeId) {
  return QUESTION_TYPES.find((t) => t.id === typeId)?.label ?? '';
}

export function describeLimit(question) {
  const mode = COUNT_MODES[question.mode] ?? COUNT_MODES.with;
  if (!question.limit) return '글자수 제한 없음(권장 800~1000자)';
  return `제한 ${question.limit}${mode.unit} (${mode.label})`;
}

export function formatProfile(profile) {
  const lines = [
    `회사: ${profile.company || '(미입력)'}`,
    `직무: ${profile.role || '(미입력)'}`,
    `구분: ${levelLabel(profile.level)}`,
  ];
  if (nonEmpty(profile.jobPosting)) lines.push(`채용 공고·직무 설명:\n${profile.jobPosting.trim()}`);
  const jd = profile.jdSummary;
  if (jd && (jd.competencies?.length || nonEmpty(jd.talent) || nonEmpty(jd.notes))) {
    const parts = [];
    if (jd.competencies?.length) parts.push(`요구 역량 키워드: ${jd.competencies.join(', ')}`);
    if (nonEmpty(jd.talent)) parts.push(`인재상·문화: ${jd.talent.trim()}`);
    if (nonEmpty(jd.notes)) parts.push(`작성 포인트: ${jd.notes.trim()}`);
    lines.push(`공고 분석 요약:\n${parts.join('\n')}`);
  }
  if (nonEmpty(profile.background)) lines.push(`지원자 배경(이력·경력 요약):\n${profile.background.trim()}`);
  if (nonEmpty(profile.companyFacts)) lines.push(`지원자가 아는 회사 정보·써 본 서비스·지원 계기(확인된 사실로 취급):\n${profile.companyFacts.trim()}`);
  if (nonEmpty(profile.notes)) lines.push(`지원자가 강조하고 싶은 점:\n${profile.notes.trim()}`);
  if (profile.blind) lines.push('블라인드 채용: 출신 학교명·학력·출신 지역·가족관계·부모 직업·나이·성별·신체조건·종교·혼인 여부를 기재하면 불이익 또는 부적격 처리됨. 전공·과목명·프로젝트명·자격은 가능.');
  return lines.join('\n');
}

export function formatQuestions(questions) {
  return questions
    .map((q, i) => {
      const type = questionTypeLabel(q.type);
      return `${q.id}. [${describeLimit(q)}${type ? `, 유형: ${type}` : ''}] ${q.text.trim()}`;
    })
    .join('\n');
}

export function formatExperiences(experiences, { questionIds } = {}) {
  if (!experiences?.length) return '(저장된 경험 카드 없음)';
  return experiences
    .map((e) => {
      const rel = e.questionIds?.length ? e.questionIds.join(', ') : '-';
      const mark = questionIds && e.questionIds?.some((id) => questionIds.includes(id)) ? ' ★이 문항 연관' : '';
      return [
        `- (${e.id}) ${e.title || '(제목 없음)'}${mark}`,
        `  상황: ${e.situation || '-'}`,
        `  과제: ${e.task || '-'}`,
        `  행동: ${e.action || '-'}`,
        `  결과: ${e.result || '-'}`,
        `  배운 점: ${e.learned || '-'}`,
        `  키워드: ${(e.keywords || []).join(', ') || '-'} / 연관 문항: ${rel}`,
      ].join('\n');
    })
    .join('\n');
}

/** 문항 수에 비례한 질문 예산 (6~20) */
export function interviewBudget(questions) {
  const n = Array.isArray(questions) ? questions.length : 0;
  return Math.min(20, Math.max(6, n * 2 + 2));
}

/** 인터뷰 첫 user 메시지 */
export function buildInterviewOpening(project) {
  return [
    '[지원 정보]',
    formatProfile(project.profile),
    '',
    '[자기소개서 문항]',
    formatQuestions(project.questions),
    '',
    project.experiences?.length
      ? `[이미 입력된 경험 카드]\n${formatExperiences(project.experiences)}\n`
      : '',
    `질문 예산: 약 ${interviewBudget(project.questions)}개 (초과해도 되지만 핵심 문항부터 채우세요)`,
    '',
    '인터뷰를 시작하세요. ask_user로 첫 질문을 하세요.',
  ]
    .filter((s) => s !== null && s !== undefined)
    .join('\n');
}

export const INTERVIEW_FINISH_REQUEST =
  '지원자가 인터뷰를 여기서 마치길 원합니다. 지금까지 대화에서 나온, 아직 저장하지 않았거나 갱신이 필요한 경험을 save_experience로 저장한 뒤 finish_interview를 호출하세요. 더 이상 질문하지 마세요.';

export const INTERVIEW_SKIP_ANSWER = '이 질문은 넘어가겠습니다. 다른 경험이나 다른 문항 이야기를 물어봐 주세요.';

function subheadingInstruction(pref, question) {
  if (pref === 'on') return '소제목: 사용(첫 줄 [소제목], 20자 이내)';
  if (pref === 'off') return '소제목: 사용하지 않음';
  if (!question.limit) return '소제목: 판단(제한 없음 → 800~1000자 분량이므로 사용 권장)';
  return `소제목: 판단(제한 ${question.limit}자 — 700자 이상이면 사용)`;
}

function modeNote(mode) {
  if (mode === 'without') return '공백·줄바꿈은 세지 않고 소제목 글자는 포함';
  if (mode === 'bytes2') return '한글 2byte·영문/숫자/공백 1byte, 줄바꿈 1byte, 소제목 포함';
  return '줄바꿈 1자·소제목 포함';
}

/** 작성자용 현재 글자수 안내 (목표 범위는 lengthTarget과 동일 기준) */
export function describeCurrent(text, question) {
  const mode = COUNT_MODES[question.mode] ?? COUNT_MODES.with;
  const j = judgeLength(text, question.limit, question.mode);
  if (!question.limit) return `현재 글자수: ${j.count}${mode.unit} (${mode.label}, 제한 없음)`;
  const t = writingTarget(question.limit);
  let status = '목표 범위 내';
  if (j.count > t.max) status = `${j.count - t.max}${mode.unit} 초과 — 반드시 줄일 것`;
  else if (j.count < t.min) status = `${t.min - j.count}${mode.unit} 부족`;
  else if (j.count > t.aim) status = `범위 내(상한에 가까움, ${j.count - t.aim}${mode.unit} 여유 없음)`;
  return `현재 글자수: ${j.count}${mode.unit} / 제한 ${t.max}${mode.unit} (${mode.label}) — ${status}`;
}

/** 작성 목표 상한: 제한의 96% (모델은 글자수를 정확히 세지 못하므로 여유를 둔다) */
export function writingTarget(limit) {
  const { min, max } = targetRange(limit);
  if (!max) return { min: 0, max: 0, aim: 0 };
  return { min, max, aim: Math.max(min, Math.floor(max * 0.96)) };
}

function lengthTarget(question) {
  if (!question.limit) return '글자수: 제한 없음. 800~1000자(공백 포함) 분량으로 작성.';
  const mode = COUNT_MODES[question.mode] ?? COUNT_MODES.with;
  const t = writingTarget(question.limit);
  return `글자수: 제한 ${t.max}${mode.unit} (${mode.label}; ${modeNote(question.mode)}). 목표 ${t.min}~${t.aim}${mode.unit}. 절대 ${t.max}${mode.unit}를 넘기지 마세요.`;
}

/** 초안 작성 user 메시지 */
export function buildDraftRequest(project, question, { otherAnswers = [], subheading = 'auto' } = {}) {
  const parts = [
    '[지원 정보]',
    formatProfile(project.profile),
    '',
    '[작성할 문항]',
    `${question.id}. ${question.text.trim()}`,
    questionTypeLabel(question.type) ? `문항 유형: ${questionTypeLabel(question.type)}` : '',
    lengthTarget(question),
    subheadingInstruction(subheading, question),
    '',
    '[경험 카드]',
    formatExperiences(project.experiences, { questionIds: [question.id] }),
  ];
  if (nonEmpty(project.interview?.summary)) parts.push('', '[인터뷰 요약]', project.interview.summary.trim());
  if (nonEmpty(project.interview?.writerNotes)) parts.push('', '[인터뷰어 메모]', project.interview.writerNotes.trim());
  if (otherAnswers.length) {
    parts.push('', '[다른 문항에 이미 쓴 답변 — 같은 사례·표현 반복 금지]');
    for (const a of otherAnswers) parts.push(`(${a.id}) ${a.questionText}\n${a.text}\n`);
  }
  parts.push(
    '',
    '[지시]',
    '위 문항에 대한 자기소개서 답변 본문만 출력하세요. ★표시된 연관 카드를 우선 사용하되 문항에 더 잘 맞는 카드가 있으면 그것을 고르세요. 한 답변의 중심 사례는 1개(제한 1200자 이상이면 2개까지)로 합니다.',
  );
  return parts.filter((p) => p !== null && p !== undefined).join('\n');
}

/** 첨삭(평가) user 메시지 */
function subheadingPolicyForCritic(pref) {
  if (pref === 'on') return '소제목 정책: 사용자가 소제목 사용을 지정함 — 삭제 권고 금지, 문구 개선만 제안.';
  if (pref === 'off') return '소제목 정책: 소제목 사용 안 함 — 소제목이 있으면 must_fix에 "소제목 제거".';
  return '소제목 정책: 자유 — 있어도 되고 없어도 됨. 뻔하거나 중복이면 삭제 또는 개선 제안 가능.';
}

export function buildCritiqueRequest(project, question, text, { subheading = 'auto' } = {}) {
  const j = judgeLength(text, question.limit, question.mode);
  const type = questionTypeLabel(question.type);
  return [
    '[지원 정보]',
    formatProfile(project.profile),
    '',
    '[문항]',
    `${question.id}. ${question.text.trim()}`,
    type ? `문항 유형: ${type}` : '',
    `글자수 판정: ${describeLength(j, question.mode)}`,
    subheadingPolicyForCritic(subheading),
    '',
    '[경험 카드 — 사실 대조용]',
    formatExperiences(project.experiences, { questionIds: [question.id] }),
    '',
    '[평가할 답변]',
    text,
    '',
    '[지시]',
    '위 답변을 평가 기준에 따라 채점하고 수정 지시를 JSON으로 출력하세요. 글자수는 앱이 별도로 조정하므로 must_fix에 넣지 말고, 줄여도 되는 군더더기가 있으면 issues에 low로만 제안하세요.',
  ].filter((l) => l !== '').join('\n');
}

function formatCritique(critique) {
  if (!critique) return '(첨삭 없음)';
  const lines = [`총평: ${critique.summary}`, `점수: ${critique.total}/100`];
  if (critique.must_fix?.length) lines.push('반드시 수정:', ...critique.must_fix.map((m) => `- ${m}`));
  if (critique.issues?.length) {
    lines.push('문제 지점:');
    for (const i of critique.issues) lines.push(`- [${i.severity}] "${i.quote}" → ${i.why} / 수정: ${i.fix}`);
  }
  if (critique.strengths?.length) lines.push('살릴 강점:', ...critique.strengths.map((s) => `- ${s}`));
  return lines.join('\n');
}

/** 첨삭 반영 수정 user 메시지 */
export function buildReviseRequest(project, question, text, critique, { subheading = 'auto', otherAnswers = [] } = {}) {
  const type = questionTypeLabel(question.type);
  const parts = [
    '[지원 정보]',
    formatProfile(project.profile),
    '',
    '[문항]',
    `${question.id}. ${question.text.trim()}`,
    type ? `문항 유형: ${type}` : '',
    lengthTarget(question),
    subheadingInstruction(subheading, question),
    '',
    '[경험 카드 — 사실은 여기에 있는 것만]',
    formatExperiences(project.experiences, { questionIds: [question.id] }),
  ];
  if (nonEmpty(project.interview?.summary)) parts.push('', '[인터뷰 요약]', project.interview.summary.trim());
  if (nonEmpty(project.interview?.writerNotes)) parts.push('', '[인터뷰어 메모]', project.interview.writerNotes.trim());
  if (otherAnswers.length) {
    parts.push('', '[다른 문항에 이미 쓴 답변 — 같은 사례·표현 반복 금지]');
    for (const a of otherAnswers) parts.push(`(${a.id}) ${a.questionText}\n${a.text}\n`);
  }
  parts.push(
    '',
    '[현재 답변]',
    text,
    describeCurrent(text, question),
    '',
    '[첨삭 결과]',
    formatCritique(critique),
    '',
    '[지시]',
    '첨삭 결과의 "반드시 수정"과 "문제 지점"을 모두 반영해 답변 전체를 다시 쓰세요. 강점은 유지하세요. "[확인: …]" 표시는 지원자가 채울 빈칸이므로 사실을 지어내 메우지 말고, 필요하면 그대로 두세요. 글자수 목표 범위를 지키세요. 수정한 답변 본문만 출력하세요.',
  );
  return parts.filter((l) => l !== '').join('\n');
}

/** 글자수만 맞추는 수정 user 메시지 */
export function buildLengthFixRequest(project, question, text) {
  const j = judgeLength(text, question.limit, question.mode);
  const mode = COUNT_MODES[question.mode] ?? COUNT_MODES.with;
  const t = writingTarget(question.limit);
  const direction = j.status === 'over'
    ? `${j.count - t.aim}${mode.unit} 이상 줄여서 ${t.min}~${t.aim}${mode.unit} 안에 맞추세요. 배경 설명 → 수식어 → 중복 근거 순으로 빼고, 수치·고유명사·행동·결과는 지키세요.`
    : `${-j.diff}${mode.unit} 이상 늘려서 ${t.min}~${t.aim}${mode.unit} 안에 맞추세요. 행동의 이유와 결과의 구체적 영향을 보강하되 없는 사실은 만들지 마세요.`;
  return [
    '[지원 정보]',
    formatProfile(project.profile),
    '',
    '[문항]',
    `${question.id}. ${question.text.trim()}`,
    lengthTarget(question),
    '',
    '[현재 답변]',
    text,
    describeCurrent(text, question),
    '',
    '[경험 카드 — 사실은 여기에 있는 것만]',
    formatExperiences(project.experiences, { questionIds: [question.id] }),
    '',
    '[지시]',
    `내용과 구조는 유지하고 글자수만 조정하세요. ${direction} 수정한 답변 본문만 출력하세요.`,
  ].join('\n');
}

function upperBoundOnly(question) {
  if (!question.limit) return '글자수: 제한 없음.';
  const mode = COUNT_MODES[question.mode] ?? COUNT_MODES.with;
  const t = writingTarget(question.limit);
  return `글자수: 제한 ${t.max}${mode.unit} (${mode.label}; ${modeNote(question.mode)}). 절대 ${t.max}${mode.unit}를 넘기지 마세요. 요청이 분량을 줄이는 것이 아니라면 ${t.min}${mode.unit} 이상을 유지하세요.`;
}

/** 사용자 지시 편집 user 메시지 */
export function buildEditRequest(project, question, text, instruction) {
  return [
    '[지원 정보]',
    formatProfile(project.profile),
    '',
    '[문항]',
    `${question.id}. ${question.text.trim()}`,
    upperBoundOnly(question),
    '',
    '[경험 카드 — 사실은 여기에 있는 것만]',
    formatExperiences(project.experiences, { questionIds: [question.id] }),
    '',
    '[현재 답변]',
    text,
    describeCurrent(text, question),
    '',
    '[사용자 요청]',
    instruction.trim(),
    '',
    '[지시]',
    '사용자 요청을 반영해 답변 전체를 다시 쓰세요. 요청과 무관한 부분은 최대한 그대로 두세요. 수정한 답변 본문만 출력하세요.',
  ].join('\n');
}


// ───────────────────────────── 공고 분석 ─────────────────────────────

export const JD_ANALYST_SYSTEM = `당신은 한국 채용 공고를 분석해 자기소개서 준비에 필요한 정보를 뽑아내는 채용 분석가입니다. 주어진 공고 텍스트에서 사실만 추출하고, 없는 정보는 빈 값으로 둡니다: 문자열은 "", 숫자(limit)는 0, level과 mode는 "unknown". 자기소개서 문항이 있으면 문구를 원문 그대로 옮기고, 글자수 제한과 공백 기준이 명시돼 있으면 그대로, 없으면 0/unknown으로 둡니다. 문항이 전혀 없으면 questions는 빈 배열입니다.
- mode 값: with=공백 포함, without=공백 제외, bytes2=바이트 기준(한글 2byte), unknown=기준 미표기.
- type 값(문항 유형): ${QUESTION_TYPES.map((t) => `${t.id}=${t.label}`).join(', ')}. 판단이 어려우면 free.
competencies에는 공고가 요구하는 역량·경험·기술 키워드를 5~10개, talent에는 인재상·조직문화 관련 문구를 2~3문장으로 요약합니다. notes에는 지원자가 자소서에서 꼭 건드려야 할 포인트를 3개 이내로 적습니다.`;

export const JD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['company', 'role', 'level', 'questions', 'competencies', 'talent', 'notes'],
  properties: {
    company: { type: 'string' },
    role: { type: 'string' },
    level: { type: 'string', enum: ['new', 'exp', 'unknown'] },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'limit', 'mode', 'type'],
        properties: {
          text: { type: 'string' },
          limit: { type: 'integer' },
          mode: { type: 'string', enum: ['with', 'without', 'bytes2', 'unknown'] },
          type: { type: 'string', enum: QUESTION_TYPES.map((t) => t.id) },
        },
      },
    },
    competencies: { type: 'array', items: { type: 'string' } },
    talent: { type: 'string' },
    notes: { type: 'string' },
  },
};

export function buildJdRequest(postingText) {
  return `[채용 공고 원문]\n${String(postingText ?? '').trim()}\n\n[지시]\n위 공고에서 회사명, 직무, 신입/경력 구분, 자기소개서 문항(글자수·기준 포함), 요구 역량, 인재상, 자소서 작성 포인트를 JSON으로 추출하세요.`;
}

// ───────────────────────────── 면접 예상 질문 ─────────────────────────────

export const INTERVIEW_PREP_SYSTEM = `당신은 지원자의 자기소개서를 읽고 면접 질문을 준비하는 면접관이자 코치입니다. 자기소개서와 경험 카드를 근거로, 실제 면접에서 나올 법한 질문 8~12개를 만듭니다. 구성: 자기소개서 각 문항에서 파고들 질문(사실 확인·수치 근거·역할 검증·꼬리질문), 지원동기·직무 이해 검증, 답변에 드러난 약점이나 논리 공백을 찌르는 질문, 인성·조직 적합성 질문. 각 질문에 면접관의 의도(intent)와 지원자가 준비할 답변 전략(strategy: 어떤 경험 카드의 어떤 사실을 어떻게 말할지, 2~3문장)을 붙입니다. based_on에는 근거가 된 문항 id(예: "q2") 또는 "profile"을 적습니다. 경험 카드에 없는 사실을 답변 전략에 넣지 않습니다.`;

export const INTERVIEW_PREP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'intent', 'strategy', 'based_on'],
        properties: {
          question: { type: 'string' },
          intent: { type: 'string' },
          strategy: { type: 'string' },
          based_on: { type: 'string' },
        },
      },
    },
  },
};

export function buildInterviewPrepRequest(project, answers) {
  const parts = ['[지원 정보]', formatProfile(project.profile), '', '[자기소개서 최종 답변]'];
  for (const a of answers) parts.push(`${a.id}. ${a.questionText}\n${a.text}\n`);
  parts.push('[경험 카드]', formatExperiences(project.experiences), '', '[지시]', '위 자기소개서를 바탕으로 면접 예상 질문과 답변 전략을 JSON으로 만드세요.');
  return parts.join('\n');
}

// ───────────────────────────── 대안 초안·부분 수정 ─────────────────────────────

/** 기존 답변과 다른 각도의 대안 초안 요청 */
export function buildAlternativeRequest(project, question, existingText, opts = {}) {
  const base = buildDraftRequest(project, question, opts);
  return `${base}\n\n[이미 작성된 버전 — 이것과는 다른 각도로]\n${existingText}\n\n[추가 지시]\n위 버전과 중심 사례나 구성(예: 결과를 먼저 제시하는 구성 ↔ 문제 상황에서 시작하는 구성, 다른 경험 카드 사용)을 다르게 하여 대안 답변을 쓰세요. 문장을 재활용하지 마세요.`;
}

/** 선택 구간만 고치는 부분 수정 요청 */
export function buildSelectionEditRequest(project, question, text, selection, instruction) {
  return [
    '[지원 정보]',
    formatProfile(project.profile),
    '',
    '[문항]',
    `${question.id}. ${question.text.trim()}`,
    upperBoundOnly(question),
    '',
    '[경험 카드 — 사실은 여기에 있는 것만]',
    formatExperiences(project.experiences, { questionIds: [question.id] }),
    '',
    '[현재 답변 전체]',
    text,
    describeCurrent(text, question),
    '',
    '[수정할 구간 — 답변 안의 이 부분만 고칩니다]',
    selection.trim(),
    '',
    '[사용자 요청]',
    instruction.trim(),
    '',
    '[지시]',
    '위 "수정할 구간"만 사용자 요청대로 고치고, 나머지 부분은 글자 하나 바꾸지 말고 그대로 두어 답변 전체를 출력하세요. 전체 글자수 제한을 넘기지 마세요. 본문만 출력하세요.',
  ].join('\n');
}
