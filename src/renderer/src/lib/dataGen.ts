import type { DriverType } from '@shared/types'

export type Gen =
  | 'none'
  | 'sequence'
  | 'int'
  | 'decimal'
  | 'bool'
  | 'firstName'
  | 'lastName'
  | 'fullName'
  | 'email'
  | 'word'
  | 'sentence'
  | 'date'
  | 'datetime'
  | 'uuid'
  | 'fixed'

export const GEN_LABELS: Record<Gen, string> = {
  none: '— skip (DB default)',
  sequence: 'Sequence (1,2,3…)',
  int: 'Random integer',
  decimal: 'Random decimal',
  bool: 'Boolean',
  firstName: 'First name',
  lastName: 'Last name',
  fullName: 'Full name',
  email: 'Email',
  word: 'Word',
  sentence: 'Sentence',
  date: 'Date',
  datetime: 'Date & time',
  uuid: 'UUID',
  fixed: 'Fixed value…'
}

const FIRST = ['Ada', 'Alan', 'Grace', 'Linus', 'Margaret', 'Dennis', 'Barbara', 'Tim', 'Katherine', 'Edsger', 'Donald', 'Ken', 'Radia', 'Leslie']
const LAST = ['Lovelace', 'Turing', 'Hopper', 'Torvalds', 'Hamilton', 'Ritchie', 'Liskov', 'Lee', 'Johnson', 'Dijkstra', 'Knuth', 'Thompson', 'Perlman', 'Lamport']
const WORDS = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit', 'sed', 'tempor', 'magna', 'aliqua']
const rand = (n: number): number => Math.floor(Math.random() * n)
const pick = <T>(a: T[]): T => a[rand(a.length)]

/** Best-guess generator from a column's name + type. */
export function guessGen(name: string, type: string, isPk: boolean): Gen {
  const n = name.toLowerCase()
  const t = type.toLowerCase()
  if (isPk && /int|serial/.test(t)) return 'none'
  if (n.includes('email')) return 'email'
  if (n === 'id' || n.endsWith('_id')) return /int|serial/.test(t) ? 'int' : 'uuid'
  if (n.includes('first')) return 'firstName'
  if (n.includes('last') && n.includes('name')) return 'lastName'
  if (n.includes('name')) return 'fullName'
  if (/uuid|guid|uniqueidentifier/.test(t)) return 'uuid'
  if (/bool|bit/.test(t)) return 'bool'
  if (/int/.test(t)) return 'int'
  if (/dec|numeric|real|float|double|money/.test(t)) return 'decimal'
  if (/timestamp|datetime/.test(t)) return 'datetime'
  if (/date/.test(t)) return 'date'
  return 'word'
}

/** Produce a value for row `i`. Returns undefined to omit the column. */
export function genValue(gen: Gen, i: number, driver: DriverType, fixed?: string): unknown {
  switch (gen) {
    case 'none':
      return undefined
    case 'sequence':
      return i + 1
    case 'int':
      return rand(100000)
    case 'decimal':
      return (Math.random() * 10000).toFixed(2)
    case 'bool': {
      const b = Math.random() < 0.5
      return driver === 'sqlite' ? (b ? 1 : 0) : b
    }
    case 'firstName':
      return pick(FIRST)
    case 'lastName':
      return pick(LAST)
    case 'fullName':
      return `${pick(FIRST)} ${pick(LAST)}`
    case 'email':
      return `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}${rand(1000)}@example.com`
    case 'word':
      return pick(WORDS)
    case 'sentence':
      return Array.from({ length: 4 + rand(6) }, () => pick(WORDS)).join(' ')
    case 'date':
      return new Date(Date.now() - rand(365) * 86400000).toISOString().slice(0, 10)
    case 'datetime':
      return new Date(Date.now() - rand(365) * 86400000).toISOString().slice(0, 19).replace('T', ' ')
    case 'uuid':
      return crypto.randomUUID()
    case 'fixed':
      return fixed ?? ''
    default:
      return null
  }
}
