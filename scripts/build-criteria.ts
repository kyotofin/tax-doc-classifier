import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { fileUrlPath } from './file-url-path.js'
import { irsPdfName, isFormId, labelOf, mefNameToId, parentOf } from '../src/ids.js'
import { isBlank, isCoverSheet, pdfPageCount, pdfPageLines } from '../src/state.js'
import type { Criteria, CriteriaEntry } from '../src/classify.js'

const MEF_XLSX = 'https://www.irs.gov/pub/irs-efile/tax-year-2025-accepted-forms-schedules-individual-tax-returns-extensions.xlsx'
const IRS_PDF = 'https://www.irs.gov/pub/irs-pdf/'
const NOT_ON_IRS_GOV = new Set(['form-499-w-2-pr', 'form-rrb-1042-s', 'form-ssa-1042-s'])
const OVERRIDE_URL: Record<string, string> = {
  'form-8845': 'https://www.irs.gov/pub/irs-prior/f8845--2022.pdf',
  'form-1099-b': `${IRS_PDF}f1099b--2025.pdf`,
}
const INFO_RETURNS = [
  'form-1097-btc', 'form-1098', 'form-1098-c', 'form-1098-e', 'form-1098-f', 'form-1098-q', 'form-1098-t',
  'form-1099-a', 'form-1099-b', 'form-1099-c', 'form-1099-cap', 'form-1099-da', 'form-1099-div', 'form-1099-g',
  'form-1099-h', 'form-1099-int', 'form-1099-k', 'form-1099-ls', 'form-1099-ltc', 'form-1099-misc', 'form-1099-nec',
  'form-1099-oid', 'form-1099-patr', 'form-1099-q', 'form-1099-s', 'form-1099-sa', 'form-1099-sb',
  'form-3921', 'form-3922', 'form-5498', 'form-5498-esa', 'form-5498-qa', 'form-5498-sa',
  'form-1095-a', 'form-1095-b', 'form-1095-c', 'form-1042-s', 'form-w-2c',
  'form-1065-schedule-k-1', 'form-1120-s-schedule-k-1',
]
const INFO_FILE: Record<string, string> = {
  'form-1099-misc': 'f1099msc.pdf',
  'form-1099-patr': 'f1099ptr.pdf',
  'form-5498-esa': 'f5498e.pdf',
  'form-1120-s-schedule-k-1': 'f1120ssk.pdf',
}
const BOX_FORMS = /^form-(1099|1098|5498|1095|1097|1042|w-2|3921|3922)/
const TITLE_BOILERPLATE =
  /(Department of the Treasury|Internal Revenue Service|OMB No\.? ?\d{4}-\d{4}|Go to www\.irs\.gov\S*|www\.irs\.gov\S*|Attach to .*?\.|▶|►|VOID|CORRECTED|\(if checked\)|Cat\. No\. \S+|For Privacy Act.*|\b(19|20)\d\d\b|\d{4,5})/g
const BOX_RE = /(?<![\w$,.\-/])(\d{1,2}[a-z]?)\s{1,4}([A-Z][^\n]{4,70}?)(?=\s{3,}|$)/g

const root = fileUrlPath(import.meta.url, '..')
const corpus = join(root, 'eval', 'corpus', 'blank')
await mkdir(corpus, { recursive: true })

async function download(url: string, out: string): Promise<boolean> {
  try {
    await access(out)
    return true
  } catch {}
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 tax-doc-classifier' } })
  if (!res.ok) return false
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes[0] !== 0x25) return false
  await writeFile(out, bytes)
  return true
}

