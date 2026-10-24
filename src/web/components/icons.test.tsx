// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
    AppsGridIcon,
    BackIcon,
    CameraIcon,
    ChevronIcon,
    ClockIcon,
    CloseIcon,
    CodeIcon,
    EditIcon,
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
    TrashIcon,
    WaveformIcon,
} from './icons.tsx';

describe('icons', () => {
    afterEach(cleanup);

    it('renders the shared icon set as decorative SVGs', () => {
        const icons = [
            <PlusIcon key="plus" />,
            <BackIcon key="back" />,
            <MoreIcon key="more" />,
            <ShareIcon key="share" />,
            <CloseIcon key="close" />,
            <SearchIcon key="search" />,
            <AppsGridIcon key="apps" />,
            <MicIcon key="mic" />,
            <WaveformIcon key="waveform" />,
            <SendArrowIcon key="send" />,
            <ChevronIcon key="chevron" />,
            <FolderIcon key="folder" />,
            <CameraIcon key="camera" />,
            <ImageIcon key="image" />,
            <CodeIcon key="code" />,
            <EditIcon key="edit" />,
            <ClockIcon key="clock" />,
            <LibraryIcon key="library" />,
            <MonitorIcon key="monitor" />,
            <FilterIcon key="filter" />,
            <PeopleIcon key="people" />,
            <TrashIcon key="trash" />,
        ];
        const { container } = render(<>{icons}</>);

        expect(container.querySelectorAll('svg[aria-hidden="true"]'))
            .toHaveLength(22);
    });
});
