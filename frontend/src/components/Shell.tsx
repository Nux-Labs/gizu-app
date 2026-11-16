import type { ReactNode } from 'react'

export default function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-ink">
      <div className="relative mx-auto flex h-full w-full max-w-[440px] flex-col lg:my-6 lg:h-[calc(100dvh-3rem)] lg:rounded-[40px] lg:border lg:border-white/10">
        <div className="scanlines noise relative flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden lg:rounded-[40px]">
          {children}
        </div>
      </div>
    </div>
  )
}
