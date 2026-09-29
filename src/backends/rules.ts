import type { AskResult, Backend, ChoiceAnswer, ChoiceQuestion } from '../backend.js'
import { RARE_PARENTS, type Criteria, type CriteriaEntry } from '../classify.js'
import type { PageState } from '../state.js'

export type RulesOptions = { temperature?: number; nilScore?: number }

type Matcher = {
  id: string
  family: string
  ref: RegExp
  anchored: RegExp
  own: RegExp
  split?: { sched: RegExp; form: RegExp }
  url: RegExp
  head: RegExp
  titleWords: string[]
  boxPhrases: string[]
  infoReturn: boolean
}

const STOP = new Set([
  'form', 'forms', 'schedule', 'with', 'from', 'that', 'this', 'your', 'return', 'returns', 'income', 'information',
  'instructions', 'latest', 'attach', 'attachment', 'sequence', 'department', 'treasury', 'internal', 'revenue',
  'service', 'name', 'shown', 'number', 'identifying', 'social', 'security', 'only', 'write', 'staple', 'space',
  'separate', 'street', 'address', 'city', 'town', 'state', 'province', 'country', 'foreign', 'postal', 'code',
  'telephone', 'payer', 'payers', 'recipient', 'recipients', 'filer', 'filers', 'copy', 'omb', 'rev', 'december',
  'january', 'november', 'october', 'september', 'for', 'and', 'the', 'see', 'www', 'irs', 'gov', 'use',
])

const RARE_FAMILY = new Set<string>(RARE_PARENTS)

export function normalize(s: string): string {
  return s
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function flexNum(num: string): string {
  return num
    .split('-')
    .map(esc)
    .join('\\s?-\\s?')
}

const TAIL = String.raw`(?![\w-])`
const ANCHOR_TAIL = String.raw`\s*(?:\(\s*(?:19|20)\d\d\s*\)|(?:19|20)\d\d\b|\(\s*Rev\.|\(\s*\d{1,2}-(?:19|20)?\d\d\s*\)|Page\s+\d)`

function words(s: string): string[] {
  return (s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w))
}

function buildMatcher(e: CriteriaEntry): Matcher {
  const sched = e.label.match(/^Schedule (\S+) \(Form (.+)\)$/)
  const form = e.label.match(/^Form (.+)$/)
  const num = sched ? sched[2] : form ? form[1] : e.label
  const family = e.parent && RARE_FAMILY.has(e.parent) ? e.parent : e.id
  const compact = num.replace(/-/g, '')
  let refSrc: string
  let split: Matcher['split']
  let urlSrc: string
  let headSrc: string
  if (sched) {
    refSrc = String.raw`Schedule\s+${flexNum(sched[1])}\s*\(\s*Form\s*${flexNum(num)}\s*\)`
    split = {
      sched: new RegExp(String.raw`^SCHEDULE\s+${flexNum(sched[1])}${TAIL}`),
      form: new RegExp(String.raw`\(\s*Form\s*${flexNum(num)}\s*\)`, 'i'),
    }
    urlSrc = String.raw`irs\.gov/(?:Form${esc(compact)})?Schedule${esc(sched[1].replace(/-/g, ''))}(?:Form${esc(compact)})?(?![A-Za-z0-9])`
    headSrc = String.raw`^SCHEDULE\s+${flexNum(sched[1])}${TAIL}`
  } else {
    refSrc = String.raw`Form\s*${flexNum(num)}${TAIL}`
    urlSrc = String.raw`irs\.gov/Form${esc(compact)}(?![A-Za-z0-9])`
    headSrc = String.raw`^(?:Form\s*)?${flexNum(num)}${TAIL}(?!\s*[.,;:)])`
  }
  const titleWords = [...new Set(words(e.title))].slice(0, 12)
  const boxPhrases = (e.boxes ?? [])
    .map((b) => normalize(b).replace(/^\d+[a-z]?\s+/i, '').toLowerCase())
    .filter((b) => b.length >= 8)
  return {
    id: e.id,
    family,
    ref: new RegExp(refSrc, 'gi'),
    anchored: new RegExp(refSrc + ANCHOR_TAIL, 'i'),
    own: new RegExp(String.raw`developments related to\s+` + refSrc, 'i'),
    split,
    url: new RegExp(urlSrc, 'i'),
    head: new RegExp(headSrc, 'i'),
    titleWords,
    boxPhrases,
    infoReturn: (e.boxes?.length ?? 0) > 0,
  }
}

type Parts = { structural: number; mention: number }

function scoreOne(m: Matcher, head: string[], tail: string[], all: string, lower: string, flat: string): Parts {
  let structural = 0
  let mention = 0
  if (tail.some((l) => m.anchored.test(l))) structural += 10
  if (head.slice(0, 3).some((l) => m.anchored.test(l))) structural += 10
  const headText = head.slice(0, 8).join('\n')
  if (m.split) {
    if (head.slice(0, 8).some((l) => m.split!.sched.test(l)) && m.split.form.test(headText)) structural += 6
  } else if (head.slice(0, 6).some((l) => m.head.test(l)) || tail.some((l) => m.head.test(l))) structural += 5
  if (m.own.test(flat)) structural += 8
  if (new RegExp(m.ref.source, 'i').test(headText)) mention += 3
  mention += Math.min((all.match(m.ref) ?? []).length, 4) * 0.5
  if (m.url.test(all)) mention += 3
  if (m.titleWords.length >= 3) {
    const hw = new Set(words(head.slice(0, 4).join(' ')))
    const frac = m.titleWords.filter((w) => hw.has(w)).length / m.titleWords.length
    if (frac >= 0.5) structural += 4 * frac
  }
  if (m.boxPhrases.length) {
    const hit = m.boxPhrases.filter((p) => lower.includes(p)).length
    mention += (6 * hit) / m.boxPhrases.length
  }
  return { structural, mention }
}

