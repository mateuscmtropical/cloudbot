import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { buildReviewPrompt, createToolCallReviewer, parseModelAnswer } from './createToolCallReviewer.ts';
import type { ToolCallReviewer } from './ApprovalGate.ts';
import type { ReviewContext, ReviewModel } from './createToolCallReviewer.ts';
import type { ChangeCard, ChangeMode } from '../integrations/IntegrationService.ts';

const CONTEXT: ReviewContext = {
    ownerRules: ['Never email my boss.'],
    recentMessages: ['Owner: tidy my downloads folder'],
    workspaceDir: '/var/lib/cloudbot-workspaces/bot-1',
};
const BASH_CALL = { toolName: 'Bash', input: { command: 'ls' } };

interface ApprovalCategoryCase {
    name: string;
    category: string;
    toolName: string;
    input: unknown;
}

interface HarmlessReviewCase {
    name: string;
    toolName: string;
    input: unknown;
}

const APPROVAL_CATEGORY_CASES: ApprovalCategoryCase[] = [
    { name: 'messages', category: 'send_message', toolName: 'Bash', input: { command: 'echo local' } },
    { name: 'purchases', category: 'purchase', toolName: 'Bash', input: { command: 'echo local' } },
    { name: 'bookings', category: 'booking', toolName: 'Bash', input: { command: 'echo local' } },
    { name: 'git pushes and remote service writes', category: 'remote_write', toolName: 'Bash', input: { command: 'git push origin main' } },
    { name: 'deleting or overwriting outside the workspace', category: 'outside_workspace_change', toolName: 'Write', input: { file_path: '/etc/service.conf', content: 'changed' } },
    { name: 'system package installs and sudo', category: 'system_change', toolName: 'Bash', input: { command: 'sudo apt-get install example' } },
    { name: 'new connectors', category: 'connector_change', toolName: 'mcp__future__connect_account', input: {} },
    { name: 'rule, limit and provider changes', category: 'owner_setting_change', toolName: 'Bash', input: { command: 'echo local' } },
];
const OWNER_ASKED_CASES = APPROVAL_CATEGORY_CASES.filter(testCase => testCase.category !== 'purchase' && testCase.category !== 'booking');
const DENIED_CATEGORY_CASES: ApprovalCategoryCase[] = [
    ...APPROVAL_CATEGORY_CASES,
    { name: 'a sensitive message', category: 'send_message', toolName: 'Bash', input: {} },
];

const HARMLESS_REVIEW_CASES: HarmlessReviewCase[] = [
    { name: 'a local read command', toolName: 'Bash', input: { command: 'git status' } },
    { name: 'a local build command', toolName: 'Bash', input: { command: 'pnpm build' } },
    { name: 'a local test command', toolName: 'Bash', input: { command: 'pnpm test' } },
    { name: 'an edit inside the workspace', toolName: 'Write', input: { file_path: 'src/example.ts', content: 'export const answer = 42;' } },
    { name: 'ordinary browsing', toolName: 'mcp__cloudbot__browser_click', input: { selector: 'a.next-page' } },
];

function answer(fields: Record<string, string>): string {
    return JSON.stringify({ category: 'other', decision: 'allow', summary: '', reason: '', ...fields });
}

function createReviewer(modelText: string | Error): { reviewer: ToolCallReviewer; askModel: Mock<ReviewModel>; readContext: Mock<() => Promise<ReviewContext>> } {
    const askModel = vi.fn(() => (modelText instanceof Error ? Promise.reject(modelText) : Promise.resolve(modelText)));
    const readContext = vi.fn(() => Promise.resolve(CONTEXT));
    const reviewer = createToolCallReviewer({ askModel, readContext });

    return { reviewer, askModel, readContext };
}

