import { describe, expect, it } from 'vitest';

import { GalleryError, TemplateGallery, digestOf, readGalleryRepo } from './templateGallery.ts';
import type { GalleryRequest, GalleryResponse, GalleryTransport } from './templateGallery.ts';

const REPO = 'owner/templates';
const FORK = 'bot-owner/templates';
const BRANCH = 'cloudbot-template-ana-template-rs';
const ANA_TEXT = JSON.stringify({
    cloudbotTemplate: 1,
    name: 'Ana',
    title: 'Mail helper',
    description: 'Sorts my mail.',
    rules: [{ kind: 'block', text: 'No purchases.', blockedTools: ['Bash'] }],
});
const ANA_ROW = { file: 'ana-mail.json', name: 'Ana', title: 'Mail helper', description: 'Sorts my mail.', blockedTools: ['Bash'] };
const BROKEN_ROW = { file: 'broken.json', name: 'Broken', title: 'Broken bot', description: '', blockedTools: ['not a tool'] };
const FILES_PATH = `/repos/${REPO}/contents/templates`;
const FORK_FILES_PATH = `/repos/${FORK}/contents/templates`;
const LIMIT_MESSAGE = 'GitHub limit reached for the template gallery. Try later.';
const UNREADABLE_MESSAGE = 'The template gallery could not be read right now. Try again later.';

interface Route {
    method: string;
    path: string;
    status: number;
    text: string;
}

// A fake GitHub. It answers from the routes and records each request. Unknown requests fail the test.
function fakeGithub(routes: Route[], sent: GalleryRequest[]): GalleryTransport {
    return (request: GalleryRequest): Promise<GalleryResponse> => {
        sent.push(request);

        const pathWithQuery = `${request.url.pathname}${request.url.search}`;
        const route = routes.find(candidate => candidate.method === request.method && candidate.path === pathWithQuery);

        if (route === undefined) {
            return Promise.reject(new Error(`No fake route for ${request.method} ${pathWithQuery}`));
        }

        return Promise.resolve({ status: route.status, text: route.text });
    };
}

function indexRoute(rows: unknown): Route {
    return { method: 'GET', path: `${FILES_PATH}/index.json`, status: 200, text: JSON.stringify(rows) };
}

function fileRoutes(): Route[] {
    return [
        { method: 'GET', path: `${FILES_PATH}/ana-mail.json`, status: 200, text: ANA_TEXT },
        { method: 'GET', path: `${FILES_PATH}/broken.json`, status: 200, text: '{ "not": "a template" }' },
    ];
}

// The branch steps of a share. The fork answers, the branch is new, and the file and index do not exist yet.
function shareRoutes(): Route[] {
    return [
        { method: 'GET', path: `/repos/${REPO}`, status: 200, text: JSON.stringify({ default_branch: 'main' }) },
        { method: 'POST', path: `/repos/${REPO}/forks`, status: 202, text: JSON.stringify({ full_name: FORK, owner: { login: 'bot-owner' }, default_branch: 'main' }) },
        { method: 'GET', path: `/repos/${FORK}/git/ref/heads/main`, status: 200, text: JSON.stringify({ object: { sha: 'base-sha' } }) },
        { method: 'GET', path: `/repos/${REPO}/git/ref/heads/main`, status: 200, text: JSON.stringify({ object: { sha: 'gallery-head-sha' } }) },
        { method: 'POST', path: `/repos/${FORK}/git/refs`, status: 201, text: '{}' },
        { method: 'GET', path: `${FORK_FILES_PATH}/ana-template.json?ref=${BRANCH}`, status: 404, text: '' },
        { method: 'GET', path: `${FORK_FILES_PATH}/index.json?ref=${BRANCH}`, status: 404, text: '' },
        { method: 'PUT', path: `${FORK_FILES_PATH}/ana-template.json`, status: 201, text: '{}' },
        { method: 'PUT', path: `${FORK_FILES_PATH}/index.json`, status: 201, text: '{}' },
        { method: 'POST', path: `/repos/${REPO}/pulls`, status: 201, text: JSON.stringify({ html_url: 'https://github.com/owner/templates/pull/7' }) },
        { method: 'DELETE', path: `/repos/${FORK}/git/refs/heads/${BRANCH}`, status: 204, text: '' },
    ];
}

function replaceRoute(routes: Route[], method: string, path: string, next: Partial<Route>): Route[] {
    return routes.map(route => (route.method === method && route.path === path ? { ...route, ...next } : route));
}

function bodyOf(request: GalleryRequest | undefined): Record<string, unknown> {
    return JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
}

