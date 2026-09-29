import type { AskResult, Backend, ChoiceAnswer, ChoiceQuestion } from '../backend.js'
import type { Criteria } from '../classify.js'
import { KIND_CRITERIA, RARE_PARENTS } from '../classify.js'
import type { PageState } from '../state.js'

export type GlinerOptions = {
  url?: string
  groupSize?: number
  keepPerGroup?: number
  textChars?: number
  temperature?: number
  titles?: boolean
}

type TaskSpec = { labels: Record<string, string | null>; instruction?: string }
type Logits = Record<string, Record<string, number>>

const FAMILIES: Record<string, { name: string; what: string }> = {
  w2: { name: 'W-2 wage statement', what: 'Form W-2, W-2c, W-2G, W-2AS, W-2GU or W-2VI: wage and tax statement or gambling winnings' },
  f1099: { name: 'Form 1099 information return', what: 'Form 1099-INT, 1099-DIV, 1099-B, 1099-R, 1099-MISC, 1099-NEC, 1099-G, 1099-K, 1099-SA or another 1099' },
  f1098: { name: 'Form 1098 information return', what: 'Form 1098 mortgage interest, 1098-E student loan interest, 1098-T tuition statement, 1098-C, 1098-F, 1098-Q' },
  f1040: { name: 'Form 1040 individual income tax return', what: 'Form 1040, 1040-NR, 1040-SS, 1040-X or a Schedule of Form 1040' },
  info: { name: 'other information return', what: 'Form 1095-A, 1095-B, 1095-C, 1097-BTC, 3921, 3922, 5498, 1042-S, 2439, 8288-A, 8805 or a Schedule K-1' },
  other: { name: 'other IRS tax form', what: 'Any other IRS form or schedule attached to a return, such as Form 8949, 4562, 8995, 2441, 5471, 8865, 1116' },
}

export function familyKey(id: string, criteria: Criteria): string {
  if (/^form-w-2/.test(id)) return 'w2'
  if (/^form-1099-/.test(id)) return 'f1099'
  if (/^form-1098/.test(id)) return 'f1098'
  if (/^form-1040/.test(id)) return 'f1040'
  const e = criteria[id]
  if (e && ((e as { source?: string }).source === 'info' || (e.boxes?.length ?? 0) > 0)) return 'info'
  return 'other'
}

function pageText(state: PageState, chars: number): string {
  const squash = (s: string) =>
    s
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n')
  const head = squash(state.header)
  const foot = squash(state.footer)
  const room = Math.max(0, chars - head.length - foot.length)
  return [head, squash(state.body).slice(0, room), foot].filter(Boolean).join('\n')
}

function clean(s: string): string {
  return s.replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim()
}

function cleanSpec(labels: Record<string, string | null>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(labels).map(([k, v]) => [clean(k), v ? clean(v) : null]))
}

function softmax(logits: Record<string, number>, t: number): Record<string, number> {
  const keys = Object.keys(logits)
  const max = Math.max(...keys.map((k) => logits[k]))
  const ex = keys.map((k) => Math.exp((logits[k] - max) / t))
  const z = ex.reduce((a, b) => a + b, 0)
  return Object.fromEntries(keys.map((k, i) => [k, ex[i] / z]))
}

function answer(probabilities: Record<string, number>): ChoiceAnswer {
  let choice = ''
  let confidence = -1
  for (const [k, v] of Object.entries(probabilities)) if (v > confidence) [choice, confidence] = [k, v]
  return { choice, confidence, probabilities }
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

export function glinerBackend(criteria: Criteria, opts: GlinerOptions = {}): Backend {
  const url = opts.url ?? process.env.GLINER_URL ?? 'http://127.0.0.1:8765'
  const groupSize = opts.groupSize ?? 40
  const keep = opts.keepPerGroup ?? 3
  const chars = opts.textChars ?? 1500
  const t = opts.temperature ?? 1
  const titles = opts.titles ?? false
  const rare = new Set<string>(RARE_PARENTS)
  const labelOf = (id: string) => clean(criteria[id]?.label ?? id)
  const byLabel = new Map(Object.keys(criteria).map((id) => [labelOf(id), id]))
  const labelSpec = (ids: string[]): Record<string, string | null> =>
    Object.fromEntries(ids.map((id) => [labelOf(id), titles && criteria[id]?.title ? criteria[id].title : null]))

  async function score(texts: string[], schemas: Record<string, TaskSpec>[]): Promise<Logits[]> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        texts,
        schemas: schemas.map((sc) =>
          Object.fromEntries(Object.entries(sc).map(([k, v]) => [k, { ...v, labels: cleanSpec(v.labels) }])),
        ),
      }),
    })
    const json = (await res.json()) as { logits?: Logits[]; error?: string }
    if (!res.ok || !json.logits) throw new Error(`gliner service: ${json.error ?? res.status}`)
    return json.logits
  }

  async function withinFamily(text: string, ids: string[]): Promise<Record<string, number>> {
    let finalists = ids
    if (ids.length > groupSize) {
      const groups = chunk(ids, groupSize)
      const round = await score(
        groups.map(() => text),
        groups.map((g) => ({ form: { labels: labelSpec(g) } })),
      )
      finalists = round.flatMap((r) =>
        Object.entries(r.form)
          .sort((a, b) => b[1] - a[1])
          .slice(0, keep)
          .map(([label]) => byLabel.get(label)!),
      )
    }
    const [final] = await score([text], [{ form: { labels: labelSpec(finalists) } }])
    const p = softmax(final.form, t)
    return Object.fromEntries(finalists.map((id) => [id, p[labelOf(id)] ?? 0]))
  }

  return {
    async ask(state, questions: Record<string, ChoiceQuestion>): Promise<AskResult> {
      const text = pageText(state as PageState, chars)
      const answers: Record<string, ChoiceAnswer> = {}
      const first: Record<string, TaskSpec> = {}
      if (questions.kind)
        first.kind = { labels: Object.fromEntries(Object.entries(KIND_CRITERIA).map(([k, c]) => [k, c.what])) }
      if (questions.form)
        first.family = { labels: Object.fromEntries(Object.values(FAMILIES).map((f) => [f.name, f.what])) }
      if (Object.keys(first).length) {
        const [r] = await score([text], [first])
        if (r.kind) answers.kind = answer(softmax(r.kind, t))
        if (r.family && questions.form) {
          const fam = softmax(r.family, t)
          const [topName, topP] = Object.entries(fam).sort((a, b) => b[1] - a[1])[0]
          const top = Object.keys(FAMILIES).find((k) => clean(FAMILIES[k].name) === topName)
          const ids = Object.keys(criteria).filter((id) => familyKey(id, criteria) === top)
          const within = await withinFamily(text, ids)
          const probs: Record<string, number> = {}
          for (const key of Object.keys(questions.form.criteria)) {
            if (key === 'not_in_this_list') {
              probs[key] = 0
              continue
            }
            let p = 0
            for (const [id, v] of Object.entries(within))
              if (id === key || (rare.has(key) && criteria[id]?.parent === key)) p += v
            probs[key] = p * topP
          }
          answers.form = answer(probs)
        }
      }
      if (questions.sub) {
        const ids = Object.keys(questions.sub.criteria).filter((k) => k !== 'not_in_this_list')
        const within = await withinFamily(text, ids)
        answers.sub = answer({ ...within, not_in_this_list: 0 })
      }
      return { answers, inputTokens: 0 }
    },
  }
}