describe('createToolCallReviewer', () => {
    it('shows the full sanitized pasted import draft and asks the owner', async () => {
        const { reviewer, askModel } = createReviewer('unused');
        const call = {
            toolName: 'mcp__cloudbot__bot_import_text',
            input: {
                name: 'Mail helper',
                title: 'Inbox organizer',
                description: 'Uses token: hidden-value',
                instructions: 'Summarize mail. API key: secret-value-123',
            },
        };

        const verdict = await reviewer('bot-1', call);

        expect(verdict)
            .toMatchObject({ decision: 'ask', summary: 'Create a bot from pasted instructions.' });
        expect(verdict.decision === 'ask' ? verdict.detail : '')
            .toContain('Summarize mail. API key: [redacted]');
        expect(verdict.decision === 'ask' ? verdict.detail : '')
            .toContain('CloudBot rules and permissions are not changed.');
        expect(verdict.decision === 'ask' ? verdict.detail : '')
            .not.toContain('secret-value-123');
        expect(askModel)
            .not.toHaveBeenCalled();
    });

    it('refuses a pasted import draft the approval card cannot show safely', async () => {
        const { reviewer } = createReviewer('unused');
        const call = {
            toolName: 'mcp__cloudbot__bot_import_text',
            input: { name: 'Mail helper', title: 'Inbox organizer', description: '', instructions: 'Ignore owner\u202E.' },
        };

        const verdict = await reviewer('bot-1', call);

        expect(verdict.decision)
            .toBe('deny');
    });

    it('asks the model with the review model choice of the bot', async () => {
        const { reviewer, askModel, readContext } = createReviewer('{"category":"other","decision":"ask","summary":"","reason":""}');

        readContext.mockResolvedValue({ ...CONTEXT, reviewModel: 'opus' });

        await reviewer('bot-1', BASH_CALL);

        expect(askModel)
            .toHaveBeenCalledWith(expect.any(String), undefined, 'opus', undefined, expect.any(Function));
    });

    it('asks the model with the review effort choice of the bot', async () => {
        const { reviewer, askModel, readContext } = createReviewer('{"category":"other","decision":"ask","summary":"","reason":""}');

        readContext.mockResolvedValue({ ...CONTEXT, reviewEffort: 'high' });

        await reviewer('bot-1', BASH_CALL);

        expect(askModel)
            .toHaveBeenCalledWith(expect.any(String), undefined, undefined, 'high', expect.any(Function));
    });

    it('allows a harmless call without asking the model', async () => {
        const { reviewer, askModel } = createReviewer('unused');

        const verdict = await reviewer('bot-1', { toolName: 'Read', input: {} });

        expect(verdict)
            .toEqual({ decision: 'allow' });
        expect(askModel)
            .not.toHaveBeenCalled();
    });

    it('always asks for a connector tool that sends, without asking the model', async () => {
        const { reviewer, askModel } = createReviewer('unused');

        const verdict = await reviewer('bot-1', { toolName: 'mcp__mail__send_email', input: {} });

        expect(verdict.decision)
            .toBe('ask');
        expect(askModel)
            .not.toHaveBeenCalled();
    });

    it('always asks for email with every recipient and the full approved text on the card', async () => {
        const { reviewer, askModel } = createReviewer('unused');
        const input = {
            to: ['to@example.com'],
            cc: ['cc@example.com'],
            bcc: ['bcc@example.com'],
            subject: 'Hello',
            text: 'The complete body.\nKeep every line.',
        };

        const verdict = await reviewer('bot-1', { toolName: 'mcp__cloudbot__email_send', input });

        expect(verdict)
            .toEqual({
                decision: 'ask',
                summary: 'Send an email.',
                detail: 'To: to@example.com\nCc: cc@example.com\nBcc: bcc@example.com\nSubject: "Hello"\n\nText:\nThe complete body.\nKeep every line.',
            });
        expect(askModel)
            .not.toHaveBeenCalled();
    });

    it('always asks before connecting an email account, without exposing a password', async () => {
        const { reviewer, askModel } = createReviewer('unused');

        const verdict = await reviewer('bot-1', {
            toolName: 'mcp__cloudbot__email_setup',
            input: {
                address: 'bot@example.com',
                username: 'bot-user',
                imapHost: 'imap.example.com',
                imapPort: 993,
                smtpHost: 'smtp.example.com',
                smtpPort: 465,
                smtpSecure: true,
            },
        });

        expect(verdict.decision)
            .toBe('ask');
        if (verdict.decision === 'ask') {
            expect(verdict.detail)
                .toContain('Address: bot@example.com');
            expect(verdict.detail)
                .toContain('IMAP: imap.example.com:993');
            expect(verdict.detail)
                .not.toContain('password-value');
        }
        expect(askModel)
            .not.toHaveBeenCalled();
    });

    it('asks for a private host the browser should reach, and names the host', async () => {
        const { reviewer, askModel } = createReviewer('unused');

        const verdict = await reviewer('bot-1', { toolName: 'mcp__cloudbot__browser_allow_host', input: { host: '10.0.0.5' } });

        expect(verdict)
            .toEqual({ decision: 'ask', summary: 'Let the browser reach the private host 10.0.0.5, any port.' });
        expect(askModel)
            .not.toHaveBeenCalled();
    });

    it('names the normalized host and the port on the card', async () => {
        const { reviewer } = createReviewer('unused');

        const verdict = await reviewer('bot-1', { toolName: 'mcp__cloudbot__browser_allow_host', input: { host: ' Intranet.Test. ', port: 8080 } });

        expect(verdict)
            .toEqual({ decision: 'ask', summary: 'Let the browser reach the private host intranet.test, port 8080.' });
    });

    it('asks before connecting a new app server without consulting the model', async () => {
        const { reviewer, askModel } = createReviewer('unused');

        const verdict = await reviewer('bot-1', { toolName: 'mcp__cloudbot__app_connect', input: {} });

        expect(verdict)
            .toEqual({ decision: 'ask', summary: 'Connect a new app server.' });
        expect(askModel)
            .not.toHaveBeenCalled();
    });

    it('asks before switching the bot to another provider without consulting the model', async () => {
        const { reviewer, askModel } = createReviewer('unused');

        const verdict = await reviewer('bot-1', { toolName: 'mcp__cloudbot__provider_use', input: { provider: 'chatgpt' } });

        expect(verdict)
            .toEqual({ decision: 'ask', summary: 'Switch this bot to another AI provider.' });
        expect(askModel)
            .not.toHaveBeenCalled();
    });

    it('allows a call the model allows', async () => {
        const { reviewer } = createReviewer(answer({ decision: 'allow' }));

        const verdict = await reviewer('bot-1', BASH_CALL);

        expect(verdict)
            .toEqual({ decision: 'allow' });
    });

    it.each(['purchase', 'booking'])('asks for the category %s even when the model allows', async (category) => {
        const { reviewer } = createReviewer(answer({ category, decision: 'allow', summary: 'Buy a ticket' }));

        const verdict = await reviewer('bot-1', BASH_CALL);

        expect(verdict)
            .toEqual({ decision: 'ask', summary: 'Buy a ticket' });
    });

    it.each(OWNER_ASKED_CASES)('runs $name when the model allows it, since the owner asked', async ({ category, toolName, input }) => {
        const { reviewer } = createReviewer(answer({ category, decision: 'allow', summary: 'Confirm this action.' }));

        const verdict = await reviewer('bot-1', { toolName, input });

        expect(verdict)
            .toEqual({ decision: 'allow' });
    });

    it.each(APPROVAL_CATEGORY_CASES)('asks before $name when the model asks', async ({ category, toolName, input }) => {
        const { reviewer } = createReviewer(answer({ category, decision: 'ask', summary: 'Confirm this action.' }));

        const verdict = await reviewer('bot-1', { toolName, input });

        expect(verdict)
            .toEqual({ decision: 'ask', summary: 'Confirm this action.' });
    });

    it.each(DENIED_CATEGORY_CASES)('keeps a deny for $name', async ({ category, toolName, input }) => {
        const { reviewer } = createReviewer(answer({ category, decision: 'deny', reason: 'An owner rule forbids it.' }));

        const verdict = await reviewer('bot-1', { toolName, input });

        expect(verdict)
            .toEqual({ decision: 'deny', reason: 'An owner rule forbids it.' });
    });

    it.each(HARMLESS_REVIEW_CASES)('allows $name without an approval card when the model allows it', async ({ toolName, input }) => {
        const { reviewer } = createReviewer(answer({ category: 'other', decision: 'allow' }));

        const verdict = await reviewer('bot-1', { toolName, input });

        expect(verdict)
            .toEqual({ decision: 'allow' });
    });

    it('uses a default summary when the model gives none', async () => {
        const { reviewer } = createReviewer(answer({ decision: 'ask' }));

        const verdict = await reviewer('bot-1', BASH_CALL);

        expect(verdict)
            .toEqual({ decision: 'ask', summary: 'Run Bash.' });
    });

    it('denies with the reason of the model', async () => {
        const { reviewer } = createReviewer(answer({ decision: 'deny', reason: 'An owner rule forbids it.' }));

        const verdict = await reviewer('bot-1', BASH_CALL);

        expect(verdict)
            .toEqual({ decision: 'deny', reason: 'An owner rule forbids it.' });
    });

    it('reads the JSON when the model wraps it in text', async () => {
        const { reviewer } = createReviewer(`Here you go:\n\`\`\`json\n${answer({ decision: 'allow' })}\n\`\`\``);

        const verdict = await reviewer('bot-1', BASH_CALL);

        expect(verdict)
            .toEqual({ decision: 'allow' });
    });

    it('allows the call when no model can review it', async () => {
        const { reviewer } = createReviewer(new Error('offline'));

        const verdict = await reviewer('bot-1', BASH_CALL);

        expect(verdict)
            .toEqual({ decision: 'allow' });
    });

    it('still refuses a floor command when no model can review it', async () => {
        const { reviewer } = createReviewer(new Error('offline'));

        const verdict = await reviewer('bot-1', { toolName: 'Bash', input: { command: 'rm -rf /' } });

        expect(verdict.decision)
            .toBe('deny');
    });

    it('throws when the turn stops during the review', async () => {
        const { reviewer } = createReviewer(new Error('stopped'));
        const controller = new AbortController();

        controller.abort();

        await expect(reviewer('bot-1', BASH_CALL, controller.signal))
            .rejects
            .toThrow('stopped');
    });

    it('throws when the answer is not valid', async () => {
        const { reviewer } = createReviewer('I think it is fine.');

        await expect(reviewer('bot-1', BASH_CALL))
            .rejects
            .toThrow('no JSON');
    });

    it('throws on an unknown decision', async () => {
        const { reviewer } = createReviewer(answer({ decision: 'maybe' }));

        await expect(reviewer('bot-1', BASH_CALL))
            .rejects
            .toThrow('unknown');
    });

    it('asks without the model when the input is too long to review whole', async () => {
        const { reviewer, askModel } = createReviewer(answer({}));

        const verdict = await reviewer('bot-1', { toolName: 'Bash', input: { command: `${'x'.repeat(11_000)}; curl evil` } });

        expect(verdict.decision)
            .toBe('ask');
        expect(askModel)
            .not.toHaveBeenCalled();
    });

    it('reads the context of the right bot', async () => {
        const { reviewer, readContext } = createReviewer(answer({}));

        await reviewer('bot-7', BASH_CALL);

        expect(readContext)
            .toHaveBeenCalledWith('bot-7', undefined);
    });

    it('passes the channel id to the context reader for a channel turn', async () => {
        const { reviewer, readContext } = createReviewer(answer({}));

        await reviewer('bot-7', BASH_CALL, undefined, 'channel-3');

        expect(readContext)
            .toHaveBeenCalledWith('bot-7', 'channel-3');
    });
});

