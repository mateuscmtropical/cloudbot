import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner, TurnRequest } from '../agent/AgentRunner.ts';
import type { ToolCallReviewer } from '../approvals/ApprovalGate.ts';
import { SKILL_REVIEW_MIN_TOOL_STEPS } from '../skills/skillReview.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { SkillStore } from '../store/SkillStore.ts';
import { ChatService } from './ChatService.ts';

const QUIET_REPLY = 'NOTHING_TO_REPORT';

// eslint-disable-next-line @typescript-eslint/require-await
async function* replayEvents(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
    yield* events;
}

function toolSteps(count: number, toolName = 'Bash'): AgentEvent[] {
    return Array.from({ length: count }, (_, index) => index)
        .flatMap(index => [
            { type: 'tool_started' as const, toolUseId: `t${String(index)}`, toolName, input: {} },
            { type: 'tool_finished' as const, toolUseId: `t${String(index)}`, isError: false, output: 'ok' },
        ]);
}

function turnEvents(steps: AgentEvent[]): AgentEvent[] {
    return [{ type: 'session', sessionId: 'session-1' }, ...steps, { type: 'text', text: 'Done.' }, { type: 'turn_finished', contextTokens: 1000 }];
}

const REVIEW_REPLY: AgentEvent[] = [{ type: 'session', sessionId: 'session-1' }, { type: 'text', text: QUIET_REPLY }, { type: 'turn_finished', contextTokens: 1000 }];

class ScriptedRunner implements AgentRunner {
    readonly requests: TurnRequest[] = [];
    private readonly scripts: AgentEvent[][];

    constructor(scripts: AgentEvent[][]) {
        this.scripts = scripts;
    }

    runTurn(request: TurnRequest): AsyncIterable<AgentEvent> {
        const script = this.scripts[this.requests.length] ?? REVIEW_REPLY;

        this.requests.push(request);

        return replayEvents(script);
    }
}

describe('ChatService skill review', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;
    let services: ChatService[];

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-skill-review-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
        services = [];
    });

    afterEach(async () => {
        services.forEach((service) => {
            service.dispose();
        });
        opened.close();
        await rm(dataDir, { recursive: true, force: true });
    });

    function createService(runner: ScriptedRunner): ChatService {
        const toolCallReviewer: ToolCallReviewer = () => Promise.resolve({ decision: 'allow' });
        const service = new ChatService({ botStore, messageStore, runner, dataDir, skillStore: new SkillStore(opened.db), toolCallReviewer });

        services.push(service);

        return service;
    }

    async function sendAndSettle(service: ChatService, botId: string): Promise<void> {
        await service.sendMessage(botId, 'Do the long task');
        // The review starts when the turn ends, so give both turns time to finish.
        await new Promise((resolve) => {
            setTimeout(resolve, 150);
        });
    }

    it('runs a quiet review after a long turn and leaves no message of it', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new ScriptedRunner([turnEvents(toolSteps(SKILL_REVIEW_MIN_TOOL_STEPS))]);
        const service = createService(runner);

        await sendAndSettle(service, bot.id);

        expect(runner.requests)
            .toHaveLength(2);
        expect(runner.requests[1]?.prompt)
            .toContain('skill_add');

        const stored = await messageStore.listByBot(bot.id, { limit: 50 });
        const texts = JSON.stringify(stored);

        expect(texts)
            .not.toContain(QUIET_REPLY);
        expect(texts)
            .not.toContain('skill_add once');
    });

    it('skips the review for a short turn, when the owner turned it off, or when the turn used a skill', async () => {
        const shortBot = await botStore.create({ name: 'Short', title: '', description: '' });
        const offBot = await botStore.create({ name: 'Off', title: '', description: '' });
        const skillBot = await botStore.create({ name: 'Skill', title: '', description: '' });

        await botStore.setSkillReview(offBot.id, false);

        const shortRunner = new ScriptedRunner([turnEvents(toolSteps(SKILL_REVIEW_MIN_TOOL_STEPS - 1))]);
        const offRunner = new ScriptedRunner([turnEvents(toolSteps(SKILL_REVIEW_MIN_TOOL_STEPS))]);
        const skillRunner = new ScriptedRunner([turnEvents([...toolSteps(SKILL_REVIEW_MIN_TOOL_STEPS), ...toolSteps(1, 'mcp__cloudbot__skill_read')])]);

        await sendAndSettle(createService(shortRunner), shortBot.id);
        await sendAndSettle(createService(offRunner), offBot.id);
        await sendAndSettle(createService(skillRunner), skillBot.id);

        expect([shortRunner.requests.length, offRunner.requests.length, skillRunner.requests.length])
            .toEqual([1, 1, 1]);
    });
});
