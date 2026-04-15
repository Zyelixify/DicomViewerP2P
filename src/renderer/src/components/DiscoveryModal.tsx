import { useEffect, useState } from 'react'
import type { DiscoveredPeer } from '../../../shared/types'

function formatByteSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const precision = unitIndex >= 2 ? 1 : 0
  return `${value.toFixed(precision)} ${units[unitIndex]}`
}

type DiscoveryModalProps = {
  isOpen: boolean
  devices: DiscoveredPeer[]
  studies: Array<{
    studyInstanceUID: string
    label: string
    seriesCount: number
    instanceCount: number
    selected: boolean
  }>
  selectedPeerId: string | null
  transferProgress: {
    sentBytes: number
    totalBytes: number
    sentFiles: number
    totalFiles: number
    percent: number
    isComplete: boolean
    hasError: boolean
  } | null
  completionMessage: string | null
  isBusy: boolean
  errorMessage: string | null
  onToggleStudy: (studyInstanceUID: string) => void
  onClose: () => void
  onRefresh: () => void
  onSelectDevice: (peer: DiscoveredPeer) => void
}

export function DiscoveryModal({
  isOpen,
  devices,
  studies,
  selectedPeerId,
  transferProgress,
  completionMessage,
  isBusy,
  errorMessage,
  onToggleStudy,
  onClose,
  onRefresh,
  onSelectDevice
}: DiscoveryModalProps) {
  const [step, setStep] = useState<1 | 2>(1)
  const isCompletionState = Boolean(completionMessage)

  useEffect(() => {
    if (isOpen) {
      setStep(1)
    }
  }, [isOpen])

  useEffect(() => {
    if (isOpen && isCompletionState) {
      setStep(2)
    }
  }, [isCompletionState, isOpen])

  const selectedStudyCount = studies.filter((study) => study.selected).length

  if (!isOpen) {
    return null
  }

  return (
    <div className="discovery-modal-overlay" role="dialog" aria-modal="true" aria-label="Select receiving device">
      <section className="discovery-modal">
        <header>
          <h3>Send Studies</h3>
          <p className="muted">Step {step} of 2</p>
        </header>

        <div className="discovery-stepper" aria-hidden="true">
          <span className={step === 1 ? 'is-active' : ''}>1. Select studies</span>
          <span className={step === 2 ? 'is-active' : ''}>2. Select destination</span>
        </div>

        <div className="discovery-modal-actions">
          {step === 2 && !isCompletionState ? (
            <button className="secondary-button" disabled={isBusy} onClick={onRefresh}>
              Refresh
            </button>
          ) : null}
          <button className="secondary-button" disabled={isBusy && !isCompletionState} onClick={onClose}>
            Close
          </button>
        </div>

        {errorMessage ? <p className="error">{errorMessage}</p> : null}

        {step === 1 ? (
          <section className="discovery-step-content">
            <p className="muted">Select studies to include in transfer.</p>
            <div className="discovery-list-section">
              {studies.length === 0 ? (
                <p className="muted">No studies available to send.</p>
              ) : (
                <ul className="study-selection-list">
                  {studies.map((study) => (
                    <li key={study.studyInstanceUID}>
                      <label className="study-selection-item">
                        <input
                          type="checkbox"
                          checked={study.selected}
                          disabled={isBusy}
                          onChange={() => {
                            onToggleStudy(study.studyInstanceUID)
                          }}
                        />
                        <div>
                          <strong>{study.label}</strong>
                          <span>
                            {study.seriesCount} series · {study.instanceCount} instances
                          </span>
                        </div>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="discovery-modal-actions">
              <button
                className="primary-button"
                disabled={isBusy || selectedStudyCount === 0}
                onClick={() => {
                  setStep(2)
                }}
              >
                Continue ({selectedStudyCount})
              </button>
            </div>
          </section>
        ) : (
          <section className="discovery-step-content">
            <p className="muted">
              {isCompletionState
                ? 'Transfer finished successfully.'
                : 'Choose a destination device. Transfer starts as soon as you select one.'}
            </p>

            {isCompletionState ? (
              <section className="transfer-progress-panel transfer-progress-panel-complete" aria-live="polite">
                <div className="transfer-complete-check" aria-hidden="true">
                  ✓
                </div>
                <strong>Transfer complete</strong>
                <p className="muted">{completionMessage}</p>
                {transferProgress ? (
                  <p className="muted">
                    {transferProgress.sentFiles}/{transferProgress.totalFiles} files · {formatByteSize(transferProgress.totalBytes)}
                  </p>
                ) : null}
              </section>
            ) : null}

            {transferProgress && !isCompletionState ? (
              <section className="transfer-progress-panel" aria-live="polite">
                <div className="transfer-progress-topline">
                  <strong>
                    {transferProgress.hasError
                      ? 'Transfer error'
                      : transferProgress.isComplete
                        ? 'Transfer complete'
                        : 'Transfer in progress'}
                  </strong>
                  <span>{transferProgress.percent}%</span>
                </div>
                <progress max={transferProgress.totalBytes || 1} value={transferProgress.sentBytes} />
                <p className="muted">
                  {transferProgress.sentFiles}/{transferProgress.totalFiles} files · {formatByteSize(transferProgress.sentBytes)}/
                  {formatByteSize(transferProgress.totalBytes)}
                </p>
              </section>
            ) : null}

            {!isCompletionState ? (
              <div className="discovery-list-section">
                {devices.length === 0 ? (
                  <p className="muted">No receiving devices detected yet. Ask the other user to click Start Receiving.</p>
                ) : (
                  <ul className="device-list">
                    {devices.map((device) => {
                      const fallbackLabel = `Device ${device.peerId.slice(0, 8)}`
                      const label = device.displayName?.trim() || fallbackLabel
                      return (
                        <li key={device.peerId}>
                          <div>
                            <strong>{label}</strong>
                            <span>
                              {device.address}:{device.transferPort} · ID {device.peerId.slice(0, 8)}
                            </span>
                          </div>
                          <button
                            className="primary-button"
                            disabled={isBusy}
                            onClick={() => {
                              onSelectDevice(device)
                            }}
                          >
                            {selectedPeerId === device.peerId ? 'Sending…' : 'Send to This Device'}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            ) : null}

            {!isCompletionState ? (
              <div className="discovery-modal-actions">
                <button
                  className="secondary-button"
                  disabled={isBusy}
                  onClick={() => {
                    setStep(1)
                  }}
                >
                  Back
                </button>
              </div>
            ) : null}
          </section>
        )}
      </section>
    </div>
  )
}