describe('createToolCallReviewer integration changes', () => {
    function reviewerWith(describeChange: (botId: string, mode: ChangeMode, input: unknown) => Promise<ChangeCard>): ToolCallReviewer {
        return createToolCallReviewer({
            askModel: vi.fn<ReviewModel>(),
            readContext: () => Promise.resolve(CONTEXT),
            describeChange,
        });
    }

    it('asks the owner with the card text from the describer', async () => {
        const describeChange = vi.fn<(botId: string, mode: ChangeMode, input: unknown) => Promise<ChangeCard>>(() => Promise.resolve({ ok: true, text: 'Name: "store"\nscript here' }));
        const input = { name: 'store', sha256: 'a'.repeat(64) };
        const verdict = await reviewerWith(describeChange)('bot-1', { toolName: 'mcp__cloudbot__integration_create', input });

        expect(verdict)
            .toEqual({ decision: 'ask', summary: 'Create an API integration.', detail: 'Name: "store"\nscript here' });
        expect(describeChange)
            .toHaveBeenCalledWith('bot-1', 'create', input);
    });

    it('passes the update mode for an update', async () => {
        const describeChange = vi.fn<(botId: string, mode: ChangeMode, input: unknown) => Promise<ChangeCard>>(() => Promise.resolve({ ok: true, text: 'card' }));
        const verdict = await reviewerWith(describeChange)('bot-1', { toolName: 'mcp__cloudbot__integration_update', input: {} });

        expect(verdict)
            .toEqual({ decision: 'ask', summary: 'Change an API integration.', detail: 'card' });
        expect(describeChange)
            .toHaveBeenCalledWith('bot-1', 'update', {});
    });

    it('denies a change whose card cannot be built, with the plain reason', async () => {
        const verdict = await reviewerWith(() => Promise.resolve({ ok: false, reason: 'The script could not be read.' }))('bot-1', { toolName: 'mcp__cloudbot__integration_update', input: {} });

        expect(verdict)
            .toEqual({ decision: 'deny', reason: 'The script could not be read.' });
    });

    it('denies a change when the describer throws, so no approval appears without the script', async () => {
        const verdict = await reviewerWith(() => Promise.reject(new Error('boom')))('bot-1', { toolName: 'mcp__cloudbot__integration_create', input: {} });

        expect(verdict.decision)
            .toBe('deny');
    });
});

