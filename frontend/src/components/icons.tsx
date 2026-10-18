/** Line icons, drawn on a 24-unit grid and coloured by the surrounding text colour. */
import type { ReactNode } from "react";

function Svg({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

type IconProps = { size?: number };

export const CameraIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="6.5" width="12.5" height="11" rx="2" />
    <path d="M15.5 10.5 21 7.5v9l-5.5-3" />
  </Svg>
);
export const CameraOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6.5h4.5a2 2 0 0 1 2 2v3l5.5-4v9l-3-1.6M15.5 15.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 1.5-1.9" />
    <path d="m3 3 18 18" />
  </Svg>
);
export const MicIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </Svg>
);
export const MicOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 9.5V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5" />
    <path d="M5.5 11a6.5 6.5 0 0 0 10.3 5.3M18.5 11c0 .9-.2 1.7-.5 2.5M12 17.5V21M3 3l18 18" />
  </Svg>
);
export const SoundIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z" />
    <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" />
  </Svg>
);
export const SoundOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z" />
    <path d="m16 9.5 5 5M21 9.5l-5 5" />
  </Svg>
);
export const ClearIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="11" height="8" rx="1.5" />
    <rect x="9.5" y="11" width="11" height="8" rx="1.5" />
    <path d="m3 21 18-18" />
  </Svg>
);
export const HistoryIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5M3.5 4v4.5H8" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);
export const ActivityIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12h4l2.5-7 5 14 2.5-7h4" />
  </Svg>
);
export const SettingsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="12" r="2" />
    <circle cx="17" cy="17" r="2" />
  </Svg>
);
export const HelpIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.3a2.6 2.6 0 0 1 5 .9c0 1.8-2.5 2.2-2.5 4M12 17.3v.2" />
  </Svg>
);
export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
);
export const PinIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 3.5h6l-1 5.5 3.5 3.5v1.5h-11V12.5L10 9 9 3.5ZM12 14v7" />
  </Svg>
);
export const ExpandIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
  </Svg>
);
export const ShrinkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 10h-6V4M4 14h6v6M14 10l6-6M10 14l-6 6" />
  </Svg>
);
export const UpIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 14.5 6-6 6 6" />
  </Svg>
);
export const DownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 9.5 6 6 6-6" />
  </Svg>
);
export const SendIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 19.5v-15M5.5 11 12 4.5l6.5 6.5" />
  </Svg>
);
export const StopIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
  </Svg>
);
export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.500 7M10 11v5M14 11v5" />
  </Svg>
);
export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const RefreshIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 1 1-2.5-5.8L20 8.5M20 4v4.5h-4.500" />
  </Svg>
);
export const StarIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12 3.500 2.600 5.400 5.900.800-4.300 4.100 1 5.900-5.200-2.800-5.200 2.800 1-5.900-4.300-4.100 5.900-.800L12 3.500Z" />
  </Svg>
);
export const ForkIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="5.5" r="2" />
    <circle cx="17" cy="5.5" r="2" />
    <circle cx="12" cy="18.5" r="2" />
    <path d="M7 7.500v2a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3v-2M12 12.500v4" />
  </Svg>
);
export const CommentIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5.500h16v10.500h-8.500L7 20v-4H4V5.500Z" />
  </Svg>
);
export const IssueIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.500" />
    <circle cx="12" cy="12" r="1.500" fill="currentColor" />
  </Svg>
);

/* ---- one icon per panel type ------------------------------------------- */

export const AnswerIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5h16v11h-7.500L8 20v-4H4V5Z" />
    <path d="M8 9h8M8 12.500h5" />
  </Svg>
);
export const WeatherIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 2.500v1M2.500 8h1M4.100 4.100l.700.700M11.900 4.100l-.700.700" />
    <path d="M9 19.500h8.500a3.500 3.500 0 0 0 .300-7 5 5 0 0 0-9.600 1.300A3 3 0 0 0 9 19.500Z" />
  </Svg>
);
export const GithubIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.500 19.500c-4 1.200-4-2-5.500-2.500m11 4.500v-3.200a2.800 2.800 0 0 0-.800-2.200c2.600-.300 5.300-1.300 5.300-5.700a4.400 4.400 0 0 0-1.200-3.100 4.100 4.100 0 0 0-.100-3.100s-1-.300-3.200 1.200a11 11 0 0 0-5.800 0C7 3.900 6 4.200 6 4.200a4.100 4.100 0 0 0-.100 3.100 4.400 4.400 0 0 0-1.200 3.100c0 4.400 2.700 5.400 5.300 5.700a2.800 2.800 0 0 0-.800 2.200V21.500" />
  </Svg>
);
export const NewsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5h13v14H6a2 2 0 0 1-2-2V5ZM17 9h3v8a2 2 0 0 1-2 2" />
    <path d="M7.500 9h6M7.500 12.500h6M7.500 16h3.500" />
  </Svg>
);
export const WikipediaIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5.500c3-.800 5.500-.300 8 1.500 2.500-1.800 5-2.300 8-1.500v12.500c-3-.800-5.500-.300-8 1.500-2.500-1.800-5-2.300-8-1.500V5.500ZM12 7v12.500" />
  </Svg>
);
export const SpaceIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="5.500" />
    <path d="M6.900 14.200c-2.600 1.700-4.100 3.300-3.600 4.200.800 1.400 5.900-.300 11.400-3.700s9.300-7.200 8.500-8.600c-.500-.900-2.600-.500-5.400.700" />
  </Svg>
);

/* ---- weather conditions --------------------------------------------------- */

