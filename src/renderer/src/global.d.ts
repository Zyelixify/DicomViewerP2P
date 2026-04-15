import type { AppApi, TransferSessionState } from '../../shared/types'
import { TRANSFER_STATE_UPDATED_EVENT } from '../../shared/ipc'

declare global {
  interface Window {
    appApi: AppApi
  }

  interface WindowEventMap {
    [TRANSFER_STATE_UPDATED_EVENT]: CustomEvent<TransferSessionState>
  }
}

export {}
