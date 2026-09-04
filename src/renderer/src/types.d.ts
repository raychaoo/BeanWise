import type { BeanWiseApi } from '../../shared/api'

declare module '*.less'

declare global {
  interface Window {
    beanwise: BeanWiseApi
  }
}