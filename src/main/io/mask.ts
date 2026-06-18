// Faker-backed value masking for anonymized exports. Masking is deterministic
// per (type, original value) so the same input always yields the same fake
// output — duplicated values (and any masked join keys) stay consistent.
import { faker } from '@faker-js/faker'
import type { ColumnMeta } from '@shared/types'
import type { MaskType, MaskConfig } from '@shared/mask'

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function generate(type: MaskType): unknown {
  switch (type) {
    case 'fullName': return faker.person.fullName()
    case 'firstName': return faker.person.firstName()
    case 'lastName': return faker.person.lastName()
    case 'username': return faker.internet.username()
    case 'email': return faker.internet.email()
    case 'phone': return faker.phone.number()
    case 'streetAddress': return faker.location.streetAddress()
    case 'city': return faker.location.city()
    case 'country': return faker.location.country()
    case 'zipCode': return faker.location.zipCode()
    case 'company': return faker.company.name()
    case 'jobTitle': return faker.person.jobTitle()
    case 'url': return faker.internet.url()
    case 'ipv4': return faker.internet.ipv4()
    case 'uuid': return faker.string.uuid()
    case 'creditCard': return faker.finance.creditCardNumber()
    case 'iban': return faker.finance.iban()
    case 'date': return faker.date.past({ years: 5 }).toISOString().slice(0, 19).replace('T', ' ')
    case 'sentence': return faker.lorem.sentence()
    case 'number': return faker.number.int({ min: 0, max: 1_000_000 })
    case 'boolean': return faker.datatype.boolean()
    case 'redact': return '★★★'
    case 'null': return null
    default: return undefined
  }
}

/** Mask one value (NULLs are preserved; deterministic by type + original). */
export function maskValue(type: MaskType, original: unknown): unknown {
  if (type === 'none') return original
  if (type === 'null') return null
  if (original === null || original === undefined) return original
  faker.seed(hash(`${type}:${String(original)}`))
  return generate(type)
}

/**
 * Apply a table's masks to a page of rows in place-friendly fashion (returns new
 * rows). `masks` maps column name -> mask type for the current table.
 */
export function applyMasks(
  columns: ColumnMeta[],
  rows: unknown[][],
  masks: Record<string, MaskType>
): unknown[][] {
  const idx: { i: number; type: MaskType }[] = []
  columns.forEach((c, i) => {
    const t = masks[c.name]
    if (t && t !== 'none') idx.push({ i, type: t })
  })
  if (!idx.length) return rows
  return rows.map((row) => {
    const copy = row.slice()
    for (const { i, type } of idx) copy[i] = maskValue(type, copy[i])
    return copy
  })
}

export function tableMasks(config: MaskConfig | undefined, table: string): Record<string, MaskType> | undefined {
  const m = config?.[table]
  return m && Object.keys(m).length ? m : undefined
}
