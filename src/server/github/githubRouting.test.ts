import { describe, expect, it } from 'vitest';

import type { BotSecret } from '../secrets/BotSecrets.ts';
import {
    GITHUB_SITE,
    buildGithubEnvironment,
    buildUpstreamHeaders,
    classifyGithubRequest,
    readGithubToken,
} from './githubRouting.ts';
import type { GithubClassification, GithubPlan } from './githubRouting.ts';

const EMPTY_BODY = Buffer.alloc(0);
const TOKEN = 'ghp_TEST_TOKEN_VALUE';
const ZERO_HASH = '0'.repeat(40);
const OLD_HASH = 'a'.repeat(40);
const NEW_HASH = 'b'.repeat(40);
const CARD_LIMIT = 6000;

function requirePlan(classification: GithubClassification): GithubPlan {
    if (!classification.isAllowed) {
        throw new Error(`Expected the request to be allowed, but it was refused: ${classification.reason}`);
    }

    return classification.plan;
}

// A pkt-line: four hex digits that count themselves and the payload, then the payload.
function pktLine(payload: string): string {
    const lengthHex = (payload.length + 4).toString(16)
        .padStart(4, '0');

    return `${lengthHex}${payload}`;
}

// The ref commands of a push, the flush packet, then a stand-in for the pack.
function pushBody(commandLines: string[]): Buffer {
    const commandText = commandLines.map(line => pktLine(`${line}\n`))
        .join('');

    return Buffer.from(`${commandText}0000PACK-DATA`);
}

function graphqlBody(query: string, extra: Record<string, unknown> = {}): Buffer {
    return Buffer.from(JSON.stringify({ query, ...extra }));
}

