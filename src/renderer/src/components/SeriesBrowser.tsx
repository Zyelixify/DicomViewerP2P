import { useMemo } from 'react'
import type { SeriesMetadata } from '../../../shared/types'

type SeriesBrowserHeaderAction = {
  id: string
  label: string
  variant?: 'primary' | 'secondary'
  disabled?: boolean
  onClick: () => void
}

type SeriesBrowserProps = {
  title: string
  rootFolder: string
  scannedFileCount: number
  dicomFileCount: number
  expectedDicomFileCount?: number
  elapsedMs: number
  studyCount: number
  seriesEntries: Array<{
    studyInstanceUID: string
    patientName: string
    series: SeriesMetadata
  }>
  thumbnails: Record<string, string>
  isPreparingThumbnails: boolean
  preparedThumbnailsCount: number
  totalSeriesCount: number
  activeSeriesUID: string | null
  isSeriesLoading: boolean
  statusMessage?: string
  headerActions?: SeriesBrowserHeaderAction[]
  onLoadSeries: (series: SeriesMetadata) => void
  onOpenFolder: (folderPath: string) => void | Promise<void>
  onBack: () => void
}

export function SeriesBrowser({
  title,
  rootFolder,
  scannedFileCount,
  dicomFileCount,
  expectedDicomFileCount,
  elapsedMs,
  studyCount,
  seriesEntries,
  thumbnails,
  isPreparingThumbnails,
  preparedThumbnailsCount,
  totalSeriesCount,
  activeSeriesUID,
  isSeriesLoading,
  statusMessage,
  headerActions,
  onLoadSeries,
  onOpenFolder,
  onBack
}: SeriesBrowserProps) {
  const sortText = (value?: string) => (value ?? '').trim().toLowerCase()

  const compactRootFolder = useMemo(() => {
    if (rootFolder.length <= 56) {
      return rootFolder
    }

    return `${rootFolder.slice(0, 28)}…${rootFolder.slice(-22)}`
  }, [rootFolder])

  const studies = useMemo(() => {
    const map = new Map<
      string,
      {
        studyInstanceUID: string
        patientName: string
        rows: Array<{ series: SeriesMetadata }>
      }
    >()

    for (const entry of seriesEntries) {
      const existing = map.get(entry.studyInstanceUID)
      if (existing) {
        existing.rows.push({ series: entry.series })
        continue
      }

      map.set(entry.studyInstanceUID, {
        studyInstanceUID: entry.studyInstanceUID,
        patientName: entry.patientName,
        rows: [{ series: entry.series }]
      })
    }

    return [...map.values()]
      .map((study) => ({
        ...study,
        rows: [...study.rows].sort((a, b) => {
          const aSeries = a.series
          const bSeries = b.series

          const byDescription = sortText(aSeries.seriesDescription).localeCompare(sortText(bSeries.seriesDescription))
          if (byDescription !== 0) {
            return byDescription
          }

          const byModality = sortText(aSeries.modality).localeCompare(sortText(bSeries.modality))
          if (byModality !== 0) {
            return byModality
          }

          return aSeries.seriesInstanceUID.localeCompare(bSeries.seriesInstanceUID)
        })
      }))
      .sort((a, b) => {
        const byPatient = sortText(a.patientName).localeCompare(sortText(b.patientName))
        if (byPatient !== 0) {
          return byPatient
        }

        return a.studyInstanceUID.localeCompare(b.studyInstanceUID)
      })
  }, [seriesEntries])

  const isProgressiveReceiveView =
    typeof expectedDicomFileCount === 'number' && expectedDicomFileCount > 0 && expectedDicomFileCount !== dicomFileCount

  const dicomCountLabel = isProgressiveReceiveView ? `${dicomFileCount}/${expectedDicomFileCount} available` : `${dicomFileCount}`

  return (
    <section className="series-screen">
      <header className="screen-header">
        <div className="screen-header-title-row">
          <button className="icon-button" aria-label="Back" onClick={onBack}>
            ←
          </button>
          <h2>{title}</h2>
        </div>

        {headerActions && headerActions.length > 0 ? (
          <div className="screen-header-actions">
            {headerActions.map((action) => (
              <button
                key={action.id}
                className={action.variant === 'secondary' ? 'secondary-button' : 'primary-button'}
                disabled={action.disabled}
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      {statusMessage ? <p className="muted">{statusMessage}</p> : null}

      <section className="scan-meta-grid">
        <article className="scan-meta-folder">
          <span>Folder</span>
          <strong>
            <a
              href="#"
              className="text-link"
              title={rootFolder}
              onClick={(event) => {
                event.preventDefault()
                void onOpenFolder(rootFolder)
              }}
            >
              {compactRootFolder}
            </a>
          </strong>
        </article>
        <article>
          <span>Studies</span>
          <strong>{studyCount}</strong>
        </article>
        <article>
          <span>Series</span>
          <strong>{seriesEntries.length}</strong>
        </article>
        <article>
          <span>DICOM files</span>
          <strong>{dicomCountLabel}</strong>
        </article>
        <article>
          <span>Scan time</span>
          <strong>{elapsedMs} ms ({scannedFileCount} files checked)</strong>
        </article>
      </section>

      {isPreparingThumbnails ? (
        <p className="muted">Preparing previews… {preparedThumbnailsCount}/{totalSeriesCount}</p>
      ) : null}

      {seriesEntries.length === 0 ? (
        <section className="series-empty-state">
          <h3>No viewable series found</h3>
          <p>
            {dicomFileCount > 0
              ? 'DICOM files were detected, but no image series could be prepared for viewing.'
              : isProgressiveReceiveView
                ? 'Incoming files are expected, but no series is viewable yet.'
                : 'No DICOM files were found in the selected folder.'}
          </p>
        </section>
      ) : null}

      <section className="study-group-list">
        {studies.map((study) => (
          <details key={study.studyInstanceUID} className="study-group" open>
            <summary className="study-group-summary">
              <span>{study.patientName || 'Unknown Patient'}</span>
              <span>{study.rows.length} series</span>
            </summary>

            <div className="study-group-series">
              <table className="series-table" role="grid">
                <thead>
                  <tr>
                    <th>Preview</th>
                    <th>Series</th>
                    <th>Instances</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {study.rows.map(({ series }) => {
                    const isActive = activeSeriesUID === series.seriesInstanceUID
                    const thumbnail = thumbnails[series.seriesInstanceUID]
                    const availableInstanceCount = series.availableInstanceCount ?? series.instances.length
                    const expectedInstanceCount = series.expectedInstanceCount ?? series.instances.length
                    const hasReceiveProgress = typeof series.expectedInstanceCount === 'number'
                    const isOpenable = series.instances.length > 0
                    const progressStatusLabel =
                      series.receiveProgressStatus === 'complete'
                        ? 'Complete'
                        : series.receiveProgressStatus === 'partial'
                          ? 'Partial'
                          : series.receiveProgressStatus === 'failed'
                            ? 'Failed'
                            : series.receiveProgressStatus === 'receiving'
                              ? 'Receiving'
                              : null

                    return (
                      <tr key={series.seriesInstanceUID} className={isActive ? 'series-table-row-active' : ''}>
                        <td>
                          <div className="series-table-thumb-wrap">
                            {thumbnail ? (
                              <img src={thumbnail} alt="First frame preview" className="series-table-thumb" />
                            ) : (
                              <div className="series-thumb-placeholder">No preview</div>
                            )}
                          </div>
                        </td>
                        <td>
                          <div className="series-row-meta">
                            <strong>
                              {series.modality || 'UNK'} · {series.seriesDescription || 'No description'}
                            </strong>
                            {hasReceiveProgress ? (
                              <div className="series-row-status">
                                {progressStatusLabel ? (
                                  <span
                                    className={`series-progress-badge ${
                                      series.receiveProgressStatus ? `is-${series.receiveProgressStatus}` : ''
                                    }`}
                                  >
                                    {progressStatusLabel}
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </td>
                        <td>{hasReceiveProgress ? `${availableInstanceCount}/${expectedInstanceCount}` : series.instances.length}</td>
                        <td>
                          <button
                            className="secondary-button"
                            disabled={isSeriesLoading || !isOpenable}
                            onClick={() => {
                              onLoadSeries(series)
                            }}
                          >
                            {!isOpenable
                              ? 'Waiting for images'
                              : isSeriesLoading && isActive
                                ? 'Opening viewer…'
                                : 'Open Viewer'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </details>
        ))}
      </section>
    </section>
  )
}
