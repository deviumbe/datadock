import { format, type SqlLanguage } from 'sql-formatter'
import type { DriverType } from '@shared/types'

const LANGUAGE: Record<DriverType, SqlLanguage | null> = {
  postgres: 'postgresql',
  mysql: 'mysql',
  sqlite: 'sqlite',
  mssql: 'transactsql',
  cockroachdb: 'postgresql', // pg-wire compatible
  timescaledb: 'postgresql', // pg-wire compatible
  redshift: 'redshift',
  mongodb: null, // document store, not SQL
  redis: null, // key/value, raw commands not SQL
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