describe('classifyGithubRequest', () => {
    it('lets a clone or fetch through without a card', () => {
        const advertisement = requirePlan(classifyGithubRequest('GET', '/owner/repo.git/info/refs?service=git-upload-pack', EMPTY_BODY));
        const upload = requirePlan(classifyGithubRequest('POST', '/owner/repo.git/git-upload-pack', Buffer.from('0000')));

        expect(advertisement.isWrite)
            .toBe(false);
        expect(advertisement.upstream.href)
            .toBe('https://github.com/owner/repo.git/info/refs?service=git-upload-pack');
        expect(upload.isWrite)
            .toBe(false);
        expect(upload.isGit)
            .toBe(true);
    });

    it('lists each ref of a push, marked create, update or delete', () => {
        const body = pushBody([
            `${ZERO_HASH} ${NEW_HASH} refs/heads/new-branch\0report-status side-band-64k`,
            `${OLD_HASH} ${NEW_HASH} refs/heads/main`,
            `${OLD_HASH} ${ZERO_HASH} refs/heads/old-branch`,
        ]);
        const push = requirePlan(classifyGithubRequest('POST', '/owner/repo/git-receive-pack', body));

        expect(push.isWrite)
            .toBe(true);
        expect(push.summary)
            .toBe('Push commits to owner/repo on GitHub.');
        expect(push.detail)
            .toBe([
                'Refs to change:',
                'create refs/heads/new-branch at bbbbbbb',
                'update refs/heads/main from aaaaaaa to bbbbbbb',
                'delete refs/heads/old-branch',
            ].join('\n'));
    });

    it('refuses a push whose command section cannot be read', () => {
        const classification = classifyGithubRequest('POST', '/owner/repo/git-receive-pack', Buffer.from('not a pkt-line body'));

        expect(classification.isAllowed)
            .toBe(false);
        expect(classification)
            .toMatchObject({ statusCode: 403 });
    });

    it('refuses a push with no ref command', () => {
        const classification = classifyGithubRequest('POST', '/owner/repo/git-receive-pack', Buffer.from('0000PACK-DATA'));

        expect(classification)
            .toMatchObject({ isAllowed: false, statusCode: 403 });
    });

    it('marks pushes and the push advertisement as needing a token', () => {
        const advertisement = requirePlan(classifyGithubRequest('GET', '/owner/repo.git/info/refs?service=git-receive-pack', EMPTY_BODY));
        const clone = requirePlan(classifyGithubRequest('GET', '/owner/repo.git/info/refs?service=git-upload-pack', EMPTY_BODY));

        expect(advertisement.needsToken)
            .toBe(true);
        expect(clone.needsToken)
            .toBe(false);
    });

    it('refuses git paths with the wrong method', () => {
        expect(classifyGithubRequest('POST', '/owner/repo.git/info/refs', EMPTY_BODY).isAllowed)
            .toBe(false);
        expect(classifyGithubRequest('GET', '/owner/repo.git/git-receive-pack', EMPTY_BODY).isAllowed)
            .toBe(false);
    });

    it('maps the REST API under /api/v3 to api.github.com', () => {
        const read = requirePlan(classifyGithubRequest('GET', '/api/v3/repos/owner/repo?x=1', EMPTY_BODY));

        expect(read.upstream.href)
            .toBe('https://api.github.com/repos/owner/repo?x=1');
        expect(read.isWrite)
            .toBe(false);
    });

    it('asks for a card before a REST write, with the method, path and whole body', () => {
        const body = Buffer.from(JSON.stringify({ title: 'Fix the   build\nnow', body: 'details' }));
        const pullRequest = requirePlan(classifyGithubRequest('POST', '/api/v3/repos/owner/repo/pulls', body));

        expect(pullRequest.isWrite)
            .toBe(true);
        expect(pullRequest.summary)
            .toBe('Open a pull request in owner/repo titled "Fix the build now".');
        expect(pullRequest.detail)
            .toBe(`POST /repos/owner/repo/pulls\n\n${body.toString('utf8')}`);
    });

    it('shows the method and path of a PATCH on the repository', () => {
        const patch = requirePlan(classifyGithubRequest('PATCH', '/api/v3/repos/owner/repo', Buffer.from('{"private":true}')));

        expect(patch.summary)
            .toBe('Send a PATCH request to GitHub at /repos/owner/repo.');
        expect(patch.detail?.split('\n')[0])
            .toBe('PATCH /repos/owner/repo');
    });

    it('shows the query of a REST write on the card, still percent encoded', () => {
        const patch = requirePlan(classifyGithubRequest('PATCH', '/api/v3/repos/owner/repo?private=false', EMPTY_BODY));
        const encoded = requirePlan(classifyGithubRequest('PATCH', '/api/v3/repos/owner/repo?name=a%E2%80%AEb', EMPTY_BODY));

        expect(patch.detail)
            .toBe('PATCH /repos/owner/repo?private=false');
        expect(encoded.detail)
            .toBe('PATCH /repos/owner/repo?name=a%E2%80%AEb');
    });

    it('refuses a REST write whose card is over the limit, instead of cutting it', () => {
        const body = Buffer.from(JSON.stringify({ body: 'x'.repeat(CARD_LIMIT) }));

        expect(classifyGithubRequest('POST', '/api/v3/repos/owner/repo/issues/1/comments', body))
            .toMatchObject({ isAllowed: false, statusCode: 403 });
    });

    it('describes reviews, comments and other REST writes', () => {
        const review = requirePlan(classifyGithubRequest('POST', '/api/v3/repos/o/r/pulls/7/reviews', Buffer.from('{}')));
        const comment = requirePlan(classifyGithubRequest('POST', '/api/v3/repos/o/r/issues/3/comments', Buffer.from('{}')));
        const other = requirePlan(classifyGithubRequest('DELETE', '/api/v3/repos/o/r/git/refs/heads/x', EMPTY_BODY));

        expect(review.summary)
            .toBe('Post a review on pull request #7 in o/r.');
        expect(comment.summary)
            .toBe('Post a comment on #3 in o/r.');
        expect(other.summary)
            .toBe('Send a DELETE request to GitHub at /repos/o/r/git/refs/heads/x.');
    });

    it('lets GraphQL queries through without a card', () => {
        const query = graphqlBody('query { viewer { login } }');

        expect(requirePlan(classifyGithubRequest('POST', '/api/graphql', query)).isWrite)
            .toBe(false);
    });

    it('gives every GraphQL mutation the same plain summary, and shows the whole query and variables', () => {
        const mutation = graphqlBody(
            'mutation($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { number } } }',
            { variables: { input: { title: 'Add tests' } } },
        );
        const plan = requirePlan(classifyGithubRequest('POST', '/api/graphql', mutation));

        expect(plan.isWrite)
            .toBe(true);
        expect(plan.summary)
            .toBe('Run a change on GitHub (GraphQL).');
        expect(plan.detail)
            .toContain('createPullRequest(input: $input)');
        expect(plan.detail)
            .toContain('"title": "Add tests"');
        expect(plan.upstream.href)
            .toBe('https://api.github.com/graphql');
    });

    it('does not let a comment in the query change the summary', () => {
        const spoofed = graphqlBody('mutation { deleteRepository(input: {}) } # createPullRequest "title": "Fine"');
        const plan = requirePlan(classifyGithubRequest('POST', '/api/graphql', spoofed));

        expect(plan.summary)
            .toBe('Run a change on GitHub (GraphQL).');
    });

    it('refuses a GraphQL mutation whose query and variables are over the limit', () => {
        const big = graphqlBody(`mutation { addComment(input: {body: "${'x'.repeat(CARD_LIMIT)}"}) { clientMutationId } }`);

        expect(classifyGithubRequest('POST', '/api/graphql', big))
            .toMatchObject({ isAllowed: false, statusCode: 403 });
    });

    it('refuses a GraphQL mutation with a control, bidi or zero-width character', () => {
        ['\u0007', '‮', '​', '\r'].forEach((hidden) => {
            const body = graphqlBody(`mutation { addComment(input: {body: "x${hidden}"}) { clientMutationId } }`);

            expect(classifyGithubRequest('POST', '/api/graphql', body))
                .toMatchObject({ isAllowed: false, statusCode: 403 });
        });
    });

    it('allows line feeds and tabs in a GraphQL mutation', () => {
        const body = graphqlBody('mutation {\n\taddComment(input: {body: "x"}) { clientMutationId }\n}');

        expect(requirePlan(classifyGithubRequest('POST', '/api/graphql', body)).isWrite)
            .toBe(true);
    });

    it('refuses a GraphQL body it cannot read, since the owner could not see it', () => {
        expect(classifyGithubRequest('POST', '/api/graphql', Buffer.from('not json')))
            .toMatchObject({ isAllowed: false, statusCode: 403 });
    });

    it('sends GraphQL to the exact endpoint, without the query string of the request', () => {
        const plan = requirePlan(classifyGithubRequest('POST', '/api/graphql?x=1', graphqlBody('query { viewer { login } }')));

        expect(plan.upstream.href)
            .toBe('https://api.github.com/graphql');
    });

    it('refuses every address that is not git, REST or GraphQL', () => {
        ['/', '/evil.example/x', '//evil.example/x', '/api/v3/../../other', '/owner/repo/info/refs/extra'].forEach((target) => {
            const classification = classifyGithubRequest('GET', target, EMPTY_BODY);

            expect(classification.isAllowed)
                .toBe(false);
        });
    });

    it('sends every allowed request to one of the two GitHub hosts', () => {
        const targets: { method: string; target: string; body: Buffer }[] = [
            { method: 'GET', target: '/owner/repo.git/info/refs', body: EMPTY_BODY },
            { method: 'POST', target: '/owner/repo.git/git-receive-pack', body: pushBody([`${ZERO_HASH} ${NEW_HASH} refs/heads/x`]) },
            { method: 'GET', target: '/api/v3/user', body: EMPTY_BODY },
            { method: 'POST', target: '/api/graphql', body: graphqlBody('query { viewer { login } }') },
        ];
        const origins = targets.map(({ method, target, body }) => requirePlan(classifyGithubRequest(method, target, body)).upstream.origin);

        expect(origins.every(origin => origin === 'https://github.com' || origin === 'https://api.github.com'))
            .toBe(true);
    });
});

