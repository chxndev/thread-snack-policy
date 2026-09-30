// 문항 프리셋: 공통 템플릿 + 기업별 예시.
// 기업별 세트는 2024~2026년 공개 자료(취업 커뮤니티·가이드 요약)를 바탕으로 정리한 "참고용"이며,
// 문항 문구·글자수·공백 기준은 채용 회차마다 바뀌므로 반드시 실제 공고를 확인해야 한다.

export const COMMON_QUESTIONS = [
  { text: '해당 직무에 지원한 동기와 입사 후 이루고 싶은 목표를 기술해 주십시오.', limit: 700, mode: 'with', type: 'motivation' },
  { text: '본인의 성장과정을 간략히 기술하되, 현재의 자신에게 가장 큰 영향을 끼친 사건·인물 등을 포함해 주십시오.', limit: 1000, mode: 'with', type: 'growth' },
  { text: '지원 직무와 관련해 본인이 갖춘 전문지식·경험·역량과 이를 갖추기 위한 노력, 직무에 적합한 이유를 구체적으로 기술해 주십시오.', limit: 1000, mode: 'with', type: 'competency' },
  { text: '공동의 목표를 위해 타인과 협업한 경험을 당시의 배경, 목표, 역할, 과정 및 결과가 드러나게 기술해 주십시오.', limit: 1000, mode: 'with', type: 'teamwork' },
  { text: '가장 어려웠던 과제나 실패 경험과 이를 극복하기 위해 어떤 노력을 했는지, 그 과정에서 배운 점을 기술해 주십시오.', limit: 1000, mode: 'with', type: 'failure' },
  { text: '본인 성격의 장점과 단점, 그리고 단점을 보완하기 위한 노력을 기술해 주십시오.', limit: 500, mode: 'with', type: 'strength' },
  { text: '입사 후 10년 뒤 본인의 모습과 이를 위한 단계별 계획을 기술해 주십시오.', limit: 500, mode: 'with', type: 'aspiration' },
  { text: '최근 사회 이슈 중 중요하다고 생각하는 한 가지를 선택하고 이에 관한 자신의 견해를 기술해 주십시오.', limit: 1000, mode: 'with', type: 'free' },
  { text: '자신을 가장 잘 나타내는 키워드(해시태그 2개 이내)를 포함해 남들과 다른 가치관, 개성, 강점을 자유롭게 표현해 주십시오.', limit: 600, mode: 'with', type: 'free' },
  { text: '자유 형식으로 자신을 소개해 주십시오.', limit: 2000, mode: 'with', type: 'free' },
];

