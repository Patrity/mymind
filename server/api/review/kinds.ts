// The review-kind handlers live in server/lib/review/kinds.ts (cycle 80: they move into
// @mymind/core and must not depend on h3). This module keeps the historical HTTP surface for
// its importers: the same handler maps, with a lib ReviewKindError re-thrown as createError
// carrying the identical statusCode/message/data. Anything else passes through untouched.
import type { ReviewItem } from '../../db/schema'
import {
  approveHandlers as libApproveHandlers,
  rejectHandlers as libRejectHandlers,
  ReviewKindError,
  type HandlerResult
} from '../../lib/review/kinds'

export { SELF_IMPROVEMENT_CONFLICT, type HandlerResult } from '../../lib/review/kinds'

type Handler = (item: ReviewItem) => Promise<HandlerResult | void>

function toHttp(handler: Handler): Handler {
  return async (item) => {
    try {
      return await handler(item)
    } catch (err) {
      if (err instanceof ReviewKindError) {
        throw createError({ statusCode: err.statusCode, message: err.message, data: err.data })
      }
      throw err
    }
  }
}

function wrapAll(handlers: Record<string, Handler>): Record<string, Handler> {
  return Object.fromEntries(Object.entries(handlers).map(([kind, h]) => [kind, toHttp(h)]))
}

export const approveHandlers: Record<string, Handler> = wrapAll(libApproveHandlers)
export const rejectHandlers: Record<string, Handler> = wrapAll(libRejectHandlers)
