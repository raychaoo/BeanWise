import { describe, expect, it } from 'vitest'
import { APP_NAME } from './app'

describe('APP_NAME', () => {
  it('为应用名称 BeanWise', () => {
    expect(APP_NAME).toBe('BeanWise')
  })
})
