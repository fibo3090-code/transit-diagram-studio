/**
 * Icon set.
 *
 * Hand-drawn on a 24-unit grid, stroked with `currentColor` so every icon inherits the
 * colour of whatever it sits in. No icon library: the set is small, and a dependency
 * that ships a thousand glyphs to use twenty is not worth the bytes.
 */

type IconProps = {
  size?: number
  className?: string
  strokeWidth?: number
}

function Icon({
  size = 16,
  className,
  strokeWidth = 1.75,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export const IconCursor = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 3l6.5 16 2.4-6.6L20.5 10z" />
  </Icon>
)

export const IconStation = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="10" r="3" />
    <path d="M12 21c4.5-5.2 7-8.6 7-11a7 7 0 1 0-14 0c0 2.4 2.5 5.8 7 11z" />
  </Icon>
)

export const IconLine = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5" cy="19" r="2.2" />
    <circle cx="19" cy="5" r="2.2" />
    <path d="M6.8 17.2 12 12h5.2" />
    <path d="M12 12V6.8" />
  </Icon>
)

export const IconTerrain = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 7c2.5-2 4.5-2 7 0s4.5 2 7 0 4.5-2 6 0" />
    <path d="M2 13c2.5-2 4.5-2 7 0s4.5 2 7 0 4.5-2 6 0" />
    <path d="M2 19c2.5-2 4.5-2 7 0s4.5 2 7 0 4.5-2 6 0" />
  </Icon>
)

export const IconBend = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 20V10a6 6 0 0 1 6-6h10" />
    <circle cx="4" cy="20" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="20" cy="4" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="9.2" cy="8.4" r="2.4" />
  </Icon>
)

export const IconHand = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 12V5.5a1.5 1.5 0 0 1 3 0V11" />
    <path d="M10 11V4.5a1.5 1.5 0 0 1 3 0V11" />
    <path d="M13 11V6.5a1.5 1.5 0 0 1 3 0V13" />
    <path d="M16 12.5V10a1.5 1.5 0 0 1 3 0v5a6 6 0 0 1-6 6h-1.6a6 6 0 0 1-5-2.7L4 15.4a1.6 1.6 0 0 1 2.6-1.8L7 14" />
  </Icon>
)

export const IconUndo = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 8h10a5.5 5.5 0 0 1 0 11H8" />
    <path d="M8 4 4 8l4 4" />
  </Icon>
)

export const IconRedo = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 8H10a5.5 5.5 0 0 0 0 11h6" />
    <path d="m16 4 4 4-4 4" />
  </Icon>
)

export const IconFit = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 9V4h5" />
    <path d="M20 9V4h-5" />
    <path d="M4 15v5h5" />
    <path d="M20 15v5h-5" />
  </Icon>
)

export const IconExport = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 15V3" />
    <path d="m8 7 4-4 4 4" />
    <path d="M4 15v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3" />
  </Icon>
)

export const IconMagnet = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 4H3v8a9 9 0 0 0 18 0V4h-3v8a6 6 0 0 1-12 0z" />
    <path d="M3 9h3M18 9h3" />
  </Icon>
)

export const IconGlobe = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z" />
  </Icon>
)

export const IconDiagram = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5" cy="18" r="2" />
    <circle cx="19" cy="6" r="2" />
    <circle cx="12" cy="11" r="2" />
    <path d="M6.4 16.6 10.6 12.4" />
    <path d="M13.5 9.6 17.6 7.4" />
  </Icon>
)

export const IconImage = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <circle cx="8.5" cy="9.5" r="1.6" />
    <path d="m4 17 4.8-4.8a2 2 0 0 1 2.8 0L20 20" />
  </Icon>
)

export const IconData = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M3 10h18M9 10v10M15 10v10" />
  </Icon>
)

export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="m4 12.5 5 5L20 6.5" />
  </Icon>
)

export const IconWarn = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.8 2.6 20h18.8z" />
    <path d="M12 10v4.5" />
    <circle cx="12" cy="17.4" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)

export const IconTrash = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h16" />
    <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
  </Icon>
)

export const IconEye = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </Icon>
)

export const IconEyeOff = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 4l16 16" />
    <path d="M9.6 5.8A9.6 9.6 0 0 1 12 5.5c6.2 0 10 6.5 10 6.5a17 17 0 0 1-3.4 4.1" />
    <path d="M6.4 7.9A17 17 0 0 0 2 12s3.8 6.5 10 6.5a9.7 9.7 0 0 0 3.6-.7" />
    <path d="M9.6 9.9a2.8 2.8 0 0 0 3.9 3.9" />
  </Icon>
)

export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Icon>
)

export const IconHelp = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.2a2.6 2.6 0 1 1 3.4 2.5c-.6.2-.9.8-.9 1.4v.4" />
    <circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconChevron = (p: IconProps) => (
  <Icon {...p}>
    <path d="m7 10 5 5 5-5" />
  </Icon>
)

export const IconClose = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
)

export const IconStraighten = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 17h6l4-10h8" />
    <circle cx="3" cy="17" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="21" cy="7" r="1.4" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconBranch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5" cy="19" r="2.2" />
    <circle cx="19" cy="5" r="2.2" />
    <circle cx="19" cy="15" r="2.2" />
    <path d="M6.6 17.4 12 12" />
    <path d="M12 12h5" />
    <path d="M13.4 13.4 17.4 15" />
    <path d="M13.4 10.6 17.4 6.6" />
  </Icon>
)

export const IconLayers = (p: IconProps) => (
  <Icon {...p}>
    <path d="m12 3 9 5-9 5-9-5z" />
    <path d="m3 13 9 5 9-5" />
  </Icon>
)

export const IconText = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 6V4h14v2" />
    <path d="M12 4v16" />
    <path d="M9 20h6" />
  </Icon>
)

/** Drag handle. Two columns of dots -- the universal "pick me up" affordance. */
export const IconGrip = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="6" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="6" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="9" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="9" cy="18" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="18" r="1.1" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconAsset = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3l2.4 5.2 5.6.7-4.1 3.9 1 5.6L12 15.7 7.1 18.4l1-5.6L4 8.9l5.6-.7z" />
  </Icon>
)

export const IconRoute = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="18" cy="6" r="2.4" />
    <path d="M8.4 18h5.1a3 3 0 0 0 0-6H10.5a3 3 0 0 1 0-6h5.1" />
  </Icon>
)

export const IconMore = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconMoon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2z" />
  </Icon>
)

export const IconSun = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M19.1 4.9l-1.5 1.5M6.4 17.6l-1.5 1.5" />
  </Icon>
)

export const IconRows = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 6h18M3 12h18M3 18h18" />
  </Icon>
)

export const IconArrowRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
)

export const IconSwap = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 8h13l-3-3M20 16H7l3 3" />
  </Icon>
)
