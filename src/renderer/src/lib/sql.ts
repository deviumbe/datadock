import { format, type SqlLanguage } from 'sql-formatter'
import type { DriverType } from '@shared/types'

const LANGUAGE: Record<DriverType, SqlLanguage | null> = {
  postgres: 'postgresql',
  mysql: 'mysql',
  sqlite: 'sqlite',
  mssql: 'transactsql',
  influxdb: null // Flux, not SQL
}

/** Pretty-print SQL for the given engine. Returns input unchanged on failure. */
export function formatSql(sql: string, driver: DriverType): string {
  const language = LANGUAGE[driver]
  if (!language || !sql.trim()) return sql
  try {
    return format(sql, { language, keywordCase: 'upper' })
  } catch {
    return sql
  }
}
