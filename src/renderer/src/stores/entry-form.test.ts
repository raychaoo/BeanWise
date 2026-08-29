import { beforeEach, describe, expect, it } from 'vitest'
import { useEntryFormStore } from './entry-form'

describe('useEntryFormStore', () => {
  beforeEach(() => {
    useEntryFormStore.getState().setDirty(false)
  })

  it('初始 dirty=false', () => {
    expect(useEntryFormStore.getState().dirty).toBe(false)
  })

  it('setDirty(true) → true', () => {
    useEntryFormStore.getState().setDirty(true)
    expect(useEntryFormStore.getState().dirty).toBe(true)
  })

  it('setDirty(false) → false', () => {
    useEntryFormStore.getState().setDirty(true)
    useEntryFormStore.getState().setDirty(false)
    expect(useEntryFormStore.getState().dirty).toBe(false)
  })
})
