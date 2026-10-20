import { describe, expect, it, vi } from 'vitest';
import * as fileSystem from 'node:fs/promises';
import type { Options, SDKAssistantMessage, SDKMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { SdkAgentRunner, buildQueryOptions, mapSdkMessage } from './SdkAgentRunner.ts';
import type { SdkQueryFunction } from './SdkAgentRunner.ts';
import type { AgentEvent } from './AgentEvent.ts';
import type { TurnRequest } from './AgentRunner.ts';

vi.mock('node:fs/promises', { spy: true });

const SESSION_ID = '5f0c2d1e-0000-4000-8000-000000000001';

function buildAssistantMessage(content: SDKAssistantMessage['message']['content']): SDKAssistantMessage {
    return {
        type: 'assistant',
        message: { content } as SDKAssistantMessage['message'],
        parent_tool_use_id: null,
        uuid: '00000000-0000-4000-8000-000000000010',
        session_id: SESSION_ID,
    };
}

function buildUserToolResultMessage(toolUseId: string, content: string, isError: boolean): SDKUserMessage {
    return {
        type: 'user',
        message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
        },
        parent_tool_use_id: null,
        uuid: '00000000-0000-4000-8000-000000000011',
        session_id: SESSION_ID,
    };
}

function buildSuccessResult(): SDKResultMessage {
    return {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1000,
        num_turns: 1,
        result: 'Done.',
        stop_reason: 'end_turn',
        total_cost_usd: 0.0123,
        usage: {} as SDKResultMessage['usage'],
        modelUsage: {},
        permission_denials: [],
        errors: [],
        uuid: '00000000-0000-4000-8000-000000000012',
        session_id: SESSION_ID,
    } as SDKResultMessage;
}

function buildErrorResult(errors: string[]): SDKResultMessage {
    return {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        duration_ms: 500,
        duration_api_ms: 400,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        usage: {} as SDKResultMessage['usage'],
        modelUsage: {},
        permission_denials: [],
        errors,
        uuid: '00000000-0000-4000-8000-000000000013',
        session_id: SESSION_ID,
    };
}

describe('mapSdkMessage', () => {
    it('maps the init system message to a session event with the session id', () => {
        const initMessage = {
            type: 'system',
            subtype: 'init',
            session_id: SESSION_ID,
        } as SDKMessage;

        expect(mapSdkMessage(initMessage))
            .toEqual([{ type: 'session', sessionId: SESSION_ID }]);
    });

    it('maps a partial text delta stream event to a text delta event', () => {
        const streamMessage = {
            type: 'stream_event',
            event: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'Hel' },
            },
            parent_tool_use_id: null,
            uuid: '00000000-0000-4000-8000-000000000020',
            session_id: SESSION_ID,
        } as SDKMessage;

        expect(mapSdkMessage(streamMessage))
            .toEqual([{ type: 'text_delta', text: 'Hel' }]);
    });

    it('ignores partial stream events that are not text deltas', () => {
        const streamMessage = {
            type: 'stream_event',
            event: { type: 'message_stop' },
            parent_tool_use_id: null,
            uuid: '00000000-0000-4000-8000-000000000021',
            session_id: SESSION_ID,
        } as SDKMessage;

        expect(mapSdkMessage(streamMessage))
            .toEqual([]);
    });

    it('maps a full assistant text block to a text event', () => {
        const assistantMessage = buildAssistantMessage([{ type: 'text', text: 'Hello there.', citations: null }]);

        expect(mapSdkMessage(assistantMessage))
            .toEqual([{ type: 'text', text: 'Hello there.' }]);
    });

    it('maps an assistant tool_use block to a tool started event with its input', () => {
        const assistantMessage = buildAssistantMessage([
            { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls' } },
        ]);

        expect(mapSdkMessage(assistantMessage))
            .toEqual([
                { type: 'tool_started', toolUseId: 'toolu_01', toolName: 'Bash', input: { command: 'ls' } },
            ]);
    });

    it('maps a user tool_result block to a tool finished event', () => {
        const userMessage = buildUserToolResultMessage('toolu_01', 'file-a.txt', false);

        expect(mapSdkMessage(userMessage))
            .toEqual([
                { type: 'tool_finished', toolUseId: 'toolu_01', isError: false, output: 'file-a.txt' },
            ]);
    });

    it('marks a tool finished event as an error when the SDK says the tool failed', () => {
        const userMessage = buildUserToolResultMessage('toolu_02', 'permission denied', true);

        expect(mapSdkMessage(userMessage))
            .toEqual([
                { type: 'tool_finished', toolUseId: 'toolu_02', isError: true, output: 'permission denied' },
            ]);
    });

    it('truncates a long tool output to a short summary', () => {
        const longOutput = 'x'.repeat(2000);
        const userMessage = buildUserToolResultMessage('toolu_03', longOutput, false);

        const [event] = mapSdkMessage(userMessage);

        expect(event)
            .toMatchObject({ type: 'tool_finished' });
        expect(event)
            .toHaveProperty('output', 'x'.repeat(500));
    });

    it('maps a successful result to a turn finished event with cost and duration', () => {
        expect(mapSdkMessage(buildSuccessResult()))
            .toEqual([
                { type: 'turn_finished', costUsd: 0.0123, durationMs: 1234 },
            ]);
    });

    it('maps an error result to a turn error event', () => {
        expect(mapSdkMessage(buildErrorResult(['Tool crashed'])))
            .toEqual([
                { type: 'turn_error', message: 'Tool crashed', isUsageLimit: false },
            ]);
    });

    it('flags an error result with a usage limit message as a usage limit', () => {
        const limitResult = buildErrorResult(['You\'ve hit your limit · resets 5pm']);

        expect(mapSdkMessage(limitResult))
            .toEqual([
                { type: 'turn_error', message: 'You\'ve hit your limit · resets 5pm', isUsageLimit: true },
            ]);
    });

    it('skips an errored assistant message because the result reports the same failure', () => {
        const erroredAssistant = {
            ...buildAssistantMessage([{ type: 'text', text: 'You\'ve hit your limit', citations: null }]),
            error: 'rate_limit',
        } as SDKAssistantMessage;

        expect(mapSdkMessage(erroredAssistant))
            .toEqual([]);
    });
});

