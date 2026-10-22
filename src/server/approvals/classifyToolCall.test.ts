import { describe, expect, it } from 'vitest';

import { classifyToolCall } from './classifyToolCall.ts';

function classify(toolName: string): string {
    return classifyToolCall({ toolName, input: {} });
}

describe('channel changes', () => {
    it('makes the owner approve each change of who takes part in a channel', () => {
        expect(classify('mcp__cloudbot__channel_create'))
            .toBe('always-ask');
        expect(classify('mcp__cloudbot__channel_add'))
            .toBe('always-ask');
        expect(classify('mcp__cloudbot__channel_set_manager'))
            .toBe('always-ask');
        expect(classify('mcp__cloudbot__channel_remove'))
            .toBe('always-ask');
        expect(classify('mcp__cloudbot__channel_delete'))
            .toBe('always-ask');
    });

    it('does not ask the owner to list the channels of the bot', () => {
        expect(classify('mcp__cloudbot__channel_list'))
            .toBe('skip');
    });
});

describe('models_set', () => {
    it('is reviewed, so the review agent sees a change of models', () => {
        expect(classify('mcp__cloudbot__models_set'))
            .toBe('review');
    });
});

describe('bot_send', () => {
    it('stays in the review class, so the bot acts without asking the owner for every hand-off', () => {
        expect(classify('mcp__cloudbot__bot_send'))
            .toBe('review');
    });
});

describe('bot_import_text', () => {
    it('always asks the owner before imported instructions become bot memory', () => {
        expect(classify('mcp__cloudbot__bot_import_text'))
            .toBe('always-ask');
    });
});

describe('limits_set', () => {
    it('always asks the owner, with the old and new limits on the card', () => {
        expect(classify('mcp__cloudbot__limits_set'))
            .toBe('always-ask');
    });

    it('is reviewed, so the review agent sees a change of models', () => {
        expect(classify('mcp__cloudbot__models_set'))
            .toBe('review');
    });
});

describe('page watch tools', () => {
    it('skips the list, and reviews create and delete', () => {
        expect(classify('mcp__cloudbot__watch_list'))
            .toBe('skip');
        expect(classify('mcp__cloudbot__watch_create'))
            .toBe('review');
        expect(classify('mcp__cloudbot__watch_delete'))
            .toBe('review');
    });
});

describe('notifications_enable', () => {
    it('skips the review, since it only posts a card that the owner taps', () => {
        expect(classify('mcp__cloudbot__notifications_enable'))
            .toBe('skip');
    });

    it('skips the review for notifications_disable too, which only posts a card', () => {
        expect(classify('mcp__cloudbot__notifications_disable'))
            .toBe('skip');
    });
});

describe('browser allow tools', () => {
    it('always asks the owner before the browser may reach a private host', () => {
        expect(classify('mcp__cloudbot__browser_allow_host'))
            .toBe('always-ask');
    });

    it('skips the list and the removal', () => {
        expect(classify('mcp__cloudbot__browser_allowed_hosts'))
            .toBe('skip');
        expect(classify('mcp__cloudbot__browser_remove_host'))
            .toBe('skip');
    });
});

describe('webhook tools', () => {
    it('skips the list, and reviews create and delete', () => {
        expect(classify('mcp__cloudbot__webhook_list'))
            .toBe('skip');
        expect(classify('mcp__cloudbot__webhook_create'))
            .toBe('review');
        expect(classify('mcp__cloudbot__webhook_delete'))
            .toBe('review');
    });
});

