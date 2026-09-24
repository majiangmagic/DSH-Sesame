import type { SesameApi } from './index'

declare global {
  interface Window {
    sesame: SesameApi
  }
}

export {}