export function scorePage(matchers: Matcher[], state: PageState): Map<string, number> {
  const head = state.header.split('\n').map(normalize)
  const body = state.body.split('\n').map(normalize)
  const foot = state.footer.split('\n').map(normalize)
  const tail = (foot.length ? foot : body).slice(-6)
  const all = [...head, ...body, ...foot].join('\n')
  const flat = all.replace(/\s+/g, ' ')
  const lower = flat.toLowerCase()
  const parts = new Map<string, Parts>()
  for (const m of matchers) parts.set(m.id, scoreOne(m, head, tail, all, lower, flat))
  const shadowed = new Set<string>()
  for (const m of matchers) {
    const parent = m.id.match(/^(form-.+?)-schedule-/)?.[1]
    if (parent && (parts.get(m.id)?.structural ?? 0) >= 6) shadowed.add(parent)
  }
  const recipient = RECIPIENT.test(flat)
  const info = new Set(matchers.filter((m) => m.infoReturn).map((m) => m.id))
  const out = new Map<string, number>()
  for (const [id, p] of parts) {
    const mention = recipient && !info.has(id) ? p.mention * 0.2 : p.mention
    out.set(id, shadowed.has(id) ? Math.min(p.structural, 5) : p.structural + mention)
  }
  return out
}

function softmax(keys: string[], scores: number[], temperature: number): Record<string, number> {
  const max = Math.max(...scores)
  const ex = scores.map((s) => Math.exp((s - max) / temperature))
  const z = ex.reduce((a, b) => a + b, 0)
  const out: Record<string, number> = {}
  keys.forEach((k, i) => (out[k] = ex[i] / z))
  return out
}

function answer(probabilities: Record<string, number>): ChoiceAnswer {
  let choice = ''
  let confidence = -1
  for (const [k, v] of Object.entries(probabilities)) if (v > confidence) [choice, confidence] = [k, v]
  return { choice, confidence, probabilities }
}

const RECIPIENT = /Instructions for (?:the )?(?:Recipient|Employee|Payer|Borrower|Student|Participant|Payee|Winner|Transferor|Shareholder|Partner|Beneficiary|Lender|Debtor|Policyholder|Account Holder)/i

const INSTR = /Instructions for (?:Recipient|Employee|Payer|Borrower|Student|Filer|Participant|Payee|Winner|Transferor|Shareholder|Partner|Beneficiary|Lender)|General Instructions|Specific Instructions|Future Developments|Purpose of Form|Who Must File|What'?s New/i

export function kindProbabilities(state: PageState, options: string[]): Record<string, number> {
  const lines = [state.header, state.body, state.footer].join('\n').split('\n').map(normalize)
  const entry = lines.filter((l) => /(?:^|\s)\d{1,2}[a-z]?\s*$|^\d{1,2}[a-z]?\s+\S|\$\s*$|\.\s\.\s\./.test(l)).length
  const omb = lines.some((l) => /OMB No\./i.test(l)) ? 1 : 0
  const instr = lines.filter((l) => INSTR.test(l)).length
  const fill = entry / Math.max(lines.length, 1) + omb * 0.3
  const pInstr = instr > 0 && fill < 0.35 ? 0.85 : fill < 0.1 ? 0.6 : 0.08
  const probs: Record<string, number> = {}
  const rest = options.filter((o) => o !== 'form_page' && o !== 'instructions')
  for (const o of rest) probs[o] = 0.01
  const free = 1 - 0.01 * rest.length
  probs.instructions = free * pInstr
  probs.form_page = free * (1 - pInstr)
  return probs
}

export function rulesMatchers(criteria: Criteria): Matcher[] {
  return Object.values(criteria).map(buildMatcher)
}

export function rulesBackend(criteria: Criteria, opts: RulesOptions = {}): Backend {
  const temperature = opts.temperature ?? 1
  const nilScore = opts.nilScore ?? 5
  const matchers = rulesMatchers(criteria)
  return {
    async ask(state, questions: Record<string, ChoiceQuestion>): Promise<AskResult> {
      const page = state as PageState
      const scores = scorePage(matchers, page)
      const answers: Record<string, ChoiceAnswer> = {}
      for (const [name, q] of Object.entries(questions)) {
        const keys = Object.keys(q.criteria)
        if (name === 'kind') {
          answers[name] = answer(kindProbabilities(page, keys))
          continue
        }
        const vals = keys.map((k) => {
          if (k === 'not_in_this_list') return nilScore
          if (name === 'form' && RARE_FAMILY.has(k)) {
            let best = -Infinity
            for (const m of matchers) if (m.family === k) best = Math.max(best, scores.get(m.id) ?? 0)
            return best
          }
          return scores.get(k) ?? 0
        })
        answers[name] = answer(softmax(keys, vals, temperature))
      }
      return { answers, inputTokens: 0 }
    },
  }
}