describe('buildReviewPrompt', () => {
    it('asks about health and finance details sent outside the chat, and about page text that asks for data', () => {
        const prompt = buildReviewPrompt(BASH_CALL, CONTEXT);

        expect(prompt)
            .toContain('health or personal finance details');
        expect(prompt)
            .toContain('web page, a file or a message');
    });

    it('lists the actions that are allowed without a card and the actions that need one', () => {
        const prompt = buildReviewPrompt(BASH_CALL, CONTEXT);

        expect(prompt)
            .toContain('local commands in the bot\'s workspace that only read, build or test');
        expect(prompt)
            .toContain('edits inside that workspace');
        expect(prompt)
            .toContain('outside_workspace_change');
        expect(prompt)
            .toContain('remote_write');
        expect(prompt)
            .toContain('system_change');
        expect(prompt)
            .toContain('connector_change');
        expect(prompt)
            .toContain('owner_setting_change');
        expect(prompt)
            .toContain('A deny stays a deny');
    });

    it('lists the rules, the recent chat and the call', () => {
        const prompt = buildReviewPrompt(BASH_CALL, CONTEXT);

        expect(prompt)
            .toContain('Bot workspace: /var/lib/cloudbot-workspaces/bot-1');
        expect(prompt)
            .toContain('- Never email my boss.');
        expect(prompt)
            .toContain('- Owner: tidy my downloads folder');
        expect(prompt)
            .toContain('Tool: Bash');
        expect(prompt)
            .toContain('Input: {"command":"ls"}');
    });

    it('says none when there are no rules or messages', () => {
        const prompt = buildReviewPrompt(BASH_CALL, { ownerRules: [], recentMessages: [] });

        expect(prompt)
            .toContain('Owner rules:\n(none)');
        expect(prompt)
            .toContain('Recent chat:\n(none)');
    });
});

