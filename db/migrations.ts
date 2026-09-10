// db/migrations.ts — ordered migration registry (KIEO-002).
// To add a schema change: add `NNN-description.sql` under db/migrations/ and
// append an entry here with the next version number. Never edit an applied
// migration in place — write a new one.
import sql001 from './migrations/001-initial-schema.sql?raw'

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: '001-initial-schema', sql: sql001 }
]
