// Cycle 87: artifact DTOs shared by the service, the API and the UI.
export interface ArtifactDTO {
  id: string
  slug: string
  title: string
  description: string | null
  isPublic: boolean
  projectId: string | null
  conversationId: string | null
  currentVersion: number | null
  versionCount: number
  fileCount: number
  totalBytes: number
  url: string
  createdAt: string
  updatedAt: string
}

export interface ArtifactVersionDTO {
  id: string
  version: number
  entry: string
  fileCount: number
  totalBytes: number
  createdAt: string
  current: boolean
}

export interface ArtifactDetailDTO extends ArtifactDTO {
  versions: ArtifactVersionDTO[]
}
