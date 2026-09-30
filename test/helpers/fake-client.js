// 테스트용 가짜 Anthropic 클라이언트: client.beta.messages.stream(params) 흉내
export function makeMessage(content, { stopReason = 'end_turn', model = 'claude-opus-5-5' } = {}) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

export const text = (t) => ({ type: 'text', text: t });
export const toolUse = (name, input, id = `toolu_${Math.random().toString(36).slice(2, 8)}`) => ({ type: 'tool_use', id, name, input });
export const thinking = () => ({ type: 'thinking', thinking: '', signature: 'sig' });

/**
 * @param {(params:object, index:number) => object|Promise<object>} responder  각 호출에 대한 메시지
 */
export function fakeClient(responder) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params) {
          const index = calls.length;
          calls.push(JSON.parse(JSON.stringify(params)));
          const listeners = {};
          let aborted = false;
          return {
            on(event, cb) { (listeners[event] ??= []).push(cb); return this; },
            abort() { aborted = true; },
            async finalMessage() {
              const message = await responder(params, index);
              if (aborted) { const e = new Error('aborted'); e.name = 'APIUserAbortError'; throw e; }
              for (const block of message.content) {
                if (block.type === 'text') {
                  for (const cb of listeners.text ?? []) cb(block.text, block.text);
                }
                if (block.type === 'tool_use') {
                  for (const cb of listeners.streamEvent ?? []) cb({ type: 'content_block_start', content_block: { type: 'tool_use', name: block.name } });
                  for (const cb of listeners.inputJson ?? []) cb(JSON.stringify(block.input), block.input);
                  for (const cb of listeners.streamEvent ?? []) cb({ type: 'content_block_stop' });
                }
              }
              return message;
            },
          };
        },
      },
    },
  };
}

export function sampleProject() {
  return {
    profile: { company: '네이버', role: '백엔드 개발', level: 'new', jobPosting: '', background: '컴공 졸업, 스프링 프로젝트 2회', notes: '' },
    questions: [
      { id: 'q1', text: '지원 동기를 작성해 주세요.', limit: 500, mode: 'with', type: 'motivation' },
      { id: 'q2', text: '협업 중 갈등을 해결한 경험을 작성해 주세요.', limit: 1000, mode: 'with', type: 'teamwork' },
    ],
    experiences: [],
    interview: { status: 'idle', messages: [], transcript: [], pending: null, summary: '', writerNotes: '', questionCount: 0 },
    answers: {},
  };
}