export const COMPANY_PRESETS = [
  {
    id: 'samsung',
    name: '삼성전자 (2025 하반기 참고)',
    note: '4문항 700/1500/1000/1000자. 영문 작성 시 글자수 2배. 계열사는 4번 문항 문구가 다름.',
    questions: [
      { text: '삼성전자를 지원한 이유와 입사 후 회사에서 이루고 싶은 꿈을 기술하십시오.', limit: 700, mode: 'with', type: 'motivation' },
      { text: '본인의 성장과정을 간략히 기술하되 현재의 자신에게 가장 큰 영향을 끼친 사건, 인물 등을 포함하여 기술하시기 바랍니다.', limit: 1500, mode: 'with', type: 'growth' },
      { text: '최근 사회 이슈 중 중요하다고 생각되는 한 가지를 선택하고 이에 관한 자신의 견해를 기술해 주시기 바랍니다.', limit: 1000, mode: 'with', type: 'free' },
      { text: '지원 직무 관련 본인의 전문지식과 경험을 작성하고, 본인이 지원 직무에 적합한 사유를 삼성전자 제품과 서비스 사용 경험을 기반으로 기술하시기 바랍니다.', limit: 1000, mode: 'with', type: 'competency' },
    ],
  },
  {
    id: 'hyundai',
    name: '현대자동차 (2025 참고)',
    note: '2025년부터 2문항 각 1000자로 축소(생산직은 3문항 800자). 직무별로 구성이 달라짐.',
    questions: [
      { text: '해당 분야에 지원한 동기와 함께, 입사 후 현대자동차에서 이루고 싶은 성장에 대해 기술해 주십시오.', limit: 1000, mode: 'with', type: 'motivation' },
      { text: '지원 분야 업무 수행에 있어 가장 중요한 역량이 무엇인지 선정하고, 그 이유를 설명하며, 스스로 해당 역량을 키우기 위해 어떤 노력을 해왔는지 기술해 주십시오.', limit: 1000, mode: 'with', type: 'competency' },
    ],
  },
  {
    id: 'lg',
    name: 'LG전자 (2025 하반기 참고)',
    note: '2025 하반기부터 3문항 → 2문항(각 1000자).',
    questions: [
      { text: '지원동기 및 향후계획: 본인의 직무관련 경험과 강점에 기반하여 LG전자에 대한 지원동기를 작성해 주세요.', limit: 1000, mode: 'with', type: 'motivation' },
      { text: '역경극복: 대학교 시절을 포함한 이후 인생에서 직면했던 어려운 과제와, 이를 극복했던 경험에 대해 기술해 주세요.', limit: 1000, mode: 'with', type: 'failure' },
    ],
  },
  {
    id: 'skhynix',
    name: 'SK하이닉스 (2025 참고)',
    note: '필수 3문항 + 선택 1문항, 각 600자. 필수 문항 문구는 SK 전통 문항 기준이므로 공고 확인 필수.',
    questions: [
      { text: '자발적으로 최고 수준의 목표를 세우고 끈질기게 성취한 경험에 대해 서술해 주십시오.', limit: 600, mode: 'with', type: 'failure' },
      { text: '새로운 것을 접목하거나 남다른 아이디어를 통해 문제를 개선했던 경험에 대해 서술해 주십시오.', limit: 600, mode: 'with', type: 'competency' },
      { text: '지원 분야와 관련하여 특정 영역의 전문성을 키우기 위해 꾸준히 노력한 경험에 대해 서술해 주십시오.', limit: 600, mode: 'with', type: 'competency' },
      { text: '(선택) 지원자님은 어떤 사람인가요? 지원자님을 가장 잘 나타낼 수 있는 해시태그(최대 2개)를 포함해 남들과는 다른 특별한 가치관, 개성, 강점 등을 자유롭게 표현해 주세요.', limit: 600, mode: 'with', type: 'free' },
    ],
  },
  {
    id: 'naver',
    name: '네이버 (2025 신입 공채 참고)',
    note: '필수 2문항 각 1000자 + 선택 포트폴리오 첨부. 수시·경력은 자유 양식.',
    questions: [
      { text: '지원하신 부문을 결정한 계기와, 입사 후 성장 목표를 작성해 주세요.', limit: 1000, mode: 'with', type: 'motivation' },
      { text: '스스로의 의지로 새로운 도전이나 변화를 시도했던 경험을 작성해 주세요.', limit: 1000, mode: 'with', type: 'failure' },
    ],
  },
  {
    id: 'kakao',
    name: '카카오 (2026 신입 공채 참고)',
    note: '공통 문항 + 직무별 3번 문항 + 선택 문항, 대부분 1000자.',
    questions: [
      { text: '어떤 문제를 해결할 때, Why?를 놓치지 않고 문제의 본질을 찾는 데 집중했던 경험이 있다면 적어주세요.', limit: 1000, mode: 'with', type: 'competency' },
      { text: '어떤 일을 하면서 더 완성도를 높이고 싶어 끝까지 몰입했던 경험과 도전 과정을 적어주세요.', limit: 1000, mode: 'with', type: 'failure' },
      { text: '(선택) 자신이 합격해야 하는 이유 또는 추가적으로 어필하고 싶은 내용이 있다면 작성해주세요.', limit: 1000, mode: 'with', type: 'free' },
    ],
  },
  {
    id: 'cj',
    name: 'CJ제일제당 (2025 하반기 참고)',
    note: '2문항 각 1000자.',
    questions: [
      { text: 'CJ제일제당에 합류해 이루고 싶은 성장에 대해 알려주세요.', limit: 1000, mode: 'with', type: 'motivation' },
      { text: '직무와 관련해 본인이 쌓아온 경험과 그 속에서 가장 크게 성장했다고 느낀 순간을 작성해 주세요.', limit: 1000, mode: 'with', type: 'competency' },
    ],
  },
  {
    id: 'lotte',
    name: '롯데그룹 (2025 참고)',
    note: '항목별 공백 포함 700자(공백 포함이 명시된 드문 사례). 계열사·직무별로 문항 상이.',
    questions: [
      { text: '롯데와 해당 직무에 지원한 이유를 기술해 주십시오.', limit: 700, mode: 'with', type: 'motivation' },
      { text: '직무 수행에 필요한 역량과 이를 갖추기 위해 준비한 경험을 기술해 주십시오.', limit: 700, mode: 'with', type: 'competency' },
      { text: '롯데의 핵심가치(고객 중심·혁신·신뢰 등) 중 하나와 관련된 본인의 경험을 기술해 주십시오.', limit: 700, mode: 'with', type: 'growth' },
    ],
  },
  {
    id: 'posco',
    name: '포스코 (2025 하반기 참고)',
    note: '4문항 각 600자. 3·4번은 직무·계열사별로 다름.',
    questions: [
      { text: '본인이 회사를 선택할 때 가장 중시하는 가치는 무엇이며, 포스코가 그 가치에 부합하는 이유를 서술하여 주십시오.', limit: 600, mode: 'with', type: 'motivation' },
      { text: '희망하는 직무를 수행함에 있어서 요구되는 역량을 갖추기 위해 어떠한 학습 또는 도전적인 경험을 하였고, 입사 후 이를 어떻게 발전시켜 나갈 것인지 서술하여 주십시오.', limit: 600, mode: 'with', type: 'competency' },
      { text: '존중과 배려의 마인드로 타인에게 도움을 주었거나, 타인과의 협업을 통해 갈등 상황을 극복한 경험에 대해 서술하여 주십시오.', limit: 600, mode: 'with', type: 'teamwork' },
      { text: '최근 국내외 이슈 중 한 가지를 선택하여 본인의 견해를 서술하여 주십시오.', limit: 600, mode: 'with', type: 'free' },
    ],
  },
  {
    id: 'shinhan',
    name: '신한은행 (2025 하반기 참고)',
    note: '문항별 글자수가 다름(800/1000). 총 문항 수·순서는 회차마다 변동.',
    questions: [
      { text: '다른 지원자와 차별화되는 본인만의 강점을 한가지 선택하여, 이를 신한은행에서 어떻게 발휘할 수 있을지 작성해 주세요.', limit: 800, mode: 'with', type: 'competency' },
      { text: '입행 후 10년 또는 20년 후 본인의 모습을 상상하고, 어떤 분야의 전문가로 성장하고 싶은지 작성해 주세요.', limit: 800, mode: 'with', type: 'aspiration' },
      { text: '신한은행의 핵심가치(바르게, 빠르게, 다르게) 중 본인과 가장 잘 맞는 요소를 선택하고, 이를 실제 경험과 연결하여 설명해 주세요.', limit: 1000, mode: 'with', type: 'growth' },
    ],
  },
  {
    id: 'korail',
    name: '코레일 (2025 참고, byte 기준)',
    note: '4문항 각 800byte. 한글 1자를 2byte로 계산하는 관행 기준(약 400자). 인코딩 기준은 공고 확인.',
    questions: [
      { text: '평소 다른 사람을 돕기 위해 꾸준히 노력하는 점과 그런 노력을 하게 된 계기를 작성해 주십시오.', limit: 800, mode: 'bytes2', type: 'growth' },
      { text: '본인의 역할이나 존재가 크게 드러나지 않는 상황에서 팀을 위해 자발적으로 노력한 경험을 구체적인 상황 및 이유와 함께 기술해 주십시오.', limit: 800, mode: 'bytes2', type: 'teamwork' },
      { text: '다양한 유형의 사람을 상대하기 위해 필요한 역량은 무엇인지 서술하고, 지원자가 해당 역량을 발휘하여 상대방을 만족시켰던 경험에 대해 구체적으로 작성해 주십시오.', limit: 800, mode: 'bytes2', type: 'teamwork' },
      { text: '지원 분야의 직무를 수행하는데 있어 지원자의 전문성(장점)을 소개하고, 전문성 향상을 위한 그동안의 노력과 입사 후 코레일 기여 방안에 대해 작성해 주십시오.', limit: 800, mode: 'bytes2', type: 'competency' },
    ],
  },
  {
    id: 'public',
    name: '공기업 NCS 표준 (LH·한전형 참고)',
    note: '지원동기·전문성·윤리 3~4문항, 항목별 500자 내외. 최소 글자수(350자) 하한을 두는 기관도 있음.',
    questions: [
      { text: '우리 기관의 해당 직무에 지원한 동기와 관심 있는 과업, 기여 방법을 기술해 주십시오.', limit: 500, mode: 'with', type: 'motivation' },
      { text: '지원 직무와 관련한 역량(지식, 기술, 태도 등)과 그 역량을 갖추기 위한 노력을 기술해 주십시오.', limit: 500, mode: 'with', type: 'competency' },
      { text: '개인의 이익이나 편리함 대신 윤리나 원칙을 우선하여 행동했던 경험을 구체적 행동과 그 결과 또는 배운 점을 포함해 기술해 주십시오.', limit: 500, mode: 'with', type: 'growth' },
      { text: '조직 내에서 의사소통을 통해 문제를 해결한 경험을 구체적으로 기술해 주십시오.', limit: 500, mode: 'with', type: 'teamwork' },
    ],
  },
  {
    id: 'startup',
    name: '스타트업·중소기업 (일반)',
    note: '자유 양식이 많음. 사전 질문 형태의 300~500자 짧은 문항도 흔함.',
    questions: [
      { text: '왜 이 회사, 이 문제에 관심을 갖게 되었는지와 지원 동기를 작성해 주세요.', limit: 1000, mode: 'with', type: 'motivation' },
      { text: '가장 몰입해 성과를 낸 경험을 수치와 함께 작성해 주세요.', limit: 1000, mode: 'with', type: 'competency' },
      { text: '실패했던 경험과 그로부터 배운 점을 작성해 주세요.', limit: 600, mode: 'with', type: 'failure' },
    ],
  },
];
