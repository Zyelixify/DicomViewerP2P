import type { WorkflowMode } from '../../../shared/types'

export type AppScreen = 'pick' | 'series' | 'viewer'

export type WorkflowPhase = 'idle' | 'scanning' | 'series-ready' | 'loading-series' | 'viewer-ready' | 'error'

export type SeriesViewMode = 'local' | 'received'

export type StudyTelemetryContext = {
  workflowMode: WorkflowMode
  studyId: string
}

export type StudyContextByWorkflow = {
  local: StudyTelemetryContext | null
  p2p_receive: StudyTelemetryContext | null
}
