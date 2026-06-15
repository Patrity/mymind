export interface ApiTokenDTO {
  id: string
  name: string
  lastFour: string | null
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}
