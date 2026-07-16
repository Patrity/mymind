export type GraphNodeType = 'memory' | 'document' | 'image' | 'session' | 'project'

export interface GraphNode {
  type: GraphNodeType
  id: string
  label: string          // short display title
  preview?: string       // longer hover/detail snippet
  project: string | null // project slug
  projectId: string | null
  x: number; y: number; z: number
  degree: number
}

export type GraphEdgeKind = 'membership' | 'provenance' | 'ocr' | 'supersedes' | 'contradicts'
export interface GraphEdgeRef { type: GraphNodeType; id: string }
export interface GraphEdge { from: GraphEdgeRef; to: GraphEdgeRef; kind: GraphEdgeKind }

export interface GraphData { nodes: GraphNode[]; edges: GraphEdge[] }
export interface GraphNeighbor { type: GraphNodeType; id: string; label: string; score: number }
