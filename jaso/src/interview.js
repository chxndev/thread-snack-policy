// 인터뷰 상태 조작 헬퍼 (제공자 공통, 순수 로직)
import { upsertExperience } from './experiences.js';

export function emptyInterview() {
  return { status: 'idle', messages: [], transcript: [], pending: null, summary: '', writerNotes: '', questionCount: 0 };
}

/** 모델이 질문을 냈을 때: pending 설정, 기록, 상태 전환 */
export function recordQuestion(iv, { toolUseId = null, results = [], question, why = '', example = '' }) {
  iv.pending = { toolUseId, results, question, why, example };
  iv.transcript.push({ role: 'agent', kind: 'question', text: question, why, example });
  iv.questionCount += 1;
  iv.status = 'waiting';
  return { type: 'question', question: iv.pending };
}

/** 모델이 인터뷰를 끝냈을 때 */
export function recordFinish(iv, { summary = '', writer_notes = '' } = {}) {
  iv.summary = summary ?? '';
  iv.writerNotes = writer_notes ?? '';
  iv.pending = null;
  iv.status = 'done';
  iv.transcript.push({ role: 'agent', kind: 'summary', text: iv.summary });
  return { type: 'done', summary: iv.summary };
}

/** 경험 카드 저장(제공자 공통). 저장 결과 메시지를 돌려준다. */
export function applySave(project, input, handlers) {
  const card = upsertExperience(project, input, 'interview');
  handlers?.onExperience?.(card);
  return card;
}
