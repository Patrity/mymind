/**
 * Pure scheduling helpers over a validated JobSpec. Croner does the timezone/DST-aware cron
 * math; `every`/`at` are plain arithmetic; `event` jobs never have a next run.
 */
import { Cron } from 'croner'
import type { JobSpec } from './parse'

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function everyToMs(expr: string): number {
  const m = /^(\d+)(m|h)$/.exec(expr)
  if (!m) throw new Error(`invalid every expression: ${expr}`)
  const n = Number(m[1])
  return m[2] === 'h' ? n * 60 * 60_000 : n * 60_000
}

export function nextRunAt(spec: JobSpec, from: Date): Date | null {
  switch (spec.trigger.kind) {
    case 'cron': {
      const cron = new Cron(spec.trigger.expr, { timezone: spec.timezone, paused: true })
      return cron.nextRun(from)
    }
    case 'every': {
      const ms = everyToMs(spec.trigger.expr)
      return new Date(from.getTime() + ms)
    }
    case 'at': {
      const t = Date.parse(spec.trigger.expr)
      return t > from.getTime() ? new Date(t) : null
    }
    case 'event':
      return null
  }
}

export function nextFireTimes(spec: JobSpec, n: number, from: Date = new Date()): Date[] {
  switch (spec.trigger.kind) {
    case 'cron': {
      const cron = new Cron(spec.trigger.expr, { timezone: spec.timezone, paused: true })
      return cron.nextRuns(n, from)
    }
    case 'every': {
      const ms = everyToMs(spec.trigger.expr)
      const out: Date[] = []
      let t = from.getTime()
      for (let i = 0; i < n; i++) {
        t += ms
        out.push(new Date(t))
      }
      return out
    }
    case 'at': {
      const next = nextRunAt(spec, from)
      return next ? [next] : []
    }
    case 'event':
      return []
  }
}

function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return `cron ${expr}`
  const minute = parts[0] ?? ''
  const hour = parts[1] ?? ''
  const dom = parts[2] ?? ''
  const month = parts[3] ?? ''
  const dow = parts[4] ?? ''
  if (dom !== '*' || month !== '*') return `cron ${expr}`
  if (!/^\d+$/.test(hour) || !/^\d+$/.test(minute)) return `cron ${expr}`
  const time = `${Number(hour)}:${minute.padStart(2, '0')}`
  if (dow === '*') return `daily at ${time}`
  if (dow === '1-5') return `weekdays at ${time}`
  if (/^[0-6]$/.test(dow)) return `${DAY_NAMES[Number(dow)] ?? ''}s at ${time}`
  return `cron ${expr}`
}

function describeEvery(expr: string): string {
  const m = /^(\d+)(m|h)$/.exec(expr)
  if (!m) return `every ${expr}`
  const n = Number(m[1])
  const unit = m[2] === 'h' ? 'hour' : 'minute'
  return `every ${n} ${unit}${n === 1 ? '' : 's'}`
}

function describeAt(expr: string, timezone: string): string {
  const t = Date.parse(expr)
  if (Number.isNaN(t)) return `at ${expr}`
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(t))
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return `once on ${get('month')} ${get('day')}, ${get('hour')}:${get('minute')}`
}

function describeEvent(name: string): string {
  if (name === 'cc.session_end') return 'when a Claude Code session ends'
  if (name === 'task.due') return 'when a task is due'
  return `event ${name}`
}

export function describeTrigger(spec: JobSpec): string {
  switch (spec.trigger.kind) {
    case 'cron': return describeCron(spec.trigger.expr)
    case 'every': return describeEvery(spec.trigger.expr)
    case 'at': return describeAt(spec.trigger.expr, spec.timezone)
    case 'event': return describeEvent(spec.trigger.expr)
  }
}

export function inActiveHours(spec: JobSpec, at: Date): boolean {
  if (!spec.activeHours) return true
  const { start, end } = spec.activeHours
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: spec.timezone
  }).formatToParts(at)
  const hh = parts.find(p => p.type === 'hour')?.value ?? '00'
  const mm = parts.find(p => p.type === 'minute')?.value ?? '00'
  const current = `${hh}:${mm}`
  if (start <= end) return current >= start && current < end
  return current >= start || current < end
}