async function mefIds(): Promise<string[]> {
  const res = await fetch(MEF_XLSX)
  const zip = unzipSync(new Uint8Array(await res.arrayBuffer()))
  const ss = strFromU8(zip['xl/sharedStrings.xml'])
  const strings = [...ss.matchAll(/<si>(.*?)<\/si>/gs)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&'))
  const sheet = strFromU8(zip['xl/worksheets/sheet1.xml'])
  const ids: string[] = []
  for (const row of sheet.matchAll(/<row[^>]*>(.*?)<\/row>/gs)) {
    const cell = row[1].match(/<c\b([^>]*)>(.*?)<\/c>/s)
    if (!cell) continue
    const v = cell[2].match(/<v>(.*?)<\/v>/)
    if (!v) continue
    const text = /t="s"/.test(cell[1]) ? strings[Number(v[1])] : v[1]
    const name = text.replace(/\s+/g, ' ').trim()
    if (!/^Form \S+/.test(name)) continue
    ids.push(mefNameToId(name))
  }
  return ids
}

const ids = [...new Set([...(await mefIds()), ...INFO_RETURNS])].filter((id) => !NOT_ON_IRS_GOV.has(id)).sort()
for (const id of ids) if (!isFormId(id)) throw new Error(`id violates grammar: ${id}`)
console.log(`${ids.length} form ids`)

const entries: Criteria = {}
const manifest: { id: string; source: string; url: string; pages: number; blankPages: number[] }[] = []
let missing: string[] = []
const queue = [...ids]
async function worker() {
  for (;;) {
    const id = queue.shift()
    if (!id) return
    const url = OVERRIDE_URL[id] ?? IRS_PDF + (INFO_FILE[id] ?? irsPdfName(id))
    const file = join(corpus, `${id}.pdf`)
    if (!(await download(url, file))) {
      missing.push(id)
      continue
    }
    const pages = await pdfPageCount(file)
    const blankPages: number[] = []
    let title = ''
    const boxes: string[] = []
    const seen = new Set<string>()
    for (let p = 1; p <= pages; p++) {
      const lines = await pdfPageLines(file, p)
      if (isBlank(lines)) {
        blankPages.push(p)
        continue
      }
      if (isCoverSheet(lines)) continue
      if (!title) title = lines.slice(0, 8).join(' ').replace(TITLE_BOILERPLATE, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
      if (!BOX_FORMS.test(id) || boxes.length >= 8) continue
      for (const line of lines) {
        for (const m of line.matchAll(BOX_RE)) {
          const label = m[2].replace(/[ .]{3,}/g, ' ').trim()
          if (seen.has(m[1]) || label.length < 6 || /^(form|schedule|see |go to|attach|enter|if you|for )/i.test(label)) continue
          seen.add(m[1])
          boxes.push(`${m[1]} ${label}`.slice(0, 60))
          if (boxes.length >= 8) break
        }
        if (boxes.length >= 8) break
      }
    }
    const e: CriteriaEntry = { id, label: labelOf(id), title, pageCount: pages }
    const parent = parentOf(id)
    if (parent) e.parent = parent
    if (boxes.length) e.boxes = boxes
    entries[id] = e
    manifest.push({ id, source: INFO_RETURNS.includes(id) ? 'info' : 'mef', url, pages, blankPages })
  }
}
await Promise.all(Array.from({ length: 12 }, worker))

const stem = (id: string) => id.match(/(\d{3,4})/)?.[1] ?? id
const bySteM: Record<string, string[]> = {}
for (const id of Object.keys(entries)) (bySteM[stem(id)] ??= []).push(id)
for (const id of Object.keys(entries)) {
  const others = bySteM[stem(id)].filter((s) => s !== id).map(labelOf)
  if (others.length) entries[id].notFor = others
}
const TITLE_FIX: Record<string, string> = {
  'form-1098-e': "Student Loan Interest Statement — RECIPIENT'S/LENDER'S name, BORROWER'S name",
  'form-1098': "Mortgage Interest Statement — RECIPIENT'S/LENDER'S name, PAYER'S/BORROWER'S name",
}
for (const [id, t] of Object.entries(TITLE_FIX)) if (entries[id]) entries[id].title = t

const sorted: Criteria = {}
for (const id of Object.keys(entries).sort()) sorted[id] = entries[id]
await writeFile(join(root, 'data', 'criteria.json'), JSON.stringify(sorted, null, 1) + '\n')
manifest.sort((a, b) => a.id.localeCompare(b.id))
await writeFile(join(root, 'eval', 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n')
console.log(`criteria.json: ${Object.keys(sorted).length} forms, ${Object.values(sorted).filter((e) => e.boxes).length} with boxes, ${Object.values(sorted).filter((e) => e.parent).length} schedules`)
console.log(`manifest: ${manifest.reduce((n, m) => n + m.pages, 0)} pages, ${manifest.reduce((n, m) => n + m.blankPages.length, 0)} blank`)
if (missing.length) console.log(`not downloaded: ${missing.join(', ')}`)
