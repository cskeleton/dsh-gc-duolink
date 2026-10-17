// @vitest-environment jsdom
/** Copy the clicked row ID, including clipboard restrictions and retry behavior. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CopySessionIdMenu } from '../src/client/CopySessionIdMenu.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function fixture(chinese = false) {
  const close = vi.fn()
  render(<CopySessionIdMenu sessionId={'clicked-session-full-id' as SessionId}
    useMenuOpenState={() => [true, close]} t={key => (chinese ? zh : en)[key]} />)
  return { close, button: screen.getByRole('menuitem') }
}

async function click(button: HTMLElement) {
  await act(async () => { fireEvent.click(button) })
}

describe('Copy Session ID menu', () => {
  it('copies the full clicked row ID without link state and closes only after success', async () => {
    const pending = Promise.withResolvers<void>()
    const writeText = vi.fn(() => pending.promise)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const f = fixture(true)
    fireEvent.click(f.button)
    expect(f.button.textContent).toBe('复制会话 ID')
    expect(writeText).toHaveBeenCalledWith('clicked-session-full-id')
    expect(f.close).not.toHaveBeenCalled()
    expect(f.button.hasAttribute('disabled')).toBe(true)
    await act(async () => { pending.resolve() })
    expect(f.close).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['missing', 'denied', 'throws'])('falls back when Clipboard API is %s, cleans up and restores focus', async mode => {
    const writeText = mode === 'throws' ? vi.fn(() => { throw new Error('denied') })
      : vi.fn(async () => { throw new Error('denied') })
    vi.stubGlobal('navigator', mode === 'missing' ? {} : { clipboard: { writeText } })
    const fallback = vi.fn((command: string) => {
      expect(command).toBe('copy')
      expect((document.activeElement as HTMLTextAreaElement).value).toBe('clicked-session-full-id')
      return true
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
    vi.spyOn(document, 'execCommand').mockImplementation(fallback)
    render(<input aria-label="previous focus" />)
    const previous = screen.getByRole('textbox')
    const f = fixture()
    previous.focus()
    await click(f.button)
    expect(fallback).toHaveBeenCalledOnce()
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.activeElement).toBe(previous)
    expect(f.close).toHaveBeenCalledWith(false)
  })

  it('keeps the menu open with an error when fallback fails and allows retry', async () => {
    vi.stubGlobal('navigator', {})
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
    const fallback = vi.spyOn(document, 'execCommand').mockReturnValue(false)
    const f = fixture()
    await click(f.button)
    expect(screen.getByRole('alert').textContent).toBe(en['row.copy.error'])
    expect(f.close).not.toHaveBeenCalled()
    expect(document.querySelector('textarea')).toBeNull()
    fallback.mockReturnValue(true)
    await click(f.button)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(f.close).toHaveBeenCalledOnce()
  })

  it('cleans up after a throwing fallback and reports an unavailable clipboard', async () => {
    vi.stubGlobal('navigator', {})
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
    const fallback = vi.spyOn(document, 'execCommand').mockImplementation(() => { throw new Error('blocked') })
    const f = fixture()
    await click(f.button)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(document.querySelector('textarea')).toBeNull()
    expect(f.close).not.toHaveBeenCalled()
    fallback.mockRestore()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: undefined })
    await click(f.button)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(document.querySelector('textarea')).toBeNull()
    expect(f.close).not.toHaveBeenCalled()
  })
})
