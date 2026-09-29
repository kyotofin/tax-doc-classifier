import type { AskResult, Backend, ChoiceAnswer, ChoiceQuestion, Criterion } from '../backend.js'

const NIL = 'not_in_this_list'

export function shortlistBackend(ranker: Backend, model: Backend, k = 10, keepKindFromRanker = true): Backend {
  return {
    async ask(state, questions: Record<string, ChoiceQuestion>): Promise<AskResult> {
      const ranked = await ranker.ask(state, questions)
      const narrowed: Record<string, ChoiceQuestion> = {}
      for (const [name, q] of Object.entries(questions)) {
        if (name === 'kind' && keepKindFromRanker) continue
        const keys = Object.keys(q.criteria)
        if (keys.length <= k + 1) {
          narrowed[name] = q
          continue
        }
        const probs = ranked.answers[name]?.probabilities ?? {}
        const keep = keys
          .filter((key) => key !== NIL)
          .sort((a, b) => (probs[b] ?? 0) - (probs[a] ?? 0))
          .slice(0, k)
        if (q.criteria[NIL]) keep.push(NIL)
        const criteria: Record<string, Criterion> = {}
        for (const key of keep) criteria[key] = q.criteria[key]
        narrowed[name] = { ...q, criteria }
      }
      const r = await model.ask(state, narrowed)
      const answers: Record<string, ChoiceAnswer> = {}
      for (const [name, q] of Object.entries(questions)) {
        if (!narrowed[name]) {
          answers[name] = ranked.answers[name]
          continue
        }
        const a = r.answers[name]
        const probabilities: Record<string, number> = {}
        for (const key of Object.keys(q.criteria)) probabilities[key] = a.probabilities[key] ?? 0
        answers[name] = { ...a, probabilities }
      }
      return { answers, inputTokens: r.inputTokens }
    },
  }
}
