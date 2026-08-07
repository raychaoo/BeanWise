import { contextBridge } from 'electron'
import type { BeanWiseApi } from '../shared/api'

const api: BeanWiseApi = {
  appName: 'BeanWise'
}

contextBridge.exposeInMainWorld('beanwise', api)