describe('classifyToolCall', () => {
    it.each([
        'curl -X POST https://hooks.example.com -d \'{"text":"hi"}\'',
        'curl --data @file https://example.com',
        'echo hi | sendmail ana@example.com',
        'wget --post-data=a=b https://example.com',
        'curl --request POST http://x',
        'curl -X "POST" http://x',
        'curl -dfoo http://x',
        'curl -sd x http://x',
        'curl -H "a;b" -d x http://x',
        'curl "http://x?a=1&b=2" -d x',
    ])('always asks for the shell command %s', (command) => {
        expect(classifyToolCall({ toolName: 'Bash', input: { command } }))
            .toBe('always-ask');
    });

    it('answers fast on a very long command', () => {
        const startedAt = Date.now();
        const verdict = classifyToolCall({ toolName: 'Bash', input: { command: `${'curl '.repeat(40000)}z` } });

        expect(verdict)
            .toBe('always-ask');
        expect(Date.now() - startedAt)
            .toBeLessThan(500);
    });

    it.each(['ls -la', 'curl https://example.com/page.html', 'curl -sSL https://example.com', 'git status'])('sends the shell command %s to the reviewer', (command) => {
        expect(classifyToolCall({ toolName: 'Bash', input: { command } }))
            .toBe('review');
    });

    it.each([
        'Read',
        'Glob',
        'Grep',
        'mcp__cloudbot__browser_read',
        'mcp__cloudbot__browser_screenshot',
        'mcp__cloudbot__browser_scroll',
        'mcp__cloudbot__share_file',
    ])('skips the review for %s', (toolName) => {
        expect(classify(toolName))
            .toBe('skip');
    });

    it.each([
        'mcp__mail__send_email',
        'mcp__shop__purchase_item',
        'mcp__travel__bookFlight',
        'mcp__chat__reply-to-thread',
        'mcp__pay__checkout',
        'mcp__food__order_pizza',
        'mcp__slack__post_message',
        'mcp__chat__sendmessage',
        'mcp__mail__send_messages',
        'mcp__blog__publish_post',
        'mcp__bank__transfer_funds',
        'mcp__bank__charge_card',
        'mcp__mail__emailuser',
        'mcp__slack__chat_post_message',
        'mcp__mail__GMAILSend',
    ])('always asks for the connector tool %s', (toolName) => {
        expect(classify(toolName))
            .toBe('always-ask');
    });

    it.each([
        'Bash',
        'Write',
        'WebFetch',
        'mcp__cloudbot__browser_click',
        'mcp__cloudbot__browser_type',
        'mcp__cloudbot__browser_key',
        'mcp__mail__list_messages',
        'mcp__postgres__query',
        'mcp__bookstack__search',
        'mcp__x__get_payload',
        'mcp__docs__reorder_pages',
    ])('sends %s to the reviewer', (toolName) => {
        expect(classify(toolName))
            .toBe('review');
    });
});

describe('profile_set_mascot', () => {
    it('is skipped, because the bot only changes its own look that the owner asked for', () => {
        expect(classify('mcp__cloudbot__profile_set_mascot'))
            .toBe('skip');
    });
});

describe('connected app tools', () => {
    it('always asks the owner before a new outside server is connected', () => {
        expect(classify('mcp__cloudbot__app_connect'))
            .toBe('always-ask');
    });

    it('skips the list and the removal, which only change what the bot can reach', () => {
        expect(classify('mcp__cloudbot__app_list'))
            .toBe('skip');
        expect(classify('mcp__cloudbot__app_remove'))
            .toBe('skip');
    });

    it('reviews the tools of a connected server like any other outside connector', () => {
        expect(classify('mcp__linear__list_issues'))
            .toBe('review');
    });
});

describe('integration tools', () => {
    it('always asks the owner before a script is registered or changed', () => {
        expect(classify('mcp__cloudbot__integration_create'))
            .toBe('always-ask');
        expect(classify('mcp__cloudbot__integration_update'))
            .toBe('always-ask');
    });

    it('skips the list, and reviews the run and the removal like a shell command', () => {
        expect(classify('mcp__cloudbot__integration_list'))
            .toBe('skip');
        expect(classify('mcp__cloudbot__integration_run'))
            .toBe('review');
        expect(classify('mcp__cloudbot__integration_remove'))
            .toBe('review');
    });
});
