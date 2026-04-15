import type { WorkflowPhase } from '../types/ui'

type WorkflowStatusRailProps = {
  phase: WorkflowPhase
  message: string
  elapsedMs?: number
  progress?: { loaded: number; total: number } | null
}

const PHASE_LABEL: Record<WorkflowPhase, string> = {
  idle: 'Idle',
  scanning: 'Scanning Folder',
  'series-ready': 'Series Ready',
  'loading-series': 'Loading Series',
  'viewer-ready': 'Viewer Ready',
  error: 'Attention Required'
}

export function WorkflowStatusRail({ phase, message, elapsedMs, progress }: WorkflowStatusRailProps) {
  return (
    <section className={`workflow-rail workflow-${phase}`} aria-live="polite">
      <div className="workflow-rail-header">
        <strong>{PHASE_LABEL[phase]}</strong>
        {typeof elapsedMs === 'number' ? <span>{elapsedMs} ms</span> : null}
      </div>
      <p>{message}</p>
      {progress ? (
        <div className="workflow-progress">
          <progress value={progress.loaded} max={Math.max(1, progress.total)} />
          <span>
            {progress.loaded}/{progress.total}
          </span>
        </div>
      ) : null}
    </section>
  )
}
