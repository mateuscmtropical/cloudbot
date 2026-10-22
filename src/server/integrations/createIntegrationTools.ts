import { tool } from '../agent/cloudbotTool.ts';
import { z } from 'zod/v4';

import { INTEGRATION_COMMANDS } from '../../shared/integrations.ts';
import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import { IntegrationError } from './integrationFiles.ts';
import type { IntegrationService, IntegrationSummary, RunOutcome } from './IntegrationService.ts';

interface IntegrationToolContent {
    type: 'text';
    text: string;
}

interface IntegrationToolResult {
    [key: string]: unknown;
    content: IntegrationToolContent[];
    isError?: boolean;
}

const CREATE_TOOL_NAME = 'integration_create';
const UPDATE_TOOL_NAME = 'integration_update';
const RUN_TOOL_NAME = 'integration_run';
const LIST_TOOL_NAME = 'integration_list';
const REMOVE_TOOL_NAME = 'integration_remove';
const INTEGRATION_TOOL_FULL_NAMES = [CREATE_TOOL_NAME, UPDATE_TOOL_NAME, RUN_TOOL_NAME, LIST_TOOL_NAME, REMOVE_TOOL_NAME]
    .map(name => `mcp__${PROFILE_SERVER_NAME}__${name}`);

const CREATE_DESCRIPTION = 'Register a script in your workspace as an integration, such as a small script that calls an outside API. The owner must approve it. The entry file is a path inside your workspace. The sha256 is the hash of that file, computed with sha256sum. The owner sees the whole script and the hash before approving, and the file must still have that hash when it is registered. Keep the script under 8000 bytes, with plain text only. The script reads its input on stdin. The secret named here, if any, is passed to the script as an environment variable with the same name. You never see its value. The script gets no other variables.';
const UPDATE_DESCRIPTION = 'Register the current version of an integration\'s entry file again, after you changed it, or change its command or secret. Pass the sha256 of the current file. The owner must approve it, with the whole script. Pass an empty secretName to remove the secret. A run refuses a file that changed since the last registration.';
const RUN_DESCRIPTION = 'Run one of your integrations and get its exit code and output. The output has the secret removed. Runs go one at a time. Each run is reviewed like a shell command.';
const LIST_DESCRIPTION = 'List your integrations with their entry files, commands, secret names and last runs. No secret values are listed.';
const REMOVE_DESCRIPTION = 'Remove one of your integrations. Its secret stays in the vault.';

const NAME_SHAPE = { name: z.string()
    .trim()
    .min(1)
    .max(32) };
const SHA256_SHAPE = {
    sha256: z.string()
        .trim()
        .length(64),
};
const CREATE_SHAPE = {
    ...NAME_SHAPE,
    entryPath: z.string()
        .trim()
        .min(1)
        .max(256),
    command: z.enum(INTEGRATION_COMMANDS),
    secretName: z.string()
        .trim()
        .max(32)
        .optional(),
    ...SHA256_SHAPE,
};
const UPDATE_SHAPE = {
    ...NAME_SHAPE,
    entryPath: z.string()
        .trim()
        .min(1)
        .max(256)
        .optional(),
    command: z.enum(INTEGRATION_COMMANDS)
        .optional(),
    secretName: z.string()
        .trim()
        .max(32)
        .optional(),
    ...SHA256_SHAPE,
};
const LIST_SHAPE = {};

function textResult(text: string, isError = false): IntegrationToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

// The message is for the model. An error names the fix, and never a secret value.
function failure(error: unknown): IntegrationToolResult {
    if (error instanceof IntegrationError) {
        return textResult(error.message, true);
    }

    return textResult('The integration could not be run.', true);
}

function describeSummary(summary: IntegrationSummary): string {
    const secret = summary.secretName ?? 'none';
    const lastRun = summary.lastRun === undefined
        ? 'never run'
        : `last run ${new Date(summary.lastRun.startedAt)
            .toISOString()}, exit ${String(summary.lastRun.exitCode)}${summary.lastRun.timedOut ? ', timed out' : ''}`;

    return `${summary.name}: ${summary.command} ${summary.entryPath}, secret ${secret}, ${lastRun}`;
}

function describeRun(outcome: RunOutcome): string {
    const status = outcome.timedOut ? 'The run timed out.' : `Exit code ${String(outcome.exitCode)}.`;
    const cut = outcome.truncated ? ' The output was cut off.' : '';

    return `${status}${cut}\n${outcome.output}`;
}

// The five tools of the integrations. Create and update are always asked of the owner, see classifyToolCall.
function createIntegrationTools(service: IntegrationService, botId: string): CloudbotTool[] {
    const createTool = tool(CREATE_TOOL_NAME, CREATE_DESCRIPTION, CREATE_SHAPE, async (args): Promise<IntegrationToolResult> => {
        try {
            const summary = await service.register(botId, {
                name: args.name,
                entryPath: args.entryPath,
                command: args.command,
                secretName: args.secretName,
                sha256: args.sha256,
            });

            return textResult(`Integration registered. ${describeSummary(summary)}`);
        } catch (error: unknown) {
            return failure(error);
        }
    });
    const updateTool = tool(UPDATE_TOOL_NAME, UPDATE_DESCRIPTION, UPDATE_SHAPE, async (args): Promise<IntegrationToolResult> => {
        try {
            const summary = await service.update(botId, {
                name: args.name,
                entryPath: args.entryPath,
                command: args.command,
                secretName: args.secretName,
                sha256: args.sha256,
            });

            return textResult(`Integration updated. ${describeSummary(summary)}`);
        } catch (error: unknown) {
            return failure(error);
        }
    });
    const runTool = tool(RUN_TOOL_NAME, RUN_DESCRIPTION, NAME_SHAPE, async (args): Promise<IntegrationToolResult> => {
        try {
            const outcome = await service.run(botId, args.name);

            const report = describeRun(outcome);

            return textResult(report);
        } catch (error: unknown) {
            return failure(error);
        }
    });
    const listTool = tool(LIST_TOOL_NAME, LIST_DESCRIPTION, LIST_SHAPE, async (): Promise<IntegrationToolResult> => {
        const summaries = await service.list(botId);

        if (summaries.length === 0) {
            return textResult('You have no integrations.');
        }

        const lines = summaries.map(describeSummary);

        const text = lines.join('\n');

        return textResult(text);
    });
    const removeTool = tool(REMOVE_TOOL_NAME, REMOVE_DESCRIPTION, NAME_SHAPE, async (args): Promise<IntegrationToolResult> => {
        try {
            await service.remove(botId, args.name);

            return textResult(`Integration "${args.name}" removed.`);
        } catch (error: unknown) {
            return failure(error);
        }
    });

    return [createTool, updateTool, runTool, listTool, removeTool];
}

export { INTEGRATION_TOOL_FULL_NAMES, createIntegrationTools };
