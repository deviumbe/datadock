// Lightweight, dialect-agnostic SQL lint rules — heuristic hints surfaced
// before a query runs. Best-effort regex checks, never blocking.
export interface SqlLint {
  rule: string
  severity: 'warn' | 'info'
  message: string
}

function strip(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
}

export function lintSql(sql: string): SqlLint[] {
  const clean = strip(sql)
  if (!clean.trim()) return []
  const out: SqlLint[] = []
  const stmts = clean.split(';').map((s) => s.trim()).filter(Boolean)

  // = NULL / != NULL / <> NULL
  if (/(?:=|!=|<>)\s*null\b/i.test(clean)) {
    out.push({
      rule: 'null-compare',
      severity: 'warn',
      message: 'Comparing with = NULL is never true — use IS NULL / IS NOT NULL.'
    })
  }

  // SELECT *
  if (/\bselect\s+\*/i.test(clean)) {
    out.push({
      rule: 'select-star',
      severity: 'info',
      message: 'SELECT * fetches every column — list only the columns you need.'
    })
  }

  for (const s of stmts) {
    if (/^update\b/i.test(s) && !/\bwhere\b/i.test(s)) {
      out.push({ rule: 'update-no-where', severity: 'warn', message: 'UPDATE without WHERE modifies every row.' })
    }
    if (/^delete\s+from\b/i.test(s) && !/\bwhere\b/i.test(s)) {
      out.push({ rule: 'delete-no-where', severity: 'warn', message: 'DELETE without WHERE removes every row.' })
    }
  }

  // SELECT without a row limit (and not an aggregate/grouped query)
  if (
    stmts.some(
      (s) =>
        /^select\b/i.test(s) &&
        !/\blimit\b/i.test(s) &&
        !/\btop\b/i.test(s) &&
        !/\bcount\s*\(/i.test(s) &&
        !/\bgroup\s+by\b/i.test(s)
    )
  ) {
    out.push({
      rule: 'no-limit',
      severity: 'info',
      message: 'No LIMIT — this query can return a very large result set.'
    })
  }

  // Leading-wildcard LIKE
  if (/\blike\s+'%/i.test(clean)) {
    out.push({
      rule: 'leading-wildcard',
      severity: 'info',
      message: "A leading-wildcard LIKE ('%…') can't use an index."
    })
  }

  // Comma join without a join/where condition → possible Cartesian product
  for (const s of stmts) {
    const m = s.match(/\bfrom\s+([\s\S]+?)(\bwhere\b|\bgroup\b|\border\b|\blimit\b|$)/i)
    if (m && /,/.test(m[1]) && !/\bjoin\b/i.test(s) && !/\bwhere\b/i.test(s)) {
      out.push({
        rule: 'cartesian',
        severity: 'warn',
        message: 'Comma-joined tables without a join condition can produce a Cartesian product.'
      })
      break
    }
  }

  // de-duplicate by rule
  const seen = new Set<string>()
  return out.filter((l) => (seen.has(l.rule) ? false : (seen.add(l.rule), true)))
}