function decodeContent(body: Record<string, unknown>): string {
    return Buffer.from(String(body.content), 'base64')
        .toString('utf8');
}

describe('TemplateGallery.listTemplates', () => {
    it('reads one index file and lists its valid rows', async () => {
        const sent: GalleryRequest[] = [];
        const routes = [indexRoute([ANA_ROW, BROKEN_ROW]), ...fileRoutes()];
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub(routes, sent) });

        const entries = await gallery.listTemplates();

        expect(entries)
            .toEqual([{ file: 'ana-mail.json', name: 'Ana', title: 'Mail helper', description: 'Sorts my mail.', blockedTools: ['Bash'] }]);
        expect(sent)
            .toHaveLength(1);
        expect(sent[0]?.token)
            .toBeUndefined();
    });

    it('drops an index row whose description hides characters', async () => {
        const hiddenRow = { ...ANA_ROW, description: 'Sorts my mail.\u{E0041}\u{E0042}' };
        const routes = [indexRoute([hiddenRow]), ...fileRoutes()];
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub(routes, []) });

        const entries = await gallery.listTemplates();

        expect(entries)
            .toEqual([]);
    });

    it('cuts a long description to 200 characters in the listing', async () => {
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub([indexRoute([{ ...ANA_ROW, description: 'x'.repeat(300) }])], []) });

        const entries = await gallery.listTemplates();

        expect(entries[0]?.description)
            .toHaveLength(200);
    });

    it('refuses an index with more than 200 rows', async () => {
        const rows = Array.from({ length: 201 }, () => ANA_ROW);
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub([indexRoute(rows)], []) });

        await expect(gallery.listTemplates())
            .rejects
            .toThrow('The template gallery index is not valid');
    });

    it('refuses an index that is not a list', async () => {
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub([indexRoute({ file: 'ana-mail.json' })], []) });

        await expect(gallery.listTemplates())
            .rejects
            .toBeInstanceOf(GalleryError);
    });

    it('keeps a good listing for an hour, then reads it again', async () => {
        const sent: GalleryRequest[] = [];
        let clock = 1000;
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub([indexRoute([ANA_ROW])], sent), now: () => clock });

        await gallery.listTemplates();
        clock += 59 * 60 * 1000;
        await gallery.listTemplates();

        expect(sent)
            .toHaveLength(1);

        clock += 2 * 60 * 1000;
        await gallery.listTemplates();

        expect(sent)
            .toHaveLength(2);
    });

    it('does not keep a failed read, so the next call reads again', async () => {
        const sent: GalleryRequest[] = [];
        const index: Route = { method: 'GET', path: `${FILES_PATH}/index.json`, status: 503, text: '' };
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub([index], sent), now: () => 1000 });

        await expect(gallery.listTemplates())
            .rejects
            .toThrow(UNREADABLE_MESSAGE);
        index.status = 200;
        index.text = JSON.stringify([ANA_ROW]);

        const entries = await gallery.listTemplates();

        expect(entries)
            .toHaveLength(1);
        expect(sent)
            .toHaveLength(2);
    });

    it('says GitHub is limiting the reads on a 403 or 429', async () => {
        await Promise.all([403, 429].map((status) => {
            const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub([{ method: 'GET', path: `${FILES_PATH}/index.json`, status, text: '' }], []) });

            return expect(gallery.listTemplates())
                .rejects
                .toThrow(LIMIT_MESSAGE);
        }));
    });

    it('says the gallery cannot be read for any other failure', async () => {
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub([{ method: 'GET', path: `${FILES_PATH}/index.json`, status: 503, text: '' }], []) });

        await expect(gallery.listTemplates())
            .rejects
            .toThrow(UNREADABLE_MESSAGE);
    });
});

describe('TemplateGallery.fetchTemplate', () => {
    it('reads one template with the digest of its exact bytes', async () => {
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub(fileRoutes(), []) });

        const fetched = await gallery.fetchTemplate('ana-mail.json');

        expect(fetched.template.name)
            .toBe('Ana');
        expect(fetched.digest)
            .toBe(digestOf(ANA_TEXT));
    });

    it('refuses a name that is not a gallery file name before any request is sent', async () => {
        const sent: GalleryRequest[] = [];
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub(fileRoutes(), sent) });

        await expect(gallery.fetchTemplate('../ana-mail.json'))
            .rejects
            .toBeInstanceOf(GalleryError);
        await expect(gallery.fetchTemplate('index.json'))
            .rejects
            .toBeInstanceOf(GalleryError);
        expect(sent)
            .toHaveLength(0);
    });

    it('says a missing template is not in the gallery', async () => {
        const routes: Route[] = [{ method: 'GET', path: `${FILES_PATH}/missing.json`, status: 404, text: '' }];
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub(routes, []) });

        await expect(gallery.fetchTemplate('missing.json'))
            .rejects
            .toThrow('That template is not in the gallery.');
    });

    it('refuses a template that fails the import checks, with the reason', async () => {
        const routes: Route[] = [{ method: 'GET', path: `${FILES_PATH}/broken.json`, status: 200, text: '{ "cloudbotTemplate": 1, "name": "Ana", "title": "x", "webhookUrl": "https://x.test" }' }];
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub(routes, []) });

        await expect(gallery.fetchTemplate('broken.json'))
            .rejects
            .toThrow('That gallery template is not valid.');
    });
});

