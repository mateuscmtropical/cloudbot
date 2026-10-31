import type { AgentEvent } from './AgentEvent.ts';
import type { AgentRunner, TurnRequest } from './AgentRunner.ts';

interface ScriptedAgentStep {
    event: AgentEvent;
    delayMs?: number;
}

// Resolves true when the delay passes and false when the signal fires first.
function waitForDelay(delayMs: number, abortSignal: AbortSignal): Promise<boolean> {
    if (abortSignal.aborted) {
        return Promise.resolve(false);
    }

    return new Promise((resolve) => {
        const onAbort = (): void => {
            clearTimeout(timer);
            resolve(false);
        };
        const timer = setTimeout(() => {
            abortSignal.removeEventListener('abort', onAbort);
            resolve(true);
        }, delayMs);

        abortSignal.addEventListener('abort', onAbort, { once: true });
    });
}

async function* streamScript(steps: ScriptedAgentStep[], abortSignal: AbortSignal): AsyncGenerator<AgentEvent> {
    const [nextStep, ...remainingSteps] = steps;

    if (nextStep === undefined) {
        return;
    }

    const isDelayPassed = await waitForDelay(nextStep.delayMs ?? 0, abortSignal);

    if (!isDelayPassed) {
        return;
    }

    yield nextStep.event;

    yield* streamScript(remainingSteps, abortSignal);
}

// The inbox takes messages while the script plays and closes when it ends, as an engine closes its input after the last result.
async function* closeInboxAfter(events: AsyncGenerator<AgentEvent>, inbox: NonNullable<TurnRequest['inbox']>): AsyncGenerator<AgentEvent> {
    try {
        yield* events;
    } finally {
        inbox.deliver = undefined;
    }
}

interface FakeAgentRunnerOptions {
    // When set, the runner takes the owner's new messages during a turn, as the Claude CLI engine does.
    takesMessages?: boolean;
}

// Test double for AgentRunner. It replays a fixed script and never calls Claude.
class FakeAgentRunner implements AgentRunner {
    readonly receivedRequests: TurnRequest[] = [];
    // The messages handed to a running turn, in order.
    readonly deliveredTexts: string[] = [];
    private readonly script: ScriptedAgentStep[];
    private readonly takesMessages: boolean;

    constructor(script: ScriptedAgentStep[], options: FakeAgentRunnerOptions = {}) {
        this.script = script;
        this.takesMessages = options.takesMessages === true;
    }

    runTurn(request: TurnRequest): AsyncIterable<AgentEvent> {
        this.receivedRequests.push(request);
        const events = streamScript(this.script, request.abortSignal);
        const inbox = request.inbox;

        if (!this.takesMessages || inbox === undefined) {
            return events;
        }

        inbox.deliver = (text: string): boolean => {
            this.deliveredTexts.push(text);

            return true;
        };

        return closeInboxAfter(events, inbox);
    }
}

export { FakeAgentRunner };
export type { ScriptedAgentStep };
