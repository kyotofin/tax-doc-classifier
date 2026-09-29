import { jevBackend, type Backend } from '../backend.js'
import type { PageState } from '../state.js'

function squash(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]{2,}/g, ' | ').replace(/(?:\s*\.){3,}/g, ' ...').trim())
    .filter(Boolean)
    .join('\n')
}

export function deciderBackend(url = process.env.DECIDER_URL ?? 'http://127.0.0.1:8770', lean = false): Backend {
  const inner = jevBackend({ apiKey: 'local', baseUrl: url, retries: 1, timeoutMs: 600_000 })
  return {
    ask(state, questions) {
      const p = state as PageState
      const qs = lean
        ? Object.fromEntries(
            Object.entries(questions).map(([name, q]) => [
              name,
              { ...q, criteria: Object.fromEntries(Object.entries(q.criteria).map(([k, c]) => [k, { what: c.what }])) },
            ]),
          )
        : questions
      return inner.ask({ header: squash(p.header), body: squash(p.body), footer: squash(p.footer) }, qs)
    },
  }
}
