/**
 * Shared UI primitives.
 *
 * The first version of this app put every control on screen at once at the same visual
 * weight, which made a fairly simple tool look unusable. These primitives exist to give
 * the interface a hierarchy: one loud thing per view, everything else quiet until it is
 * relevant.
 */

import { useEffect, useId, useRef, useState } from 'react'

import { IconChevron } from './icons'

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet'
type Size = 'sm' | 'md'

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-slate-900 text-white hover:bg-slate-800 active:bg-slate-950 shadow-sm disabled:bg-slate-300',
  secondary:
    'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 hover:border-slate-400 active:bg-slate-100',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200',
  quiet: 'text-slate-500 hover:bg-slate-100 hover:text-slate-800',
  danger: 'text-red-600 hover:bg-red-50 active:bg-red-100',
}

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2 text-xs gap-1.5 rounded-md',
  md: 'h-9 px-3 text-sm gap-2 rounded-lg',
}

export function Button({
  variant = 'secondary',
  size = 'sm',
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${SIZES[size]} ${VARIANTS[variant]} ${className}`}
    />
  )
}

/**
 * Square icon-only button. Always carries a `label`, which becomes both the tooltip and
 * the accessible name — an icon with neither is a guessing game.
 */
export function IconButton({
  label,
  active = false,
  size = 'sm',
  variant = 'ghost',
  className = '',
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  active?: boolean
  size?: Size
  variant?: Variant
}) {
  const box = size === 'sm' ? 'h-7 w-7 rounded-md' : 'h-9 w-9 rounded-lg'
  return (
    <button
      {...rest}
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      className={`inline-flex shrink-0 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${box} ${
        active ? 'bg-slate-900 text-white hover:bg-slate-800' : VARIANTS[variant]
      } ${className}`}
    >
      {children}
    </button>
  )
}

/** A tool: icon over a small label, so the toolbar reads without hovering. */
export function ToolButton({
  label,
  hint,
  active,
  icon,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  hint: string
  active: boolean
  icon: React.ReactNode
}) {
  return (
    <button
      {...rest}
      title={hint}
      aria-pressed={active}
      className={`flex h-12 w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg transition-colors ${
        active
          ? 'bg-slate-900 text-white'
          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
      }`}
    >
      {icon}
      <span className="text-[10px] font-medium leading-none">{label}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Segmented control
// ---------------------------------------------------------------------------

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string; icon?: React.ReactNode; hint?: string }[]
}) {
  return (
    <div className="inline-flex rounded-lg bg-slate-100 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          title={o.hint}
          aria-pressed={value === o.value}
          className={`inline-flex items-center gap-1.5 rounded-[7px] px-3 py-1.5 text-xs font-medium transition-colors ${
            value === o.value
              ? 'bg-white text-slate-900 shadow-sm'
              : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------

export function Popover({
  trigger,
  children,
  align = 'left',
  width = 'w-64',
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => React.ReactNode
  children: React.ReactNode | ((close: () => void) => React.ReactNode)
  align?: 'left' | 'right'
  width?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <div
          className={`absolute z-40 mt-1.5 ${align === 'right' ? 'right-0' : 'left-0'} ${width} rounded-xl border border-slate-200 bg-white p-3 shadow-lg`}
        >
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panel furniture
// ---------------------------------------------------------------------------

/**
 * A section or field heading.
 *
 * Was 10px monospace, uppercase, wide-tracked and slate-400 -- six choices that
 * each cost legibility, and together made a panel of settings genuinely hard to
 * scan. Sentence case at 12px in a darker grey reads at a glance and lets a
 * label say "Crossing gap (across)" instead of "CROSSING GAP — HEIGHT".
 */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="block text-[12px] font-semibold text-slate-600">{children}</span>
  )
}

/** Collapsible section. Secondary settings start closed so panels read as short. */
export function Section({
  title,
  defaultOpen = false,
  right,
  children,
}: {
  title: string
  defaultOpen?: boolean
  right?: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <div className="border-t border-slate-200 pt-2.5">
      <div className="flex items-center gap-1">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={id}
          className="flex flex-1 items-center gap-1.5 rounded-md py-1 text-left hover:text-slate-900"
        >
          <IconChevron
            size={13}
            className={`text-slate-400 transition-transform ${open ? '' : '-rotate-90'}`}
          />
          <SectionLabel>{title}</SectionLabel>
        </button>
        {right}
      </div>
      {open && (
        <div id={id} className="space-y-2.5 pb-1 pt-1.5">
          {children}
        </div>
      )}
    </div>
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-slate-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-snug text-slate-500">{hint}</span>}
    </label>
  )
}

export const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none'

export function Slider({
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  suffix = '',
  onChange,
}: {
  label: string
  /** One line saying what moving this actually changes. */
  hint?: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  onChange: (v: number) => void
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-slate-600">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-slate-500">
          {value}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-slate-900"
      />
      {hint && <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">{hint}</span>}
    </label>
  )
}

export function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  hint?: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 py-0.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-slate-900"
      />
      <span className="min-w-0">
        <span className="block text-xs leading-tight text-slate-700">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] leading-snug text-slate-400">{hint}</span>}
      </span>
    </label>
  )
}

/** Where a list has nothing in it, say what to do rather than showing a blank box. */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center">
      <p className="text-xs font-semibold text-slate-700">{title}</p>
      <p className="mx-auto mt-1 max-w-[26ch] text-[11px] leading-relaxed text-slate-500">{body}</p>
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  )
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-block min-w-[1.4em] rounded border border-slate-300 bg-slate-50 px-1 text-center font-mono text-[10px] leading-[1.5] text-slate-600">
      {children}
    </kbd>
  )
}

export function Divider() {
  return <span className="mx-0.5 h-6 w-px shrink-0 bg-slate-200" aria-hidden="true" />
}
