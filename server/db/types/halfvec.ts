import { customType } from 'drizzle-orm/pg-core'

// Stored as pgvector halfvec(N). Read/written as number[]. Unused values stay null in cycle 1.
export const halfvec = (dimensions: number, columnName = 'embedding') =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `halfvec(${dimensions})`
    },
    toDriver(value: number[]): string {
      return `[${value.join(',')}]`
    },
    fromDriver(value: string): number[] {
      return value.slice(1, -1).split(',').map(Number)
    }
  })(columnName)
