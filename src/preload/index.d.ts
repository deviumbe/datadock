import type { DataDockApi } from './index'

declare global {
  interface Window {
    api: DataDockApi
  }
}

export {}
