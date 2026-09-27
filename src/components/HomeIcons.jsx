// Minimal inline SVG icons for the redesigned Home page. This project has no
// icon library installed, so these are small hand-rolled stand-ins (stroke =
// currentColor) rather than an added dependency.
const base = { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };

export function MenuIcon(props) {
  return (<svg {...base} {...props}><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>);
}
export function HospitalLogoIcon(props) {
  return (<svg {...base} {...props}><path d="M3 21h18" /><path d="M3 21V8l7-5 7 5v13" /><path d="M9 21v-6h4v6" /><path d="M9 9h4" /><path d="M11 7v4" /></svg>);
}
export function SunIcon(props) {
  return (<svg {...base} {...props}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>);
}
export function ChevronDownIcon(props) {
  return (<svg {...base} {...props}><polyline points="6 9 12 15 18 9" /></svg>);
}
export function ChevronRightIcon(props) {
  return (<svg {...base} {...props}><polyline points="9 18 15 12 9 6" /></svg>);
}
export function ShieldIcon(props) {
  return (<svg {...base} {...props}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" /></svg>);
}
export function SearchIcon(props) {
  return (<svg {...base} {...props}><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>);
}
export function XIcon(props) {
  return (<svg {...base} {...props}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>);
}
export function UsersIcon(props) {
  return (<svg {...base} {...props}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" /><circle cx="17" cy="9" r="2.8" /><path d="M21.5 20c0-2.8-1.8-5-4.3-5.7" /></svg>);
}
export function UserPlusIcon(props) {
  return (<svg {...base} {...props}><circle cx="9" cy="8" r="4" /><path d="M2 20c0-4 3-7 7-7s7 3 7 7" /><line x1="19" y1="8" x2="19" y2="14" /><line x1="16" y1="11" x2="22" y2="11" /></svg>);
}
export function FolderIcon(props) {
  return (<svg {...base} {...props}><path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V6z" /></svg>);
}
export function BedIcon(props) {
  return (<svg {...base} {...props}><path d="M3 18v-9" /><path d="M3 13h18v5" /><path d="M21 18v-3" /><path d="M3 9h6a2 2 0 012 2v2H3z" /><path d="M13 13h8" /></svg>);
}
export function BellIcon(props) {
  return (<svg {...base} {...props}><path d="M6 9a6 6 0 0112 0c0 5 2 6 2 6H4s2-1 2-6z" /><path d="M10 20a2 2 0 004 0" /></svg>);
}
export function PersonIcon(props) {
  return (<svg {...base} {...props}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" /></svg>);
}
export function ClipboardXIcon(props) {
  return (<svg {...base} {...props}><rect x="4" y="4" width="16" height="17" rx="2" /><path d="M9 3h6v3H9z" /><line x1="9.5" y1="12.5" x2="14.5" y2="17.5" /><line x1="14.5" y1="12.5" x2="9.5" y2="17.5" /></svg>);
}
