/**
 * Inline SVG icons.
 *
 * Hand-drawn on a 24-unit grid with a 1.75 stroke so they sit at the same
 * optical weight as the interface text. Bundling an icon library for fifteen
 * glyphs would cost more than it returns.
 */

type IconProps = { size?: number; className?: string };

function Svg({
  size = 16,
  className,
  children,
}: IconProps & { children: React.ReactNode }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const Plus = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const Pause = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <rect x="6" y="5" width="4" height="14" rx="1.2" />
    <rect x="14" y="5" width="4" height="14" rx="1.2" />
  </Svg>
);

export const Play = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M7 4.8v14.4a.6.6 0 0 0 .92.5l11.3-7.2a.6.6 0 0 0 0-1l-11.3-7.2a.6.6 0 0 0-.92.5Z" />
  </Svg>
);

export const Trash = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M4 7h16M10 4h4M6 7l.8 12.1a1.6 1.6 0 0 0 1.6 1.5h7.2a1.6 1.6 0 0 0 1.6-1.5L18 7" />
    <path d="M10 11v6M14 11v6" />
  </Svg>
);

export const FolderOpen = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M3 8.5V6a1.6 1.6 0 0 1 1.6-1.6h4.2l2 2.4h7.6A1.6 1.6 0 0 1 20 8.4v1.1" />
    <path d="M3.4 10.6h17.1a1 1 0 0 1 .97 1.25l-1.8 7A1.6 1.6 0 0 1 18.1 20H5.2a1.6 1.6 0 0 1-1.57-1.3l-1.2-6.9a1 1 0 0 1 .98-1.2Z" />
  </Svg>
);

export const ExternalOpen = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M14 4h6v6M20 4l-8.5 8.5" />
    <path d="M18 14.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5" />
  </Svg>
);

export const Settings = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.1" />
    <path d="M19.4 14.4a1.5 1.5 0 0 0 .3 1.65l.06.06a1.8 1.8 0 1 1-2.55 2.55l-.06-.06a1.5 1.5 0 0 0-1.65-.3 1.5 1.5 0 0 0-.9 1.37V20a1.8 1.8 0 1 1-3.6 0v-.1a1.5 1.5 0 0 0-.98-1.37 1.5 1.5 0 0 0-1.65.3l-.06.06A1.8 1.8 0 1 1 4.25 16.4l.06-.06a1.5 1.5 0 0 0 .3-1.65 1.5 1.5 0 0 0-1.37-.9H3a1.8 1.8 0 1 1 0-3.6h.1a1.5 1.5 0 0 0 1.37-.98 1.5 1.5 0 0 0-.3-1.65l-.06-.06A1.8 1.8 0 1 1 6.66 4.95l.06.06a1.5 1.5 0 0 0 1.65.3h.07a1.5 1.5 0 0 0 .9-1.37V3.8a1.8 1.8 0 1 1 3.6 0v.1a1.5 1.5 0 0 0 .9 1.37 1.5 1.5 0 0 0 1.65-.3l.06-.06a1.8 1.8 0 1 1 2.55 2.55l-.06.06a1.5 1.5 0 0 0-.3 1.65v.07a1.5 1.5 0 0 0 1.37.9h.1a1.8 1.8 0 1 1 0 3.6h-.1a1.5 1.5 0 0 0-1.37.9Z" />
  </Svg>
);

export const Retry = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 1 0-.6 4" />
    <path d="M20 4.5V11h-6.5" />
  </Svg>
);

export const Check = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M4.5 12.8 9.4 17.6 19.5 6.8" />
  </Svg>
);

export const Alert = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M12 7.8v5M12 16.1h.01" />
  </Svg>
);

export const Broom = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M13.5 10.5 19 5M9.5 14.5l-4.2 4.2a1.4 1.4 0 0 0 0 2h.2a1.4 1.4 0 0 0 1.9-.2l4.1-4.2" />
    <path d="m10.8 8.6 4.6 4.6-3.1 3.1a3.25 3.25 0 0 1-4.6-4.6Z" />
  </Svg>
);

/* ------------------------------- categories ------------------------------- */

export const Film = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.2" />
    <path d="M7.5 4.5v15M16.5 4.5v15M3 12h18M3 8.2h4.5M3 15.8h4.5M16.5 8.2H21M16.5 15.8H21" />
  </Svg>
);

export const Music = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M9 18V6.2l10-2v11.6" />
    <circle cx="6.6" cy="18" r="2.6" />
    <circle cx="16.6" cy="15.8" r="2.6" />
  </Svg>
);

export const Doc = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </Svg>
);

export const Archive = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="4.5" rx="1.4" />
    <path d="M4.8 9v9.4A2 2 0 0 0 6.8 20.4h10.4a2 2 0 0 0 2-2V9" />
    <path d="M10 13h4" />
  </Svg>
);

export const AppBox = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M12 2.8 20.5 7v10L12 21.2 3.5 17V7Z" />
    <path d="M3.5 7 12 11.4 20.5 7M12 11.4V21.2" />
  </Svg>
);

export const FileGeneric = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5" />
  </Svg>
);

export const Inbox = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M3 12h4.6l1.5 2.6h5.8L16.4 12H21" />
    <path d="M5.3 5.4 3 12v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5l-2.3-6.6A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.9 1.4Z" />
  </Svg>
);

export const Bolt = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M13.2 2.5 4.6 13.4a.6.6 0 0 0 .47.97h5.2l-.87 7.13a.6.6 0 0 0 1.06.44l8.6-10.9a.6.6 0 0 0-.47-.97h-5.2l.87-7.13a.6.6 0 0 0-1.06-.44Z" />
  </Svg>
);

export const DownloadArrow = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M12 3.5v11.2M7.4 10.4 12 14.9l4.6-4.5" />
    <path d="M4.5 17.5v1.2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-1.2" />
  </Svg>
);
