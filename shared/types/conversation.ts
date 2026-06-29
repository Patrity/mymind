export interface AttachmentRef {
  id: string
  kind: 'image' | 'file'
  mime: string
  name?: string
}

export interface ConversationMessageDTO {
  id: string
  role: 'user' | 'assistant'
  content: string
  modality: 'voice' | 'text'
  toolCalls: { name: string; summary: string; undoToken?: string }[] | null
  attachments: AttachmentRef[] | null
  createdAt: string
}
export interface ConversationDTO {
  id: string
  title: string | null
  projectId: string | null
  messageCount: number
  lastMessageAt: string | null
  createdAt: string
}
export interface ConversationListItem extends ConversationDTO {
  snippet: string | null   // first/last message preview for the list/slideover
}
