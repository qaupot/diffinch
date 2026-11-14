import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number | string };

// Local SVG icons: solid silhouettes, square details, and cutouts on a 20px grid.
// Labels belong to the surrounding controls.
function icon(content: ReactNode) {
  return function Icon({ size = 24, children, ...props }: IconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 20 20"
        fill="currentColor"
        fillRule="evenodd"
        stroke="none"
        aria-hidden="true"
        focusable="false"
        {...props}
      >
        {content}
        {children}
      </svg>
    );
  };
}

const fileBody = "M3 2h8v6h6v10H3Z M13 2l4 4h-4Z";
const folderBody = "M2 4h6l2 2h8v12H2Z";
const panelBody = "M1 3h18v14H1Z M3 5v10h9V5Z";
const imageBody = "M2 3h16v14H2Z M4 5v10h12V5Z";

export const ArrowDown = icon(<path d="M8 2h4v9h5l-7 7-7-7h5Z" />);
export const ArrowLeft = icon(<path d="M18 8v4H9v5l-7-7 7-7v5Z" />);
export const ArrowUp = icon(<path d="M8 18h4V9h5l-7-7-7 7h5Z" />);
export const ArrowUpRight = icon(<path d="M6 3h11v11l-4-4-8 8-3-3 8-8Z" />);
export const Check = icon(<path d="m2 10 3-3 4 4 7-8 3 3L9 17Z" />);
export const ChevronDown = icon(<path d="M4 7h12l-6 7Z" />);
export const ChevronLeft = icon(<path d="M13 4v12l-7-6Z" />);
export const ChevronRight = icon(<path d="M7 4v12l7-6Z" />);
export const Minus = icon(<rect x="3" y="8" width="14" height="4" />);
export const Plus = icon(<path d="M8 3h4v5h5v4h-5v5H8v-5H3V8h5Z" />);
export const X = icon(<path d="m5 2 5 5 5-5 3 3-5 5 5 5-3 3-5-5-5 5-3-3 5-5-5-5Z" />);

