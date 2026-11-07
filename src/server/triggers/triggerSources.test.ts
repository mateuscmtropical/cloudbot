import { describe, expect, it } from 'vitest';

import { findTriggerSource } from './triggerSources.ts';
import type { SourceDeps } from './triggerSources.ts';

function createDeps(answers: Record<string, unknown>, calls: { url: string; token: string | undefined }[] = []): SourceDeps {
    return {
        getJson: (url, token) => {
            calls.push({ url, token });

            const key = Object.keys(answers)
                .find(candidate => url.includes(candidate));

            return key === undefined ? Promise.reject(new Error('No answer')) : Promise.resolve(answers[key]);
        },
        githubToken: () => 'ghp_fake',
        googleToken: () => Promise.resolve('google_fake'),
    };
}

const ISSUES = [
    { number: 12, title: 'Crash on start', user: { login: 'ana' }, body: 'It breaks\nnow', html_url: 'https://github.com/o/r/issues/12' },
    { number: 11, title: 'A pull request', user: { login: 'bob' }, pull_request: {}, html_url: 'https://github.com/o/r/pull/11' },
    { number: 10, title: 'Old', user: { login: 'cy' }, body: null, html_url: 'https://github.com/o/r/issues/10' },
];

describe('github sources', () => {
    it('records the baseline without events and then returns only unseen issues, not pull requests', async () => {
        const source = findTriggerSource('github_issues');
        const calls: { url: string; token: string | undefined }[] = [];
        const deps = createDeps({ '/issues': ISSUES }, calls);

        const baseline = await source?.poll('o/r', undefined, 'bot', deps);

        expect(baseline?.events)
            .toEqual([]);
        expect(baseline?.ids)
            .toEqual(['12', '10']);
        expect(calls[0]?.token)
            .toBe('ghp_fake');

        const later = await source?.poll('o/r', new Set(['10']), 'bot', deps);

        expect(later?.events)
            .toEqual([{ id: '12', text: 'Issue #12 "Crash on start" by ana: It breaks now https://github.com/o/r/issues/12' }]);
    });

    it('lists pull requests from the pulls endpoint', async () => {
        const source = findTriggerSource('github_pulls');
        const deps = createDeps({ '/pulls': [ISSUES[1]] });
        const result = await source?.poll('o/r', new Set(), 'bot', deps);

        expect(result?.events.map(event => event.id))
            .toEqual(['11']);
    });

    it('refuses a target that is not owner/repo', () => {
        const source = findTriggerSource('github_issues');

        expect(source?.checkTarget('o/r'))
            .toBeUndefined();
        expect(source?.checkTarget('../x'))
            .toBeDefined();
        expect(source?.checkTarget('o/r/extra'))
            .toBeDefined();
        expect(source?.checkTarget('https://github.com/o/r'))
            .toBeDefined();
    });
});

describe('gmail source', () => {
    const answers = {
        'messages?': { messages: [{ id: 'm2' }, { id: 'm1' }] },
        '/m2?': { snippet: 'Hello\nthere', payload: { headers: [{ name: 'From', value: 'Ana <a@example.com>' }, { name: 'Subject', value: 'Hi' }] } },
    };

    it('reads details only for unseen mail', async () => {
        const source = findTriggerSource('gmail');
        const calls: { url: string; token: string | undefined }[] = [];
        const deps = createDeps(answers, calls);
        const result = await source?.poll('from:a@example.com', new Set(['m1']), 'bot', deps);

        expect(result?.events)
            .toEqual([{ id: 'm2', text: 'From Ana <a@example.com>, subject "Hi": Hello there' }]);
        expect(calls.map(call => call.token))
            .toEqual(['google_fake', 'google_fake']);
        expect(calls[0]?.url)
            .toContain('q=from%3Aa%40example.com');
    });

    it('does not read any message on the baseline', async () => {
        const calls: { url: string; token: string | undefined }[] = [];
        const result = await findTriggerSource('gmail')
            ?.poll('', undefined, 'bot', createDeps(answers, calls));

        expect(result?.ids)
            .toEqual(['m2', 'm1']);
        expect(calls)
            .toHaveLength(1);
    });

    it('is not ready without the Gmail app', async () => {
        const deps = { ...createDeps({}), googleToken: () => Promise.resolve(undefined) };

        expect(await findTriggerSource('gmail')
            ?.checkReady('bot', deps))
            .toContain('not connected');
    });
});
