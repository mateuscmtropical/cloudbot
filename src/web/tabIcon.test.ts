// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import staticFavicon from './public/favicon.svg?raw';
import { TAB_ICON_LINK_SELECTOR, applyTabIcon, buildFaviconSvg } from './tabIcon.ts';

const DOT_COLOR = '#e5484d';

function addTabIconLink(): HTMLLinkElement {
    const link = document.createElement('link');

    link.setAttribute('rel', 'icon');
    link.setAttribute('href', '/favicon.svg');
    link.setAttribute('data-tab-icon', '');
    document.head.appendChild(link);

    return link;
}

describe('buildFaviconSvg', () => {
    it('matches the static favicon file for the idle face without a dot', () => {
        expect(buildFaviconSvg('idle', false))
            .toBe(staticFavicon);
    });

    it('draws the thinking chevrons instead of the smile', () => {
        const svg = buildFaviconSvg('thinking', false);

        expect(svg)
            .toContain('points="43,61 52,70 43,79"');
        expect(svg)
            .not.toContain('points="43,70');
    });

    it('adds the red dot only when a reply is unread', () => {
        expect(buildFaviconSvg('idle', false))
            .not.toContain(DOT_COLOR);
        expect(buildFaviconSvg('idle', true))
            .toContain(DOT_COLOR);
    });
});

describe('applyTabIcon', () => {
    let link: HTMLLinkElement | undefined;

    afterEach(() => {
        link?.remove();
        link = undefined;
    });

    it('uses the static file when idle and nothing is unread', () => {
        link = addTabIconLink();
        link.setAttribute('href', 'data:image/svg+xml,stale');

        applyTabIcon({ isWorking: false, hasUnreadReply: false });

        expect(link.getAttribute('href'))
            .toBe('/favicon.svg');
    });

    it('shows the thinking face while a bot works', () => {
        link = addTabIconLink();

        applyTabIcon({ isWorking: true, hasUnreadReply: false });

        expect(link.getAttribute('href'))
            .toBe(`data:image/svg+xml,${encodeURIComponent(buildFaviconSvg('thinking', false))}`);
    });

    it('shows the dot on the face for an unread reply', () => {
        link = addTabIconLink();

        applyTabIcon({ isWorking: false, hasUnreadReply: true });

        expect(link.getAttribute('href'))
            .toBe(`data:image/svg+xml,${encodeURIComponent(buildFaviconSvg('idle', true))}`);
    });

    it('does nothing when the page has no tab icon link', () => {
        expect(() => {
            applyTabIcon({ isWorking: true, hasUnreadReply: true });
        })
            .not.toThrow();
        expect(document.querySelector(TAB_ICON_LINK_SELECTOR))
            .toBeNull();
    });
});