export const Archive = icon(
  <>
    <rect x="1" y="2" width="18" height="4" />
    <path d="M3 8h14v10H3Z M7 10v2h6v-2Z" />
  </>,
);
export const BookOpen = icon(
  <path d="M1 3h5l3 2v13l-3-2H1Z M11 5l3-2h5v13h-5l-3 2Z M3 6v2h3V6Z M14 6v2h3V6Z" />,
);
export const CircleAlert = icon(
  <path d="M6 1h8l5 5v8l-5 5H6l-5-5V6Z M8.5 5v6h3V5Z M8.5 13v3h3v-3Z" />,
);
export const CircleDot = icon(
  <>
    <path d="M10 1a9 9 0 1 1 0 18 9 9 0 0 1 0-18Z M10 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z" />
    <rect x="8" y="8" width="4" height="4" />
  </>,
);
export const Cloud = icon(<path d="M1 11l3-3h2V5l3-2h3l3 3v2h2l2 3v4l-2 2H4l-3-3Z" />);
export const Code2 = icon(
  <path d="M5 5 0 10l5 5 2-2-3-3 3-3Z M15 5l5 5-5 5-2-2 3-3-3-3Z M10 3h3l-3 14H7Z" />,
);
export const Columns2 = icon(<path d="M2 3h7v14H2Z M11 3h7v14h-7Z M4 6v2h3V6Z M13 6v2h3V6Z" />);
export const Copy = icon(
  <>
    <path d="M1 1h12v3H4v10H1Z" />
    <path d="M6 6h13v13H6Z M9 9v2h7V9Z" />
  </>,
);
export const Crosshair = icon(
  <path d="M2 2h6v3H5v3H2Z M12 2h6v6h-3V5h-3Z M2 12h3v3h3v3H2Z M15 12h3v6h-6v-3h3Z M8 8h4v4H8Z" />,
);
export const Ellipsis = icon(<path d="M1 8h4v4H1Z M8 8h4v4H8Z M15 8h4v4h-4Z" />);
export const Eye = icon(
  <>
    <path d="M1 10l5-5h8l5 5-5 5H6Z M6 10l4 4 4-4-4-4Z" />
    <rect x="9" y="9" width="2" height="2" />
  </>,
);
export const EyeOff = icon(
  <>
    <path d="m2 6 5 4h6l5-4v4l-4 3H6l-4-3Z" />
    <path d="m4 12 3 2-3 4-2-2Z M9 13h2v5H9Z M13 14l3-2 2 4-2 2Z" />
  </>,
);
export const FileCode2 = icon(
  <path
    d={`${fileBody} M7 9l-3 3 3 3 1.5-1.5L7 12l1.5-1.5Z M13 9l-1.5 1.5L13 12l-1.5 1.5L13 15l3-3Z`}
  />,
);
export const FileDiff = icon(
  <path d={`${fileBody} M6 9v2H4v2h2v2h2v-2h2v-2H8V9Z M12 12v2h3v-2Z`} />,
);
export const FileText = icon(<path d={`${fileBody} M5 10v2h10v-2Z M5 14v2h7v-2Z`} />);
export const Folder = icon(<path d={folderBody} />);
export const FolderGit2 = icon(<path d={`${folderBody} M5 9v5h4v2h2v-2h4V9h-3v3H8V9Z`} />);
export const GitBranch = icon(
  <>
    <path d="M3 2h5v5H3Z M12 2h5v5h-5Z M3 13h5v5H3Z" />
    <path d="M4 7h3v6H4Z M7 10h6V7h3v6H7Z" />
  </>,
);
export const GitCommitHorizontal = icon(
  <>
    <path d="M7 5h6l4 5-4 5H7l-4-5Z M8 8v4h4V8Z" />
    <path d="M0 9h4v2H0Z M16 9h4v2h-4Z" />
  </>,
);
export const GitFork = icon(
  <>
    <path d="M1 2h5v5H1Z M14 2h5v5h-5Z M7.5 13h5v5h-5Z" />
    <path d="M2 7h3v2h10V7h3v5h-6.5v1h-3v-1H2Z" />
  </>,
);
export const GitMerge = icon(
  <>
    <path d="M2 2h5v5H2Z M13 2h5v5h-5Z M2 13h5v5H2Z" />
    <path d="M3 7h3v6H3Z M14 7h3v3l-5 4H7v-3h4l3-3Z" />
  </>,
);
export const History = icon(
  <>
    <path d="M10 2a8 8 0 1 1-7.6 10h3.2A5 5 0 1 0 6 7l3 3H1V2l3 3a8 8 0 0 1 6-3Z" />
    <path d="M9 6h2v4h3v2H9Z" />
  </>,
);
export const Image = icon(
  <>
    <path d={imageBody} />
    <path d="m5 14 3-4 2 2 3-5 3 7Z" />
    <rect x="5" y="6" width="3" height="3" />
  </>,
);
export const ImageOff = icon(
  <>
    <path d={imageBody} />
    <path d="m6 5 4 3 4-3 2 2-4 3 4 3-2 2-4-3-4 3-2-2 4-3-4-3Z" />
  </>,
);
export const KeyRound = icon(
  <>
    <path d="M3 2h7l3 3v6l-3 3H3l-3-3V5Z M4 5v5h5V5Z" />
    <path d="M10 10h9v7h-3v-3h-2v3h-3Z" />
  </>,
);
export const Languages = icon(
  <path d="M1 1h11v12H1Z M3 10h2l.5-2h2L8 10h2L7.5 3h-2Z M6 5l-.5 1.5h2L7 5Z M14 7h5v12H7v-4h7Z M15 10v2h2v-2Z M10 16v1h7v-1Z" />,
);
export const List = icon(
  <path d="M2 3h3v3H2Z M7 3h11v3H7Z M2 9h3v3H2Z M7 9h11v3H7Z M2 15h3v3H2Z M7 15h11v3H7Z" />,
);
export const ListFilter = icon(
  <>
    <path d="M1 3h10v3H1Z M1 9h7v3H1Z M1 15h7v3H1Z" />
    <path d="M10 8h10l-4 5v5h-2v-5Z" />
  </>,
);
export const Palette = icon(
  <>
    <rect x="2" y="2" width="7" height="7" />
    <rect x="11" y="2" width="7" height="7" opacity=".45" />
    <rect x="2" y="11" width="7" height="7" opacity=".7" />
    <path d="M11 11h7v7h-7Z M13 13v3h3v-3Z" />
  </>,
);
export const PanelRightClose = icon(
  <>
    <path d={panelBody} />
    <path d="M5 6v8l5-4Z" />
  </>,
);
export const PanelRightOpen = icon(
  <>
    <path d={panelBody} />
    <path d="M10 6v8l-5-4Z" />
  </>,
);
export const RefreshCw = icon(
  <path d="M2 3h12V0l6 5-6 5V7H5v3H2Z M18 17H6v3l-6-5 6-5v3h9v-3h3Z" />,
);
export const Search = icon(
  <>
    <path d="M2 5 5 2h7l3 3v7l-3 3H5l-3-3Z M5 6v5l1 1h5l1-1V6l-1-1H6Z" />
    <path d="m13 11 6 6-2 2-6-6Z" />
  </>,
);
export const Server = icon(
  <path d="M2 2h16v7H2Z M4 4v3h3V4Z M10 5v1h5V5Z M2 11h16v7H2Z M4 13v3h3v-3Z M10 14v1h5v-1Z" />,
);
export const Settings2 = icon(
  <>
    <path d="M1 4h18v2H1Z M1 14h18v2H1Z" />
    <path d="M5 1h5v8H5Z M11 11h5v8h-5Z" />
  </>,
);
export const ShieldCheck = icon(<path d="M3 2h14v9l-7 7-7-7Z M6 8l-2 2 5 5 7-9-2-2-5 7Z" />);
export const Tag = icon(<path d="M2 6 6 2h12v12l-4 4Z M12 5v3h3V5Z" />);
