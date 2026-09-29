import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { cpus, totalmem } from 'node:os'
import { basename, join } from 'node:path'
import {
  classifyPage,
  firstListCriteria,
  isCoverSheet,
  jevBackend,
  pdfPageCount,
  pdfPageLines,
  score,
  summarize,
  type Backend,
  type Criteria,
  type PageResult,
  type Scored,
} from '../src/index.js'
import { rulesBackend } from '../src/backends/rules.js'
import { glinerBackend } from '../src/backends/gliner.js'
import { hybridBackend, type HybridBackend } from '../src/backends/hybrid.js'
import { deciderBackend } from '../src/backends/decider.js'
import { shortlistBackend } from '../src/backends/shortlist.js'

type Row = { id: string; source: string; url: string; pages: number; blankPages: number[] }
type Job = { file: string; truth: string; page: number; pageCount: number; label: string }

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const corpus = args.corpus ?? 'blank'
const gate = Number(args.gate ?? 0.95)
const backendName = args.backend ?? 'jev'
const tag = args.tag ? `-${args.tag}` : ''
const local = backendName !== 'jev'
const concurrency = Number(args.concurrency ?? (local ? 1 : 12))
const warmup = Number(args.warmup ?? (local ? 5 : 0))
const root = new URL('.', import.meta.url).pathname
const criteria = JSON.parse(await readFile(join(root, '..', 'data', 'criteria.json'), 'utf8')) as Criteria

const BENCH_MAP: Record<string, string> = {
  w2: 'form-w-2',
  w2g: 'form-w-2g',
  '1040': 'form-1040',
  '1099int': 'form-1099-int',
  '1099b': 'form-1099-b',
  '1099div': 'form-1099-div',
  '1099r': 'form-1099-r',
  '1099misc': 'form-1099-misc',
  '1099g': 'form-1099-g',
  '1099nec': 'form-1099-nec',
  '1099k': 'form-1099-k',
  '1099sa': 'form-1099-sa',
  '1098': 'form-1098',
  '1098t': 'form-1098-t',
  '1098e': 'form-1098-e',
}

async function blankJobs(): Promise<Job[]> {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as Row[]
  const jobs: Job[] = []
  for (const row of manifest) {
    const file = join(root, 'corpus', 'blank', `${row.id}.pdf`)
    const pages = Math.min(row.pages, await pdfPageCount(file))
    for (let p = 1; p <= pages; p++) {
      const truth = row.blankPages.includes(p) ? 'blank' : row.id
      jobs.push({ file, truth, page: p, pageCount: pages, label: row.id })
    }
  }
  return jobs
}

async function benchJobs(dir: string): Promise<Job[]> {
  const jobs: Job[] = []
  for (const c of await readdir(dir, { withFileTypes: true })) {
    if (!c.isDirectory()) continue
    const input = join(dir, c.name, 'input')
    let files: string[] = []
    try {
      files = (await readdir(input)).filter((f) => f.endsWith('.pdf'))
    } catch {
      continue
    }
    for (const f of files) {
      const stem = basename(f, '.pdf').replace(/_\d+$/, '').replace('_2024', '')
      const truth = BENCH_MAP[stem]
      if (!truth) throw new Error(`no id for bench file ${f}`)
      const file = join(input, f)
      const n = await pdfPageCount(file)
      for (let p = 1; p <= n; p++) jobs.push({ file, truth, page: p, pageCount: n, label: `${c.name}/${f}` })
    }
  }
  return jobs
}

const deciderUrl = args['decider-url'] ?? process.env.DECIDER_URL ?? 'http://127.0.0.1:8770'
const shortlist = Number(args.shortlist ?? 10)
const lean = args.lean === '1'
const glinerUrl = args['gliner-url'] ?? process.env.GLINER_URL ?? 'http://127.0.0.1:8765'

function makeBackend(name: string): Backend {
  if (name === 'jev') return jevBackend()
  if (name === 'rules') return rulesBackend(criteria)
  if (name === 'gliner') return glinerBackend(criteria, { url: glinerUrl })
  if (name === 'hybrid') return hybridBackend(rulesBackend(criteria), glinerBackend(criteria, { url: glinerUrl }), gate)
  if (name === 'decider') return shortlistBackend(rulesBackend(criteria), deciderBackend(deciderUrl, lean), shortlist)
  if (name === 'hybrid-decider')
    return hybridBackend(rulesBackend(criteria), shortlistBackend(rulesBackend(criteria), deciderBackend(deciderUrl, lean), shortlist), gate)
  throw new Error(`unknown backend ${name}`)
}

async function serviceStats(url: string): Promise<unknown> {
  try {
    return await (await fetch(url)).json()
  } catch {
    return null
  }
}

function runnerUp(r: PageResult): { form: string; p: number } {
  const probs = r.probabilities.sub ?? r.probabilities.form
  const sorted = Object.entries(probs)
    .filter(([k]) => k !== r.form && k !== 'not_in_this_list')
    .sort((a, b) => b[1] - a[1])
  return sorted.length ? { form: sorted[0][0], p: sorted[0][1] } : { form: '', p: 0 }
}

function pct(xs: number[], q: number): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}

type OutRow = Scored & {
  label: string
  page: number
  pageCount: number
  kind: string
  ms: number
  runnerUp: { form: string; p: number }
  decidedBy?: string
}

