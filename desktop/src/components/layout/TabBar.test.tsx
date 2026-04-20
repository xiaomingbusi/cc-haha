import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

const startDraggingMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const getCurrentWindowMock = vi.hoisted(() => vi.fn(() => ({
  startDragging: startDraggingMock,
})))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: getCurrentWindowMock,
}))

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => {
    const translations: Record<string, string> = {
      'tabs.close': 'Close',
      'tabs.closeOthers': 'Close Others',
      'tabs.closeLeft': 'Close Left',
      'tabs.closeRight': 'Close Right',
      'tabs.closeAll': 'Close All',
      'tabs.closeConfirmTitle': 'Session Running',
      'tabs.closeConfirmMessage': 'Still running',
      'tabs.closeConfirmKeep': 'Keep Running',
      'tabs.closeConfirmStop': 'Stop & Close',
      'common.cancel': 'Cancel',
    }

    return translations[key] ?? key
  },
}))

vi.mock('./WindowControls', () => ({
  WindowControls: () => <div data-testid="window-controls" />,
  showWindowControls: true,
}))

describe('TabBar', () => {
  beforeEach(() => {
    class ResizeObserverMock {
      constructor(_callback: ResizeObserverCallback) {}

      observe(_target: Element) {}

      disconnect() {}
      unobserve() {}
    }

    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: ResizeObserverMock,
    })

    Object.defineProperty(window, '__TAURI__', {
      configurable: true,
      value: {},
    })

    startDraggingMock.mockClear()
    getCurrentWindowMock.mockClear()
    vi.resetModules()
  })

  afterEach(async () => {
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({ tabs: [], activeTabId: null })
    useChatStore.setState({
      sessions: {},
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    delete (window as typeof window & { __TAURI__?: unknown }).__TAURI__
  })

  it('keeps the overflow button flush against window controls on Windows', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Untitled Session', type: 'session', status: 'idle' },
        { sessionId: 'tab-2', title: 'Settings', type: 'settings', status: 'idle' },
        { sessionId: 'tab-3', title: 'hello', type: 'session', status: 'idle' },
        { sessionId: 'tab-4', title: 'overflow', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    const scrollRegion = screen.getByTestId('tab-bar').querySelector('.overflow-x-hidden')
    expect(scrollRegion).toBeInTheDocument()

    Object.defineProperty(scrollRegion!, 'clientWidth', {
      configurable: true,
      get: () => 240,
    })
    Object.defineProperty(scrollRegion!, 'scrollWidth', {
      configurable: true,
      get: () => 720,
    })
    Object.defineProperty(scrollRegion!, 'scrollLeft', {
      configurable: true,
      get: () => 0,
    })
    Object.defineProperty(scrollRegion!, 'scrollBy', {
      configurable: true,
      value: vi.fn(),
    })

    act(() => {
      fireEvent.scroll(scrollRegion!)
    })

    await waitFor(() => {
      expect(screen.getByTestId('window-controls')).toBeInTheDocument()
      expect(screen.getByText('chevron_right').closest('button')).toBeInTheDocument()
    })

    const rightButton = screen.getByText('chevron_right').closest('button')
    expect(rightButton?.nextElementSibling).toBe(screen.getByTestId('window-controls'))
  })

  it('marks the tab bar as a native drag region', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Untitled Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    expect(screen.getByTestId('tab-bar')).toHaveAttribute('data-tauri-drag-region')
  })

  it('starts dragging when clicking the empty tab-bar gutter', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Untitled Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    await waitFor(() => {
      expect(getCurrentWindowMock).toHaveBeenCalled()
    })

    const scrollRegion = screen.getByTestId('tab-bar').querySelector('.overflow-x-hidden')
    expect(scrollRegion).toBeInTheDocument()

    fireEvent.mouseDown(scrollRegion!)

    await waitFor(() => {
      expect(startDraggingMock).toHaveBeenCalledTimes(1)
    })
  })

  it('does not start dragging when clicking a tab', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Untitled Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    await waitFor(() => {
      expect(getCurrentWindowMock).toHaveBeenCalled()
    })

    fireEvent.mouseDown(screen.getByText('Untitled Session'))

    expect(startDraggingMock).not.toHaveBeenCalled()
  })
})
