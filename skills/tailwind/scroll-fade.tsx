// Dynamic scroll fade component using CSS mask-image.
// Fades content at scroll edges. Only shows fade when there's content to scroll to.
// Uses useSyncExternalStore for tear-free reads with stable callbacks.
//
// Props:
//   top     — enable top fade (default true)
//   bottom  — enable bottom fade (default true)
//   className — passed to the scroll container
//
// Usage:
//   <ScrollFade className="h-64">           {/* both edges */}
//   <ScrollFade className="h-64" top={false}> {/* bottom only */}
//   <ScrollFade className="h-64" bottom={false}> {/* top only */}

import { useRef, useSyncExternalStore, useCallback } from 'react'

export function useScrollFade(
  ref: React.RefObject<HTMLElement | null>,
  { top = true, bottom = true }: { top?: boolean; bottom?: boolean } = {},
) {
  const subscribe = useCallback(
    (notify: () => void) => {
      const el = ref.current
      if (!el) return () => {}
      el.addEventListener('scroll', notify, { passive: true })
      // ResizeObserver catches dynamic content changes (lazy load, accordions)
      // that make the container scrollable without any scroll event firing
      const observer = new ResizeObserver(notify)
      observer.observe(el)
      return () => {
        el.removeEventListener('scroll', notify)
        observer.disconnect()
      }
    },
    [ref],
  )

  const getSnapshot = useCallback(() => {
    const el = ref.current
    if (!el) return 'none'
    const showTop = top && el.scrollTop > 2
    const showBottom = bottom && el.scrollTop + el.clientHeight < el.scrollHeight - 2
    return showTop && showBottom
      ? 'linear-gradient(to bottom, transparent, black 48px, black calc(100% - 48px), transparent)'
      : showTop
        ? 'linear-gradient(to bottom, transparent, black 48px)'
        : showBottom
          ? 'linear-gradient(to bottom, black calc(100% - 48px), transparent)'
          : 'none'
  }, [ref, top, bottom])

  return useSyncExternalStore(subscribe, getSnapshot, () => 'none')
}

export function ScrollFade({
  children,
  className = '',
  top = true,
  bottom = true,
}: {
  children: React.ReactNode
  className?: string
  top?: boolean
  bottom?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const maskImage = useScrollFade(ref, { top, bottom })

  return (
    <div
      ref={ref}
      style={{ maskImage, WebkitMaskImage: maskImage }}
      className={`overflow-y-auto ${className}`}
    >
      {children}
    </div>
  )
}
