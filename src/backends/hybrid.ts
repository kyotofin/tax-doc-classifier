import type { AskResult, Backend, ChoiceAnswer, ChoiceQuestion } from '../backend.js'

export type HybridStats = { rules: number; model: number }
export type HybridBackend = Backend & { stats: HybridStats; lastDecider: 'rules' | 'model' | undefined }

function top(a: ChoiceAnswer | undefined): number {
  if (!a) return 1
  let best = 0
  for (const [k, v] of Object.entries(a.probabilities)) if (k !== 'not_in_this_list' && v > best) best = v
  return best
}

export function hybridBackend(rules: Backend, model: Backend, gate = 0.95): HybridBackend {
  const self: HybridBackend = {
    stats: { rules: 0, model: 0 },
    lastDecider: undefined,
    async ask(state, questions: Record<string, ChoiceQuestion>): Promise<AskResult> {
      const r = await rules.ask(state, questions)
      const decisive = Object.keys(questions).filter((q) => q !== 'kind')
      if (decisive.every((q) => top(r.answers[q]) >= gate)) {
        self.stats.rules++
        self.lastDecider = 'rules'
        return r
      }
      self.stats.model++
      self.lastDecider = 'model'
      return model.ask(state, questions)
    },
  }
  return self
}
