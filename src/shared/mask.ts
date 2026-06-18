// Data-masking / anonymization definitions, shared by the export wizard (UI)
// and the main-process masker (which maps these to faker generators).

export type MaskType =
  | 'none'
  | 'fullName'
  | 'firstName'
  | 'lastName'
  | 'username'
  | 'email'
  | 'phone'
  | 'streetAddress'
  | 'city'
  | 'country'
  | 'zipCode'
  | 'company'
  | 'jobTitle'
  | 'url'
  | 'ipv4'
  | 'uuid'
  | 'creditCard'
  | 'iban'
  | 'date'
  | 'sentence'
  | 'number'
  | 'boolean'
  | 'redact'
  | 'null'

/** table name -> (column name -> mask type). Only non-'none' entries matter. */
export type MaskConfig = Record<string, Record<string, MaskType>>

export interface MaskOption {
  value: MaskType
  label: string
  group: string
}

export const MASK_OPTIONS: MaskOption[] = [
  { value: 'none', label: 'Keep original', group: '' },
  { value: 'fullName', label: 'Full name', group: 'Identity' },
  { value: 'firstName', label: 'First name', group: 'Identity' },
  { value: 'lastName', label: 'Last name', group: 'Identity' },
  { value: 'username', label: 'Username', group: 'Identity' },
  { value: 'email', label: 'Email', group: 'Identity' },
  { value: 'phone', label: 'Phone number', group: 'Identity' },
  { value: 'streetAddress', label: 'Street address', group: 'Address' },
  { value: 'city', label: 'City', group: 'Address' },
  { value: 'country', label: 'Country', group: 'Address' },
  { value: 'zipCode', label: 'Zip / postal code', group: 'Address' },
  { value: 'company', label: 'Company name', group: 'Business' },
  { value: 'jobTitle', label: 'Job title', group: 'Business' },
  { value: 'url', label: 'URL', group: 'Internet & IDs' },
  { value: 'ipv4', label: 'IP address', group: 'Internet & IDs' },
  { value: 'uuid', label: 'UUID', group: 'Internet & IDs' },
  { value: 'creditCard', label: 'Credit-card number', group: 'Finance' },
  { value: 'iban', label: 'IBAN', group: 'Finance' },
  { value: 'date', label: 'Date (past)', group: 'Other' },
  { value: 'sentence', label: 'Lorem sentence', group: 'Other' },
  { value: 'number', label: 'Random number', group: 'Other' },
  { value: 'boolean', label: 'Random boolean', group: 'Other' },
  { value: 'redact', label: 'Redact (★★★)', group: 'Other' },
  { value: 'null', label: 'Set to NULL', group: 'Other' }
]

export const MASK_LABELS: Record<MaskType, string> = Object.fromEntries(
  MASK_OPTIONS.map((o) => [o.value, o.label])
) as Record<MaskType, string>

/** Best-effort default mask for a column, from its name & type. Never masks IDs. */
export function guessMask(col: string, _type: string): MaskType {
  const n = col.toLowerCase()
  if (/(^|_)id$/.test(n) || n === 'id') return 'none' // keep keys → relationships intact
  if (/e[-_]?mail/.test(n)) return 'email'
  if (/first[-_ ]?name|fname|given/.test(n)) return 'firstName'
  if (/last[-_ ]?name|lname|surname|family[-_ ]?name/.test(n)) return 'lastName'
  if (/full[-_ ]?name|display[-_ ]?name|^name$|contact[-_ ]?name/.test(n)) return 'fullName'
  if (/user[-_ ]?name|login|handle/.test(n)) return 'username'
  if (/phone|mobile|telephone|\btel\b|gsm/.test(n)) return 'phone'
  if (/street|address(?!.*id)|addr|address[-_ ]?line/.test(n)) return 'streetAddress'
  if (/\bcity\b|town/.test(n)) return 'city'
  if (/country/.test(n)) return 'country'
  if (/zip|postal|postcode/.test(n)) return 'zipCode'
  if (/company|organi[sz]ation|employer/.test(n)) return 'company'
  if (/job[-_ ]?title|position|\brole\b/.test(n)) return 'jobTitle'
  if (/website|homepage|\burl\b/.test(n)) return 'url'
  if (/ip[-_ ]?addr|ipaddress|client[-_ ]?ip/.test(n)) return 'ipv4'
  if (/uuid|guid/.test(n)) return 'uuid'
  if (/iban|bank[-_ ]?account/.test(n)) return 'iban'
  if (/credit[-_ ]?card|card[-_ ]?number|ccnum/.test(n)) return 'creditCard'
  if (/birth|\bdob\b/.test(n)) return 'date'
  return 'none'
}
