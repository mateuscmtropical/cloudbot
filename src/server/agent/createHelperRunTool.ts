import { z } from 'zod/v4';

import type { AgentRunner, TurnRequest } from './AgentRunner.ts';
import type { HelperKind } from './buildHelperAgents.ts';
import { tool } from './cloudbotTool.ts';
import type { CloudbotTool } from './createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from './createProfileToolServer.ts';

interface HelperRunResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

interface HelperTurnObserver {
    // Every event of the helper shows the main turn is alive, since it waits for the tool.
    onActivity: () => void;
    onCost: (costUsd: number) => void;
}

interface HelperPlan {
    kind: HelperKind;
    request: Omit<TurnRequest, 'prompt'>;
}

const HELPER_RUN_TOOL_NAME = 'helper_run';
const HELPER_RUN_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${HELPER_RUN_TOOL_NAME}`;

// Runs one helper turn with its own session and tools. Its tool calls go through the same review as the main turn's.
async function runHelperTurn(runner: AgentRunner, request: TurnRequest, observer: HelperTurnObserver): Promise<HelperRunResult> {
    const texts: string[] = [];
    const errors: string[] = [];

    // The events are an async iterator, so `for await` is the only loop form that fits.
    for await (const event of runner.runTurn(request)) {
        observer.onActivity();

        if (event.type === 'text') {
            texts.push(event.text);
        }

        if (event.type === 'turn_error') {
            errors.push(event.message);
        }

        if (event.type === 'turn_finished' && event.costUsd !== undefined) {
            observer.onCost(event.costUsd);
        }
    }

    if (errors.length > 0) {
        return { content: [{ type: 'text', text: errors.join('\n') }], isError: true };
    }

    return { content: [{ type: 'text', text: texts.join('\n') || 'The helper finished without a report.' }] };
}

// For a helper the CLI of the main turn cannot start, such as one on another provider.
function createHelperRunTool(plans: HelperPlan[], runner: AgentRunner, observer: HelperTurnObserver): CloudbotTool {
    const kinds = plans.map(plan => plan.kind);

    return tool(
        HELPER_RUN_TOOL_NAME,
        'Hand one piece of work to a helper on the provider the owner chose for it, and get its report. Describe the whole task, since the helper knows nothing else of this conversation.',
        {
            helper: z.enum(kinds as [HelperKind, ...HelperKind[]]),
            task: z.string()
                .min(1),
        },
        async ({ helper, task }): Promise<HelperRunResult> => {
            const plan = plans.find(candidate => candidate.kind === helper);

            if (plan === undefined) {
                return { content: [{ type: 'text', text: 'There is no such helper.' }], isError: true };
            }

            return runHelperTurn(runner, { ...plan.request, prompt: task }, observer);
        },
    );
}

export { HELPER_RUN_TOOL_FULL_NAME, createHelperRunTool, runHelperTurn };
export type { HelperPlan, HelperTurnObserver };
