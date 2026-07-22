import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ViewErrorBoundaryProps {
  children: ReactNode
}

interface ViewErrorBoundaryState {
  error: string
}

export default class ViewErrorBoundary extends Component<
  ViewErrorBoundaryProps,
  ViewErrorBoundaryState
> {
  state: ViewErrorBoundaryState = { error: '' }

  static getDerivedStateFromError(error: unknown): ViewErrorBoundaryState {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('View failed to render', error, info)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center rounded-2xl bg-canvas p-6 text-center shadow-card ring-1 ring-black/5">
          <div className="max-w-lg text-[12px] text-red-700">{this.state.error}</div>
        </div>
      )
    }
    return this.props.children
  }
}
