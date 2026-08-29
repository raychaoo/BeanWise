import { describe, expect, it } from 'vitest'
import { basenamePath } from './path'

describe('basenamePath', () => {
  it('Windows 反斜杠路径取末段', () => {
    expect(basenamePath('C:\\a\\b')).toBe('b')
    expect(basenamePath('F:\\BeanWiseData\\test')).toBe('test')
  })

  it('POSIX 正斜杠路径取末段', () => {
    expect(basenamePath('/x/y')).toBe('y')
    expect(basenamePath('F:/BeanWiseData/test')).toBe('test')
  })

  it('无分隔符返回原值', () => {
    expect(basenamePath('name')).toBe('name')
  })

  it('末尾分隔符不产生空末段', () => {
    expect(basenamePath('C:\\a\\b\\')).toBe('b')
    expect(basenamePath('/x/y/')).toBe('y')
  })
})