const cloud = "M7 18.500h10a4 4 0 0 0 .400-8 5.700 5.700 0 0 0-11-1.200A4.600 4.600 0 0 0 7 18.500Z";
const smallCloud = "M7.500 14.500h9.500a3.500 3.500 0 0 0 .300-7 5 5 0 0 0-9.600 1.100 3 3 0 0 0-.200 5.900Z";

export function ConditionIcon({ icon, size = 22 }: { icon: string; size?: number }) {
  switch (icon) {
    case "clear":
      return (
        <Svg size={size}>
          <circle cx="12" cy="12" r="4.200" />
          <path d="M12 2.500v2.200M12 19.300v2.200M2.500 12h2.200M19.300 12h2.200M5.300 5.300l1.600 1.600M17.100 17.100l1.600 1.600M18.700 5.300l-1.600 1.600M6.900 17.100l-1.600 1.600" />
        </Svg>
      );
    case "partly":
      return (
        <Svg size={size}>
          <circle cx="8" cy="8" r="3" />
          <path d="M8 2.500v1.200M2.500 8h1.200M4.100 4.100l.900.900M11.900 4.100l-.900.900" />
          <path d="M9 19.500h8.500a3.500 3.500 0 0 0 .300-7 5 5 0 0 0-9.600 1.300A3 3 0 0 0 9 19.500Z" />
        </Svg>
      );
    case "fog":
      return (
        <Svg size={size}>
          <path d={smallCloud} />
          <path d="M5 18h14M7.500 21h9" />
        </Svg>
      );
    case "drizzle":
      return (
        <Svg size={size}>
          <path d={smallCloud} />
          <path d="M9 17.500v1.500M12.500 17.500v1.500M16 17.500v1.500" />
        </Svg>
      );
    case "rain":
      return (
        <Svg size={size}>
          <path d={smallCloud} />
          <path d="m9.500 17-1.300 4M13 17l-1.300 4M16.500 17l-1.300 4" />
        </Svg>
      );
    case "snow":
      return (
        <Svg size={size}>
          <path d={smallCloud} />
          <path d="M9 18.500h.010M12.500 18.500h.010M16 18.500h.010M10.700 21.200h.010M14.300 21.200h.010" strokeWidth="2.400" />
        </Svg>
      );
    case "storm":
      return (
        <Svg size={size}>
          <path d={smallCloud} />
          <path d="m12.800 15.500-2.300 3.500h3l-1.800 3" />
        </Svg>
      );
    default:
      return (
        <Svg size={size}>
          <path d={cloud} />
        </Svg>
      );
  }
}

export const ChevronLeftIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m14.5 5.5-6.5 6.5 6.5 6.5" />
  </Svg>
);
export const ChevronRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />
  </Svg>
);
export const GridIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.4" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.4" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.4" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.4" />
  </Svg>
);
export const HandIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 12V5.5a1.4 1.4 0 0 1 2.8 0V11M10.8 10.5V4a1.4 1.4 0 0 1 2.8 0v6.5M13.6 10.5V5a1.4 1.4 0 0 1 2.8 0v7.5M16.4 9.5a1.4 1.4 0 0 1 2.8 0V14a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.7-2.3L4 14.5a1.5 1.5 0 0 1 2.3-1.9L8 14.5" />
  </Svg>
);
export const HomeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 11 12 4l8 7M6 9.5V20h12V9.5M10 20v-5h4v5" />
  </Svg>
);
export const GlobeIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.6 2.6 3.6 5.4 3.6 8.5s-1 5.9-3.6 8.5c-2.6-2.6-3.6-5.4-3.6-8.5S9.4 6.1 12 3.5Z" />
  </Svg>
);
export const AgentIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="6" r="2.2" />
    <circle cx="18" cy="9" r="2.2" />
    <circle cx="9" cy="18" r="2.2" />
    <path d="M8 6.8 15.9 8.4M16.6 10.9 10.6 16.4M7.4 8 8.2 15.8" />
  </Svg>
);
export const EarthIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="7.5" />
    <path d="M7.2 8.4c1.6.2 2.2 1.2 3 1.4s1.4-.8 2.6-.2M14.4 13.8c1 .6 1.3 1.6 1.1 3M5.4 13.4c1.2-.2 2 .4 2.6 1.2M3 18.5c4 2 14.5-1 18-7.5" />
  </Svg>
);
export const SatelliteIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9.5" y="9.5" width="5" height="5" rx="1" transform="rotate(45 12 12)" />
    <path d="m5.5 8 2.6 2.6M15.9 13.4 18.5 16M4 12.5l-1.5-1.5M20 13l1.5 1.5M13 4l-1.5-1.5" />
  </Svg>
);
export const MapIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3.5 6.5 5.5-2 6 2 5.5-2v13l-5.5 2-6-2-5.5 2Z" />
    <path d="M9 4.5v13M15 6.5v13" />
  </Svg>
);
export const BrainIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 4.5a3 3 0 0 0-3 3v.3a3 3 0 0 0-1.5 5.4 3 3 0 0 0 2 4.3 3 3 0 0 0 5.5-1.1V5.8a3 3 0 0 0-3-1.3ZM14.5 4.5a3 3 0 0 1 3 3v.3a3 3 0 0 1 1.5 5.4 3 3 0 0 1-2 4.3 3 3 0 0 1-3.5 1.9" />
  </Svg>
);
export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="5.5" />
    <path d="m15 15 5 5" />
  </Svg>
);
export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);
export const LockIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.5" y="10.5" width="13" height="9" rx="2" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
  </Svg>
);
