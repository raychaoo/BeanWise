import { describe, expect, it, vi } from 'vitest'
import {
  BEANCOUNT_LANGUAGE_ID,
  BEANCOUNT_TOKENIZER,
  registerBeancountLanguage
} from './beancount-language'

/** 注入式注册：运行时不需要真实 monaco，无需 vi.mock */
function fakeMonaco() {
  return {
    languages: {
      getLanguages: vi.fn(() => []),
      register: vi.fn(),
      setMonarchTokensProvider: vi.fn()
    },
    editor: { defineTheme: vi.fn() }
  } as never
}

describe('beancount 语言注册（M5）', () => {
  it('注册 language + monarch provider + beanwise 主题', () => {
    const monaco = fakeMonaco() as {
      languages: { getLanguages: ReturnType<typeof vi.fn>; register: ReturnType<typeof vi.fn>; setMonarchTokensProvider: ReturnType<typeof vi.fn> }
      editor: { defineTheme: ReturnType<typeof vi.fn> }
    }
    registerBeancountLanguage(monaco as never)
    expect(monaco.languages.register).toHaveBeenCalledWith({ id: BEANCOUNT_LANGUAGE_ID })
    expect(monaco.languages.setMonarchTokensProvider).toHaveBeenCalledWith(BEANCOUNT_LANGUAGE_ID, BEANCOUNT_TOKENIZER)
    expect(monaco.editor.defineTheme).toHaveBeenCalledWith('beanwise', expect.objectContaining({ base: 'vs', inherit: true }))
  })

  it('幂等：已注册则跳过', () => {
    const monaco = fakeMonaco() as {
      languages: { getLanguages: ReturnType<typeof vi.fn>; register: ReturnType<typeof vi.fn>; setMonarchTokensProvider: ReturnType<typeof vi.fn> }
      editor: { defineTheme: ReturnType<typeof vi.fn> }
    }
    monaco.languages.getLanguages.mockReturnValue([{ id: BEANCOUNT_LANGUAGE_ID }])
    registerBeancountLanguage(monaco as never)
    expect(monaco.languages.register).not.toHaveBeenCalled()
  })

  it('tokenizer 覆盖关键 token，且账户先于货币（顺序敏感）', () => {
    const root = BEANCOUNT_TOKENIZER.tokenizer.root as Array<[RegExp, string]>
    const names = root.map(([, action]) => action)
    for (const t of ['comment', 'keyword', 'number.date', 'type.flag', 'string', 'type.account', 'number', 'currency', 'tag', 'link']) {
      expect(names).toContain(t)
    }
    expect(names.indexOf('type.account')).toBeLessThan(names.indexOf('currency'))
  })
})
