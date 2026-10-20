import { customType } from 'drizzle-orm/pg-core'

// Postgres full-text search vector. Only ever written by the database (every column using it is
// GENERATED ALWAYS AS ... STORED), so the driver value is opaque text we never parse.
export const tsvector = (columnName = 'tsv') =>
  customType<{ data: string, driverData: string }>({
    dataType() { return 'tsvector' }
  })(columnName)
