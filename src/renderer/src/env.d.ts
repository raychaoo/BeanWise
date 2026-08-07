/// <reference types="vite/client" />
import type { BeanWiseApi } from '../../shared/api'

declare global {
  interface Window {
    beanwise: BeanWiseApi
  }
}

export {}