describe('TemplateGallery.fileExists', () => {
    it('tells whether the gallery already has the file', async () => {
        const routes = [...fileRoutes(), { method: 'GET', path: `${FILES_PATH}/new-bot.json`, status: 404, text: '' }];
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub(routes, []) });

        expect(await gallery.fileExists('ana-mail.json'))
            .toBe(true);
        expect(await gallery.fileExists('new-bot.json'))
            .toBe(false);
    });
});

describe('TemplateGallery.openPullRequest', () => {
    it('forks the gallery, adds the file and its index row on a new branch, and opens the pull request from the fork', async () => {
        const sent: GalleryRequest[] = [];
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub(shareRoutes(), sent), now: () => 1000, wait: () => Promise.resolve() });

        const url = await gallery.openPullRequest({ token: 'fake-token-1', fileName: 'ana-template.json', text: ANA_TEXT, botName: 'Ana' });
        const refBody = bodyOf(sent.find(request => request.method === 'POST' && request.url.pathname === `/repos/${FORK}/git/refs`));
        const fileBody = bodyOf(sent.find(request => request.method === 'PUT' && request.url.pathname === `${FORK_FILES_PATH}/ana-template.json`));
        const indexBody = bodyOf(sent.find(request => request.method === 'PUT' && request.url.pathname === `${FORK_FILES_PATH}/index.json`));
        const pullBody = bodyOf(sent.find(request => request.method === 'POST' && request.url.pathname === `/repos/${REPO}/pulls`));
        const indexRows = JSON.parse(decodeContent(indexBody)) as unknown[];

        expect(url)
            .toBe('https://github.com/owner/templates/pull/7');
        expect(refBody)
            .toEqual({ ref: `refs/heads/${BRANCH}`, sha: 'gallery-head-sha' });
        expect(fileBody.branch)
            .toBe(BRANCH);
        expect(decodeContent(fileBody))
            .toBe(ANA_TEXT);
        expect(fileBody)
            .not.toHaveProperty('sha');
        expect(indexRows)
            .toEqual([{ ...ANA_ROW, file: 'ana-template.json' }]);
        expect(pullBody)
            .toMatchObject({ head: `bot-owner:${BRANCH}`, base: 'main' });
        expect(sent.every(request => request.token === 'fake-token-1' || (request.method === 'GET' && request.url.pathname === `/repos/${REPO}`)))
            .toBe(true);
        expect(sent.some(request => request.method === 'DELETE'))
            .toBe(false);
    });

    it('starts the branch at the gallery head, never at the fork head, and writes nothing to the fork default branch', async () => {
        const sent: GalleryRequest[] = [];
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub(shareRoutes(), sent), now: () => 1000, wait: () => Promise.resolve() });

        await gallery.openPullRequest({ token: 'fake-token-1', fileName: 'ana-template.json', text: ANA_TEXT, botName: 'Ana' });
        const refBody = bodyOf(sent.find(request => request.method === 'POST' && request.url.pathname === `/repos/${FORK}/git/refs`));
        const writes = sent.filter(request => request.method !== 'GET');

        expect(refBody)
            .toEqual({ ref: `refs/heads/${BRANCH}`, sha: 'gallery-head-sha' });
        expect(sent.some(request => request.url.pathname.endsWith('/merge-upstream')))
            .toBe(false);
        expect(writes.some(request => bodyOf(request).branch === 'main'))
            .toBe(false);
    });

    it('shares nothing when the gallery head cannot be read', async () => {
        const sent: GalleryRequest[] = [];
        const routes = replaceRoute(shareRoutes(), 'GET', `/repos/${REPO}/git/ref/heads/main`, { status: 500, text: '' });
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub(routes, sent), now: () => 1000, wait: () => Promise.resolve() });

        await expect(gallery.openPullRequest({ token: 'fake-token-1', fileName: 'ana-template.json', text: ANA_TEXT, botName: 'Ana' }))
            .rejects.toThrow('read the gallery head');
        expect(sent.some(request => request.method === 'POST' && request.url.pathname.endsWith('/git/refs')))
            .toBe(false);
    });

    it('replaces an existing file and keeps the other rows of the index', async () => {
        const sent: GalleryRequest[] = [];
        const otherRow = { ...ANA_ROW, file: 'other.json', name: 'Other' };
        const existingText = JSON.stringify([otherRow, { ...ANA_ROW, file: 'ana-template.json', name: 'Old Ana' }]);
        const existingBytes = Buffer.from(existingText);
        const existingIndex = existingBytes.toString('base64');
        let routes = replaceRoute(shareRoutes(), 'GET', `${FORK_FILES_PATH}/ana-template.json?ref=${BRANCH}`, { status: 200, text: JSON.stringify({ sha: 'old-blob' }) });

        routes = replaceRoute(routes, 'GET', `${FORK_FILES_PATH}/index.json?ref=${BRANCH}`, { status: 200, text: JSON.stringify({ sha: 'index-sha', content: existingIndex }) });
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub(routes, sent), now: () => 1000, wait: () => Promise.resolve() });

        await gallery.openPullRequest({ token: 'fake-token-1', fileName: 'ana-template.json', text: ANA_TEXT, botName: 'Ana' });
        const fileBody = bodyOf(sent.find(request => request.method === 'PUT' && request.url.pathname === `${FORK_FILES_PATH}/ana-template.json`));
        const indexBody = bodyOf(sent.find(request => request.method === 'PUT' && request.url.pathname === `${FORK_FILES_PATH}/index.json`));
        const indexRows = JSON.parse(decodeContent(indexBody)) as unknown[];

        expect(fileBody.sha)
            .toBe('old-blob');
        expect(indexBody.sha)
            .toBe('index-sha');
        expect(indexRows)
            .toEqual([otherRow, { ...ANA_ROW, file: 'ana-template.json' }]);
    });

    it('waits for a fork that is still being made, a few tries at most', async () => {
        const sent: GalleryRequest[] = [];
        const waits: number[] = [];
        const base = fakeGithub(shareRoutes(), sent);
        let refMisses = 2;
        const transport: GalleryTransport = (request) => {
            const isForkRef = request.url.pathname === `/repos/${FORK}/git/ref/heads/main`;

            if (isForkRef && refMisses > 0) {
                refMisses -= 1;

                return Promise.resolve({ status: 404, text: '' });
            }

            return base(request);
        };
        const gallery = new TemplateGallery({ repo: REPO, transport, now: () => 1000, wait: (ms) => {
            waits.push(ms);

            return Promise.resolve();
        } });

        const url = await gallery.openPullRequest({ token: 'fake-token-1', fileName: 'ana-template.json', text: ANA_TEXT, botName: 'Ana' });

        expect(url)
            .toBe('https://github.com/owner/templates/pull/7');
        expect(waits)
            .toHaveLength(2);
    });

    it('gives up on a fork that never answers, before any branch is made', async () => {
        const sent: GalleryRequest[] = [];
        const routes = replaceRoute(shareRoutes(), 'GET', `/repos/${FORK}/git/ref/heads/main`, { status: 404, text: '' });
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub(routes, sent), now: () => 1000, wait: () => Promise.resolve() });

        await expect(gallery.openPullRequest({ token: 'fake-token-1', fileName: 'ana-template.json', text: ANA_TEXT, botName: 'Ana' }))
            .rejects
            .toThrow('GitHub is still making your fork of the gallery');
        expect(sent.some(request => request.method === 'POST' && request.url.pathname.endsWith('/git/refs')))
            .toBe(false);
    });

    it('removes the new branch when a later step fails', async () => {
        const sent: GalleryRequest[] = [];
        const routes = replaceRoute(shareRoutes(), 'PUT', `${FORK_FILES_PATH}/ana-template.json`, { status: 500, text: '' });
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub(routes, sent), now: () => 1000, wait: () => Promise.resolve() });

        await expect(gallery.openPullRequest({ token: 'fake-token-1', fileName: 'ana-template.json', text: ANA_TEXT, botName: 'Ana' }))
            .rejects
            .toThrow('GitHub refused to add the file (status 500), so the template was not shared.');
        expect(sent.some(request => request.method === 'DELETE' && request.url.pathname === `/repos/${FORK}/git/refs/heads/${BRANCH}`))
            .toBe(true);
    });

    it('says which step GitHub refused, and that nothing was shared', async () => {
        const routes = replaceRoute(shareRoutes(), 'POST', `/repos/${FORK}/git/refs`, { status: 422, text: '' });
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub(routes, []), now: () => 1000, wait: () => Promise.resolve() });

        await expect(gallery.openPullRequest({ token: 'fake-token-1', fileName: 'ana-template.json', text: ANA_TEXT, botName: 'Ana' }))
            .rejects
            .toThrow('GitHub refused to create the branch (status 422), so the template was not shared.');
    });

    it('tells the owner to wait when GitHub limits the fork', async () => {
        const routes = replaceRoute(shareRoutes(), 'POST', `/repos/${REPO}/forks`, { status: 403, text: '' });
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub(routes, []), now: () => 1000, wait: () => Promise.resolve() });

        await expect(gallery.openPullRequest({ token: 'fake-token-1', fileName: 'ana-template.json', text: ANA_TEXT, botName: 'Ana' }))
            .rejects
            .toThrow(LIMIT_MESSAGE);
    });
});

