import { contextBridge } from 'electron'
import { APP_NAME } from '../shared/app'
import type { BeanWiseApi } from '../shared/api'

const api: BeanWiseApi = {
  appName: APP_NAME
}

contextBridge.exposeInMainWorld('beanwise', api)
