import { describe, it, expect } from 'vitest'
import { parseWebhook } from '../server/lib/channels/bluebubbles/parse'
import text from './fixtures/bluebubbles/text.json'
import photo from './fixtures/bluebubbles/photo.json'
import voice from './fixtures/bluebubbles/voice-memo.json'
import like from './fixtures/bluebubbles/tapback-like.json'
import dislike from './fixtures/bluebubbles/tapback-dislike.json'
import group from './fixtures/bluebubbles/group.json'
import fromMe from './fixtures/bluebubbles/from-me.json'
import updatedRead from './fixtures/bluebubbles/updated-read.json'

describe('parseWebhook', () => {
  it('text message', () => {
    const { type, event } = parseWebhook(text)
    expect(type).toBe('new-message')
    expect(event).toMatchObject({ kind: 'message', guid: 'A1B2-TEXT', chatGuid: 'iMessage;-;+15551234567', sender: '+15551234567', text: 'hey bridget', isGroup: false, isFromMe: false, attachments: [] })
  })
  it('photo carries its attachment', () => {
    const e = parseWebhook(photo).event as any
    expect(e.attachments).toEqual([{ guid: 'ATT-PHOTO', mime: 'image/heic', name: 'IMG_0001.HEIC' }])
  })
  it('voice memo carries the audio attachment', () => {
    const e = parseWebhook(voice).event as any
    expect(e.attachments[0]).toMatchObject({ mime: 'audio/x-caf', name: 'Audio Message.caf' })
  })
  it('tapbacks parse with the target guid stripped of its p:N/ prefix', () => {
    expect(parseWebhook(like).event).toMatchObject({ kind: 'tapback', tapback: 'like', targetGuid: 'PROMPT-GUID', removed: false })
    expect(parseWebhook(dislike).event).toMatchObject({ kind: 'tapback', tapback: 'dislike', targetGuid: 'PROMPT-GUID' })
  })
  it('group chats are flagged', () => expect((parseWebhook(group).event as any).isGroup).toBe(true))
  it('from-me is flagged', () => expect((parseWebhook(fromMe).event as any).isFromMe).toBe(true))
  it('an updated-message that is not a tapback yields no event', () => expect(parseWebhook(updatedRead).event).toBeNull())
  it('garbage never throws', () => {
    expect(parseWebhook(null).event).toBeNull()
    expect(parseWebhook({ type: 'new-message', data: { guid: 5 } }).event).toBeNull()
  })
})

describe('non-tapback associations (cycle 75 Task 7 ruling)', () => {
  it('an iOS 18 emoji reaction (2006) parses as a message flagged with its associated guid', async () => {
    const emoji = (await import('./fixtures/bluebubbles/emoji-reaction.json')).default
    const e = parseWebhook(emoji).event as any
    expect(e).toMatchObject({ kind: 'message', guid: 'A1B2-EMOJI', associatedMessageGuid: 'PROMPT-GUID' })
  })
  it('a plain message carries no associatedMessageGuid', () => {
    expect((parseWebhook(text).event as any).associatedMessageGuid).toBeUndefined()
  })
})