describe('buildUpstreamHeaders', () => {
    it('replaces the agent header with the token for the API', () => {
        const headers = buildUpstreamHeaders({ authorization: 'token agent-value', accept: 'application/json', host: '127.0.0.1' }, TOKEN, false);

        expect(headers.authorization)
            .toBe(`Bearer ${TOKEN}`);
        expect(headers.accept)
            .toBe('application/json');
        expect(headers.host)
            .toBeUndefined();
    });

    it('sends the token to git as basic auth', () => {
        const headers = buildUpstreamHeaders({}, TOKEN, true);
        const expected = Buffer.from(`x-access-token:${TOKEN}`)
            .toString('base64');

        expect(headers.authorization)
            .toBe(`Basic ${expected}`);
    });

    it('sends no authorization header when no token is saved', () => {
        const headers = buildUpstreamHeaders({ authorization: 'token agent-value' }, undefined, false);

        expect(headers.authorization)
            .toBeUndefined();
    });

    it('drops method override headers and expect', () => {
        const headers = buildUpstreamHeaders({
            'x-http-method-override': 'DELETE',
            'x-method-override': 'DELETE',
            'x-http-method': 'DELETE',
            'expect': '100-continue',
            'accept': 'application/json',
        }, TOKEN, false);

        expect(headers['x-http-method-override'])
            .toBeUndefined();
        expect(headers['x-method-override'])
            .toBeUndefined();
        expect(headers['x-http-method'])
            .toBeUndefined();
        expect(headers.expect)
            .toBeUndefined();
        expect(headers.accept)
            .toBe('application/json');
    });
});