describe('TemplateGallery approval cards', () => {
    it('approves the card once for the digest it showed', () => {
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub([], []), now: () => 1000 });

        gallery.rememberCard('install\nbot-1\nana-mail.json', 'digest-a');

        expect(gallery.takeCard('install\nbot-1\nana-mail.json', 'digest-a'))
            .toBe('approved');
        expect(gallery.takeCard('install\nbot-1\nana-mail.json', 'digest-a'))
            .toBe('expired');
    });

    it('reports a changed template and removes the card, so the owner must ask again', () => {
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub([], []), now: () => 1000 });

        gallery.rememberCard('share\nbot-1', 'digest-a');

        expect(gallery.takeCard('share\nbot-1', 'digest-b'))
            .toBe('changed');
        expect(gallery.takeCard('share\nbot-1', 'digest-a'))
            .toBe('expired');
    });

    it('reports an expired card after ten minutes', () => {
        let clock = 1000;
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub([], []), now: () => clock });

        gallery.rememberCard('share\nbot-1', 'digest-a');
        clock += 10 * 60 * 1000 + 1;

        expect(gallery.takeCard('share\nbot-1', 'digest-a'))
            .toBe('expired');
    });

    it('keeps the cards of two keys apart', () => {
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub([], []), now: () => 1000 });

        gallery.rememberCard('install\nbot-1\na.json', 'digest-a');

        expect(gallery.takeCard('install\nbot-1\nb.json', 'digest-a'))
            .toBe('expired');
        expect(gallery.takeCard('install\nbot-1\na.json', 'digest-a'))
            .toBe('approved');
    });

    it('refuses a card with other content while one waits, so the answer to the first never approves the second', () => {
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub([], []), now: () => 1000 });

        expect(gallery.rememberCard('install\nbot-1\na.json', 'digest-a'))
            .toBe(true);
        expect(gallery.rememberCard('install\nbot-1\na.json', 'digest-b'))
            .toBe(false);
        expect(gallery.rememberCard('install\nbot-1\na.json', 'digest-a'))
            .toBe(true);
        // The owner approves the first card, but the file now has the second content.
        expect(gallery.takeCard('install\nbot-1\na.json', 'digest-b'))
            .toBe('changed');
    });

    it('takes a card with other content once the waiting one has expired', () => {
        let clock = 1000;
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub([], []), now: () => clock });

        gallery.rememberCard('share\nbot-1', 'digest-a');
        clock += 10 * 60 * 1000 + 1;

        expect(gallery.rememberCard('share\nbot-1', 'digest-b'))
            .toBe(true);
        expect(gallery.takeCard('share\nbot-1', 'digest-b'))
            .toBe('approved');
    });
});

describe('readGalleryRepo', () => {
    it('uses the public gallery when nothing is set', () => {
        expect(readGalleryRepo(undefined))
            .toBe('mateuscmtropical/cloudbot-templates');
        expect(readGalleryRepo('  '))
            .toBe('mateuscmtropical/cloudbot-templates');
    });

    it('takes owner/name and refuses anything else', () => {
        expect(readGalleryRepo(' someone/fork-of-templates '))
            .toBe('someone/fork-of-templates');
        expect(() => readGalleryRepo('https://github.com/someone/fork'))
            .toThrow('owner/name');
        expect(() => readGalleryRepo('no-slash'))
            .toThrow('owner/name');
    });

    it('refuses dot segments, which would point the requests somewhere else', () => {
        expect(() => readGalleryRepo('owner/..'))
            .toThrow('owner/name');
        expect(() => readGalleryRepo('../templates'))
            .toThrow('owner/name');
        expect(() => readGalleryRepo('./templates'))
            .toThrow('owner/name');
    });
});
