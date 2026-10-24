import type { ReactElement } from 'react';

function PlusIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
        </svg>
    );
}

function BackIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
        </svg>
    );
}

function MoreIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5" cy="12" r="1" />
            <circle cx="12" cy="12" r="1" />
            <circle cx="19" cy="12" r="1" />
        </svg>
    );
}

function ShareIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 15V3m-5 5 5-5 5 5" />
            <path d="M5 13v7h14v-7" />
        </svg>
    );
}

function CloseIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
        </svg>
    );
}

function SearchIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6" />
            <path d="m20 20-4.5-4.5" />
        </svg>
    );
}

function AppsGridIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <path d="M17.5 14.5v6m-3-3h6" />
        </svg>
    );
}

function MicIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="3" width="6" height="12" rx="3" />
            <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 18v3m-4 0h8" />
        </svg>
    );
}

function WaveformIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 10v4m4-8v12m4-15v18m4-12v6m4-8v10" />
        </svg>
    );
}

function SendArrowIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 19V5m-7 7 7-7 7 7" />
        </svg>
    );
}

function ChevronIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m9 18 6-6-6-6" />
        </svg>
    );
}

function FolderIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
    );
}

function CameraIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h4l1.5-2h5L16 7h4v12H4z" />
            <circle cx="12" cy="13" r="3.5" />
        </svg>
    );
}

function ImageIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="8.5" cy="9" r="1.5" />
            <path d="m4 17 5-5 3 3 3-4 5 6" />
        </svg>
    );
}

function CodeIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16" />
        </svg>
    );
}

function ClockIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
        </svg>
    );
}

function LibraryIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 5h14a2 2 0 0 1 2 2v12H6a2 2 0 0 1-2-2z" />
            <path d="M4 5v12a2 2 0 0 0 2 2M8 9h8m-8 4h6" />
        </svg>
    );
}

function MonitorIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="4" width="18" height="13" rx="2" />
            <path d="M8 21h8m-4-4v4" />
        </svg>
    );
}

function FilterIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 6h16M7 12h10m-7 6h4" />
        </svg>
    );
}

function PeopleIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="9" cy="8" r="3" />
            <path d="M3.5 19v-1.5a5.5 5.5 0 0 1 11 0V19z" />
            <path d="M16 5.5a3 3 0 0 1 0 5.8M17 14a5 5 0 0 1 3.5 4.8V19h-4" />
        </svg>
    );
}

export {
    AppsGridIcon,
    BackIcon,
    CameraIcon,
    ChevronIcon,
    ClockIcon,
    CloseIcon,
    CodeIcon,
    FilterIcon,
    FolderIcon,
    ImageIcon,
    LibraryIcon,
    MicIcon,
    MonitorIcon,
    MoreIcon,
    PeopleIcon,
    PlusIcon,
    SearchIcon,
    SendArrowIcon,
    ShareIcon,
    WaveformIcon,
};