describe('buildGithubEnvironment', () => {
    it('points gh and git at the bot listener, and trusts only its certificate for git', () => {
        const environment = buildGithubEnvironment({ port: 40123, caFile: '/tmp/cloudbot-github-ca-x/ca.pem', bundleFile: '/tmp/cloudbot-github-ca-x/bundle.pem' });

        expect(environment.GH_HOST)
            .toBe('127.0.0.1:40123');
        expect(environment.GIT_CONFIG_KEY_0)
            .toBe('url.https://127.0.0.1:40123/.insteadOf');
        expect(environment.GIT_CONFIG_VALUE_0)
            .toBe('https://github.com/');
        expect(environment.GIT_CONFIG_KEY_2)
            .toBe('http.https://127.0.0.1:40123/.sslCAInfo');
        expect(environment.GIT_CONFIG_VALUE_2)
            .toBe('/tmp/cloudbot-github-ca-x/ca.pem');
        expect(environment.GIT_CONFIG_COUNT)
            .toBe('3');
    });

    it('points SSL_CERT_FILE at the bundle, so other tools keep the system roots', () => {
        const environment = buildGithubEnvironment({ port: 40123, caFile: '/tmp/x/ca.pem', bundleFile: '/tmp/x/bundle.pem' });

        expect(environment.SSL_CERT_FILE)
            .toBe('/tmp/x/bundle.pem');
    });
});

describe('readGithubToken', () => {
    function fakeSecrets(secret: BotSecret | undefined): Pick<Parameters<typeof readGithubToken>[0], 'read'> {
        return { read: () => secret };
    }

    it('returns the token when it is saved for GitHub', () => {
        expect(readGithubToken(fakeSecrets({ site: GITHUB_SITE, value: TOKEN }), 'bot-1'))
            .toBe(TOKEN);
    });

    it('returns undefined when no token is saved', () => {
        expect(readGithubToken(fakeSecrets(undefined), 'bot-1'))
            .toBeUndefined();
    });

    it('refuses a token saved for another site', () => {
        expect(() => readGithubToken(fakeSecrets({ site: 'https://example.com', value: TOKEN }), 'bot-1'))
            .toThrow('another site');
    });
});
