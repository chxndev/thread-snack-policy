// 경험 카드 저장/갱신 (인터뷰 도구·수동 입력 공용)
import { uid } from './text.js';

export function upsertExperience(project, input, source = 'interview') {
  project.experiences ??= [];
  const clean = (s) => (typeof s === 'string' ? s.trim() : '');
  const card = {
    title: clean(input.title),
    situation: clean(input.situation),
    task: clean(input.task),
    action: clean(input.action),
    result: clean(input.result),
    learned: clean(input.learned),
    keywords: Array.isArray(input.keywords) ? input.keywords.map(clean).filter(Boolean) : [],
    questionIds: Array.isArray(input.question_ids ?? input.questionIds)
      ? (input.question_ids ?? input.questionIds).map(clean).filter((id) => project.questions?.some((q) => q.id === id))
      : [],
    source,
  };
  const id = clean(input.id);
  const existing = id ? project.experiences.find((e) => e.id === id) : null;
  if (existing) {
    for (const k of ['title', 'situation', 'task', 'action', 'result', 'learned']) {
      if (card[k]) existing[k] = card[k];
    }
    if (card.keywords.length) existing.keywords = card.keywords;
    if (card.questionIds.length) existing.questionIds = card.questionIds;
    existing.updatedAt = Date.now();
    return existing;
  }
  const created = { id: uid('exp'), ...card, createdAt: Date.now(), updatedAt: Date.now() };
  project.experiences.push(created);
  return created;
}
