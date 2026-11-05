import type { CdpConnection } from './CdpConnection.ts';

interface EvaluateInPageOptions {
    // The isolated world to run in, from createIsolatedContext. Omitted for the page's own world.
    contextId?: number;
    // The object the function runs on as `this`, such as an element or a list from an earlier call. It also picks the world.
    objectId?: string;
    awaitPromise?: boolean;
    userGesture?: boolean;
    returnByValue?: boolean;
    timeoutMs?: number;
}

interface CallTarget {
    objectId?: string;
    executionContextId?: number;
    // The global object looked up for this call only. It is let go after the call.
    lookedUpObjectId?: string;
}

// callFunctionOn needs an object or a context. The page's own world has no id to pass, so its global object is looked up first.
async function callTarget(page: CdpConnection, options: EvaluateInPageOptions): Promise<CallTarget> {
    if (options.objectId !== undefined) {
        return { objectId: options.objectId };
    }

    if (options.contextId !== undefined) {
        return { executionContextId: options.contextId };
    }

    const globalResult = await page.call('Runtime.evaluate', { expression: 'globalThis' });
    const remoteObject: unknown = typeof globalResult === 'object' && globalResult !== null ? Reflect.get(globalResult, 'result') : undefined;
    const objectId: unknown = typeof remoteObject === 'object' && remoteObject !== null ? Reflect.get(remoteObject, 'objectId') : undefined;
    const foundId = typeof objectId === 'string' ? objectId : '';

    return { objectId: foundId, lookedUpObjectId: foundId };
}

// Runs a page function in the page with its arguments. Only the function's source is sent, so it must use the DOM
// and its own arguments, and nothing from this file. The result has the shape of Runtime.evaluate's.
async function evaluateInPage<Args extends unknown[]>(
    page: CdpConnection,
    pageFunction: (...args: Args) => unknown,
    args: Args,
    options: EvaluateInPageOptions = {},
): Promise<unknown> {
    const { lookedUpObjectId, ...target } = await callTarget(page, options);
    const params = {
        functionDeclaration: pageFunction.toString(),
        arguments: args.map(value => ({ value })),
        awaitPromise: options.awaitPromise ?? false,
        userGesture: options.userGesture ?? false,
        returnByValue: options.returnByValue ?? false,
        ...target,
    };

    try {
        return await page.call('Runtime.callFunctionOn', params, options.timeoutMs);
    } finally {
        // Let go of the looked up global object, so the load polls do not pile up handles in the page.
        if (lookedUpObjectId !== undefined && lookedUpObjectId !== '') {
            page.call('Runtime.releaseObject', { objectId: lookedUpObjectId })
                .catch(() => undefined);
        }
    }
}

export { evaluateInPage };
export type { EvaluateInPageOptions };
