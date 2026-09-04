/// <reference types="vite/client" />

declare module '*.less'

import type { BeanWiseApi } from '../../shared/api'

declare global {
  interface Window {
    beanwise: BeanWiseApi
  }
}

export {}