const sample = Number(args.sample ?? 1)
const allJobs = corpus === 'bench' ? await benchJobs(args.dir ?? process.env.BENCH_DIR ?? '') : await blankJobs()
const jobs = allJobs.filter((_, i) => i % sample === 0)
const backend = makeBackend(backendName)
const hybrid = backendName.startsWith('hybrid') ? (backend as HybridBackend) : undefined
const firstList = firstListCriteria(criteria)
const t0 = Date.now()
const rows: OutRow[] = []
let done = 0
const queue = [...jobs]
async function worker() {
  for (;;) {
    const j = queue.shift()
    if (!j) return
    const lines = await pdfPageLines(j.file, j.page)
    if (isCoverSheet(lines)) continue
    const before = hybrid?.stats.model ?? 0
    const s0 = performance.now()
    const result = await classifyPage(lines, { backend, criteria, gate, firstList })
    const ms = performance.now() - s0
    const decidedBy = hybrid ? (hybrid.stats.model > before ? 'model' : result.calls ? 'rules' : 'blank') : undefined
    rows.push({
      ...score(j.truth, result, gate),
      label: j.label,
      page: j.page,
      pageCount: j.pageCount,
      kind: result.kind,
      ms,
      runnerUp: runnerUp(result),
      ...(decidedBy ? { decidedBy } : {}),
    })
    if (++done % 100 === 0) console.log(`.. ${done}/${jobs.length} ${Math.round((Date.now() - t0) / 1000)}s`)
  }
}
await Promise.all(Array.from({ length: concurrency }, worker))

const s = summarize(rows)
const timed = rows.slice(warmup).filter((r) => r.result.calls > 0).map((r) => r.ms)
const latency = { p50: pct(timed, 0.5), p95: pct(timed, 0.95), mean: timed.reduce((a, b) => a + b, 0) / (timed.length || 1), n: timed.length }
const calibration = [0.8, 0.9, 0.95, 0.99].map((g) => {
  const covered = rows.filter((r) => r.result.formConfidence >= g)
  const right = covered.filter((r) => !r.wrong).length
  return {
    gate: g,
    coverage: covered.length / (rows.length || 1),
    accuracy: covered.length ? right / covered.length : 1,
    confidentWrong: covered.length - right,
    strict: rows.length - right,
  }
})
const abstained = rows.filter((r) => r.result.formConfidence < gate).length
const blankLabelled = rows.filter((r) => r.truth === 'blank')
const kinds = {
  blankPages: blankLabelled.length,
  blankKindCorrect: blankLabelled.filter((r) => r.kind === 'blank').length,
  distribution: rows.reduce<Record<string, number>>((m, r) => ((m[r.kind] = (m[r.kind] ?? 0) + 1), m), {}),
}
const machine = { cpu: cpus()[0]?.model, cores: cpus().length, ramGb: Math.round(totalmem() / 2 ** 30), platform: process.platform, arch: process.arch }
const memory = {
  nodePeakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
  gliner: backendName === 'gliner' || backendName === 'hybrid' ? await serviceStats(glinerUrl) : undefined,
  decider: backendName.includes('decider') ? await serviceStats(deciderUrl) : undefined,
}
const decided = hybrid ? { rules: rows.filter((r) => r.decidedBy === 'rules').length, model: rows.filter((r) => r.decidedBy === 'model').length, blank: rows.filter((r) => r.decidedBy === 'blank').length } : undefined

console.log(`\n${corpus.toUpperCase()} backend=${backendName}  pages ${s.pages}  time ${Math.round((Date.now() - t0) / 1000)}s  calls ${s.calls}`)
console.log(`STRICT (wrong or < ${gate}): ${s.strict} of ${s.pages} = ${(100 * s.strictRate).toFixed(2)}%   wrong ${s.wrong}   abstained ${abstained}`)
console.log(`latency p50 ${latency.p50.toFixed(1)} ms  p95 ${latency.p95.toFixed(1)} ms  (n=${latency.n}, concurrency ${concurrency})`)
for (const c of calibration)
  console.log(`  gate ${c.gate}: coverage ${(100 * c.coverage).toFixed(1)}%  accuracy ${(100 * c.accuracy).toFixed(2)}%  confident-wrong ${c.confidentWrong}  strict ${c.strict}`)
if (decided) console.log(`decided by: rules ${decided.rules}  model ${decided.model}  blank ${decided.blank}`)
const strictRows = rows.filter((r) => r.strict).sort((a, b) => a.result.formConfidence - b.result.formConfidence)
for (const r of strictRows)
  console.log(
    `  ${r.label.padEnd(34)} p${r.page}/${String(r.pageCount).padEnd(2)} ${r.truth.padEnd(28)} -> ${r.result.form.padEnd(28)} conf ${r.result.formConfidence.toFixed(2)} 2nd ${r.runnerUp.form} ${r.runnerUp.p.toFixed(2)} kind=${r.kind}${r.wrong ? '  WRONG' : ''}`,
  )
await mkdir(join(root, 'results'), { recursive: true })
const out = join(root, 'results', `${corpus}-${backendName}${tag}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`)
await writeFile(
  out,
  JSON.stringify({ corpus, backend: backendName, tag: args.tag, gliner: backendName === 'gliner' || backendName === 'hybrid' ? glinerUrl : undefined, sample, shortlist: backendName.includes('decider') ? shortlist : undefined, lean: backendName.includes('decider') ? lean : undefined, gate, machine, summary: { ...s, abstained }, latency, calibration, kinds, memory, decided, rows }, null, 1),
)
console.log(`results → ${out}`)
