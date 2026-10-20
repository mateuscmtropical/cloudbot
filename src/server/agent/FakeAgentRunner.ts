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

// Test double for AgentRunner. It replays a fixed script and never calls Claude.
class FakeAgentRunner implements AgentRunner {
    readonly receivedRequests: TurnRequest[] = [];
    private readonly script: ScriptedAgentStep[];

    constructor(script: ScriptedAgentStep[]) {
        this.script = script;
    }

    runTurn(request: TurnRequest): AsyncIterable<AgentEvent> {
        this.receivedRequests.push(request);

        return streamScript(this.script, request.abortSignal);
    }
}

export { FakeAgentRunner };
export type { ScriptedAgentStep };