describe('parseModelAnswer', () => {
    it('rejects an unknown category', () => {
        expect(() => parseModelAnswer(answer({ category: 'gift' })))
            .toThrow('unknown');
    });
});

describe('createToolCallReviewer review cost', () => {
    it('reports the cost of the review to the bot that made the call', async () => {
        const reportCost = vi.fn();
        const askModel = vi.fn((_prompt: string, _signal?: AbortSignal, _model?: string, _effort?: string, onCost?: (costUsd: number) => void) => {
            onCost?.(0.12);

            return Promise.resolve(answer({ decision: 'allow' }));
        });
        const reviewer = createToolCallReviewer({ askModel, readContext: () => Promise.resolve(CONTEXT), reportCost });

        const turnSignal = new AbortController().signal;

        await reviewer('bot-3', BASH_CALL, turnSignal);

        expect(reportCost)
            .toHaveBeenCalledWith('bot-3', 0.12, turnSignal);
    });

    it('gives the review model the signal of the turn, so a stop cancels the review', async () => {
        const { reviewer, askModel } = createReviewer(answer({ decision: 'allow' }));
        const turnSignal = new AbortController().signal;

        await reviewer('bot-1', BASH_CALL, turnSignal);

        expect(askModel)
            .toHaveBeenCalledWith(expect.any(String), turnSignal, undefined, undefined, expect.any(Function));
    });
});

describe('browser target', () => {
    it('adds the page and element of a browser call to the prompt as data', async () => {
        const askModel = vi.fn<ReviewModel>(() => Promise.resolve(answer({})));
        const describeBrowserTarget = vi.fn(() => Promise.resolve('Page: https://chat.example/\nElement: row "Ana Silva"'));
        const reviewer = createToolCallReviewer({ askModel, readContext: () => Promise.resolve(CONTEXT), describeBrowserTarget });
        const call = { toolName: 'mcp__cloudbot__browser_click', input: { element: 41 } };

        await expect(reviewer('bot-1', call)).resolves.toEqual({ decision: 'allow' });
        expect(describeBrowserTarget)
            .toHaveBeenCalledWith(call);
        expect(askModel.mock.calls[0]?.[0])
            .toContain('Browser target:\nPage: https://chat.example/\nElement: row "Ana Silva"');
    });

    it('leaves the target out when the tool hits no browser element', () => {
        const prompt = buildReviewPrompt(BASH_CALL, CONTEXT);

        expect(prompt)
            .not.toContain('Browser target:\n');
        expect(prompt)
            .toContain('When the target is unknown, allow the call unless');
    });
});