describe('buildQueryOptions', () => {
    const abortController = new AbortController();

    function buildRequest(overrides: Partial<TurnRequest>): TurnRequest {
        return {
            botId: 'bot-1',
            workspaceDir: '/data/bots/bot-1',
            prompt: 'Hi',
            abortSignal: abortController.signal,
            ...overrides,
        };
    }

    it('resumes the stored session in the bot workspace with partial messages on', () => {
        const options = buildQueryOptions(
            buildRequest({ sessionId: SESSION_ID }),
            { pathToClaudeCodeExecutable: '/usr/local/bin/claude' },
            abortController,
        );

        expect(options)
            .toMatchObject({
                resume: SESSION_ID,
                cwd: '/data/bots/bot-1',
                includePartialMessages: true,
                pathToClaudeCodeExecutable: '/usr/local/bin/claude',
            });
    });

    it('leaves out resume, the executable path and env when they are not set', () => {
        const options = buildQueryOptions(buildRequest({}), {}, abortController);

        expect(options).not.toHaveProperty('resume');
        expect(options).not.toHaveProperty('pathToClaudeCodeExecutable');
        expect(options).not.toHaveProperty('env');
        expect(options).not.toHaveProperty('spawnClaudeCodeProcess');
    });

    it('sets the user spawn hook, minimal env and isolated workspace when configured', () => {
        const options = buildQueryOptions(buildRequest({ workspaceDir: '/var/lib/cloudbot-workspaces/bot-1' }), {
            agentUser: 'bot',
            pathToClaudeCodeExecutable: '/home/bot/.local/bin/claude',
            environment: { SERVER_SECRET: 'secret', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234' },
        }, abortController);

        expect(options.spawnClaudeCodeProcess)
            .toBeTypeOf('function');
        expect(options.cwd)
            .toBe('/var/lib/cloudbot-workspaces/bot-1');
        expect(options.env)
            .toEqual({
                HOME: '/home/bot',
                PATH: '/usr/local/bin:/usr/bin:/bin',
                ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234',
                ANTHROPIC_API_KEY: 'cloudbot-key-proxy',
            });
    });

    it('passes the configured environment to the SDK as env', () => {
        const options = buildQueryOptions(buildRequest({}), { environment: { PATH: '/usr/bin' } }, abortController);

        expect(options)
            .toMatchObject({ env: { PATH: '/usr/bin' } });
    });

    it('passes the MCP servers, allowed tools and system prompt from the request', () => {
        const mcpServers = { cloudbot: { type: 'sdk' as const, name: 'cloudbot', instance: {} as never } };
        const options = buildQueryOptions(
            buildRequest({ systemPrompt: 'You are Ana.', mcpServers, allowedTools: ['mcp__cloudbot__update_profile'] }),
            {},
            abortController,
        );

        expect(options)
            .toMatchObject({
                systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are Ana.' },
                mcpServers,
                allowedTools: ['mcp__cloudbot__update_profile'],
            });
    });

    it('keeps the Claude Code preset prompt without an append when the request has no profile prompt', () => {
        const options = buildQueryOptions(buildRequest({}), {}, abortController);

        expect(options)
            .toMatchObject({ systemPrompt: { type: 'preset', preset: 'claude_code' } });
        expect(options.systemPrompt).not.toHaveProperty('append');
    });

    it('leaves out MCP servers and allowed tools when the request has none', () => {
        const options = buildQueryOptions(buildRequest({}), {}, abortController);

        expect(options).not.toHaveProperty('mcpServers');
        expect(options).not.toHaveProperty('allowedTools');
    });
});

describe('rate limit events', () => {
    it('maps a rate limit event to a rate limit event with reset time in milliseconds', () => {
        const rateLimitMessage = {
            type: 'rate_limit_event',
            rate_limit_info: { status: 'rejected', resetsAt: 1_700_000_000 },
            uuid: '00000000-0000-4000-8000-000000000030',
            session_id: SESSION_ID,
        } as SDKMessage;

        expect(mapSdkMessage(rateLimitMessage))
            .toEqual([
                { type: 'rate_limit', status: 'rejected', resetsAt: 1_700_000_000_000 },
            ]);
    });

    it('maps a rate limit event without a reset time and leaves resetsAt out', () => {
        const rateLimitMessage = {
            type: 'rate_limit_event',
            rate_limit_info: { status: 'allowed' },
            uuid: '00000000-0000-4000-8000-000000000031',
            session_id: SESSION_ID,
        } as SDKMessage;

        const [event] = mapSdkMessage(rateLimitMessage);

        expect(event)
            .toEqual({ type: 'rate_limit', status: 'allowed' });
        expect(event).not.toHaveProperty('resetsAt');
    });
});

// The SDK returns an async iterator, so the fake is an async generator even though nothing is awaited.
// eslint-disable-next-line @typescript-eslint/require-await
async function* streamSdkMessages(sdkMessages: SDKMessage[]): AsyncGenerator<SDKMessage> {
    yield* sdkMessages;
}

function buildRunTurnRequest(abortController: AbortController): TurnRequest {
    return {
        botId: 'bot-1',
        workspaceDir: '/data/bots/bot-1',
        prompt: 'Hi',
        abortSignal: abortController.signal,
    };
}

async function collectRunTurnEvents(runner: SdkAgentRunner, request: TurnRequest): Promise<AgentEvent[]> {
    const collected: AgentEvent[] = [];

    for await (const event of runner.runTurn(request)) {
        collected.push(event);
    }

    return collected;
}

describe('SdkAgentRunner.runTurn', () => {
    it('does not start the SDK query when the turn was stopped before it began', async () => {
        const queryFunction = vi.fn<SdkQueryFunction>(() => streamSdkMessages([]));
        const runner = new SdkAgentRunner({ queryFunction });
        const abortController = new AbortController();

        abortController.abort();

        const events = await collectRunTurnEvents(runner, buildRunTurnRequest(abortController));

        expect(events)
            .toEqual([]);
        expect(queryFunction).not.toHaveBeenCalled();
    });

    it('refuses to construct an unisolated runner in production', () => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('CLOUDBOT_AGENT_USER', '');
        try {
            expect(() => new SdkAgentRunner({}))
                .toThrow('CLOUDBOT_AGENT_USER must be set in production');
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('logs workspace preparation details and returns a message without paths', async () => {
        const failure = new Error('EACCES: permission denied, mkdir /var/lib/cloudbot-workspaces/bot-1');
        const mkdir = vi.spyOn(fileSystem, 'mkdir')
            .mockRejectedValue(failure);
        const log = vi.spyOn(console, 'error')
            .mockImplementation(() => undefined);
        const queryFunction = vi.fn(() => streamSdkMessages([]));
        const runner = new SdkAgentRunner({ agentUser: 'bot', queryFunction });
        const request = buildRunTurnRequest(new AbortController());
        const events = await collectRunTurnEvents(runner, request);

        expect(events)
            .toEqual([{ type: 'turn_error', message: 'Could not prepare the agent workspace. Please try again.', isUsageLimit: false }]);
        expect(log)
            .toHaveBeenCalledWith('Could not prepare the agent workspace:', failure);
        expect(mkdir)
            .toHaveBeenCalled();
        expect(queryFunction)
            .not.toHaveBeenCalled();
    });

    it('fills a usage limit error with the latest reset time seen in the turn', async () => {
        const rateLimitMessage = {
            type: 'rate_limit_event',
            rate_limit_info: { status: 'rejected', resetsAt: 1_700_000_000 },
            uuid: '00000000-0000-4000-8000-000000000040',
            session_id: SESSION_ID,
        } as SDKMessage;
        const runner = new SdkAgentRunner({
            queryFunction: () => streamSdkMessages([rateLimitMessage, buildErrorResult(['You\'ve hit your limit'])]),
        });

        const events = await collectRunTurnEvents(runner, buildRunTurnRequest(new AbortController()));

        expect(events)
            .toEqual([
                { type: 'rate_limit', status: 'rejected', resetsAt: 1_700_000_000_000 },
                { type: 'turn_error', message: 'You\'ve hit your limit', isUsageLimit: true, resetsAt: 1_700_000_000_000 },
            ]);
    });

    it('sends the resume id and the workspace to the SDK query', async () => {
        const receivedParameters: { prompt: string; options: Options }[] = [];
        const runner = new SdkAgentRunner({
            queryFunction: (parameters) => {
                receivedParameters.push(parameters);

                return streamSdkMessages([buildErrorResult(['stopped'])]);
            },
        });
        const request = { ...buildRunTurnRequest(new AbortController()), sessionId: SESSION_ID };

        await collectRunTurnEvents(runner, request);

        expect(receivedParameters[0]?.options)
            .toMatchObject({ resume: SESSION_ID, cwd: '/data/bots/bot-1' });
    });

    it('reports a thrown SDK error as a turn error event', async () => {
        // eslint-disable-next-line @typescript-eslint/require-await -- same reason as streamSdkMessages: the SDK returns an async iterator.
        async function* failingConversation(): AsyncGenerator<SDKMessage> {
            yield { type: 'system', subtype: 'init', session_id: SESSION_ID } as SDKMessage;
            throw new Error('spawn claude ENOENT');
        }
        const runner = new SdkAgentRunner({ queryFunction: failingConversation });

        const events = await collectRunTurnEvents(runner, buildRunTurnRequest(new AbortController()));

        expect(events)
            .toEqual([
                { type: 'session', sessionId: SESSION_ID },
                { type: 'turn_error', message: 'spawn claude ENOENT', isUsageLimit: false },
            ]);
    });

    it('stops without an error event when the turn is aborted', async () => {
        async function* conversationUntilAborted(parameters: { options: Options }): AsyncGenerator<SDKMessage> {
            yield { type: 'system', subtype: 'init', session_id: SESSION_ID } as SDKMessage;
            await new Promise<void>((_resolve, reject) => {
                parameters.options.abortController?.signal.addEventListener('abort', () => {
                    reject(new Error('The operation was aborted'));
                });
            });
        }
        const runner = new SdkAgentRunner({ queryFunction: conversationUntilAborted });
        const abortController = new AbortController();
        const received: AgentEvent[] = [];

        for await (const event of runner.runTurn(buildRunTurnRequest(abortController))) {
            received.push(event);
            // Abort on a later tick, after the turn has gone back to waiting on the SDK.
            setTimeout(() => {
                abortController.abort();
            }, 10);
        }

        expect(received)
            .toEqual([{ type: 'session', sessionId: SESSION_ID }]);
    });
});
