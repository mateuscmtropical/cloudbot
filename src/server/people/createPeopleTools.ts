import { z } from 'zod/v4';

import { tool } from '../agent/cloudbotTool.ts';
import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { ChatPersonCredentialsEvent } from '../../shared/chatTypes.ts';
import { checkPersonName } from '../../shared/peopleTypes.ts';
import type { Person } from '../../shared/peopleTypes.ts';
import type { PeopleAdmin } from './PeopleAdmin.ts';

interface PeopleToolTextContent {
    type: 'text';
    text: string;
}

interface PeopleToolResult {
    [key: string]: unknown;
    content: PeopleToolTextContent[];
    isError?: boolean;
}

interface PeopleToolsOptions {
    botId: string;
    peopleAdmin: PeopleAdmin;
    approve: (summary: string, detail: string) => Promise<boolean>;
    announce: (event: ChatPersonCredentialsEvent) => void;
}

const PERSON_LIST_TOOL_NAME = 'person_list';
const PERSON_ADD_TOOL_NAME = 'person_add';
const PERSON_DEACTIVATE_TOOL_NAME = 'person_deactivate';
const PERSON_REACTIVATE_TOOL_NAME = 'person_reactivate';
const PERSON_RESET_PASSWORD_TOOL_NAME = 'person_reset_password';
const PEOPLE_TOOL_FULL_NAMES = [
    `mcp__${PROFILE_SERVER_NAME}__${PERSON_LIST_TOOL_NAME}`,
    `mcp__${PROFILE_SERVER_NAME}__${PERSON_ADD_TOOL_NAME}`,
    `mcp__${PROFILE_SERVER_NAME}__${PERSON_DEACTIVATE_TOOL_NAME}`,
    `mcp__${PROFILE_SERVER_NAME}__${PERSON_REACTIVATE_TOOL_NAME}`,
    `mcp__${PROFILE_SERVER_NAME}__${PERSON_RESET_PASSWORD_TOOL_NAME}`,
];

const LIST_DESCRIPTION = 'List people with their role, state and instance status. Passwords are never listed.';
const ADD_DESCRIPTION = 'Invite a person by their lowercase name. The owner approves a card first. Their sign-in address and one-time password are shown only to the owner.';
const DEACTIVATE_DESCRIPTION = 'Deactivate a person by name. The owner approves a card first. Their data stays.';
const REACTIVATE_DESCRIPTION = 'Reactivate a person by name.';
const RESET_PASSWORD_DESCRIPTION = 'Reset a person\'s password by name. The owner approves a card first. The new password is shown only to the owner.';
const NAME_SHAPE = { name: z.string()
    .max(30) };
const PEOPLE_SERVICE_ERROR = 'The people service could not complete that request.';
const OWNER_DID_NOT_APPROVE = 'The owner did not approve this request.';

function textResult(text: string, isError = false): PeopleToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

function describePerson(person: Person): string {
    return `- ${JSON.stringify(person.name)}: ${person.role}, ${person.state}, instance ${person.instance}`;
}

function checkName(name: string): string | undefined {
    return checkPersonName(name);
}

async function requestApproval(options: PeopleToolsOptions, action: string, name: string): Promise<boolean> {
    const summary = `${action} person ${JSON.stringify(name)}.`;
    const detail = `Person: ${JSON.stringify(name)}`;

    return options.approve(summary, detail);
}

function announceCredentials(options: PeopleToolsOptions, person: Person, password: string): void {
    options.announce({
        type: 'personCredentials',
        botId: options.botId,
        name: person.name,
        address: person.address,
        password,
    });
}

function createPeopleTools(options: PeopleToolsOptions): CloudbotTool[] {
    const listTool = tool(PERSON_LIST_TOOL_NAME, LIST_DESCRIPTION, {}, async (): Promise<PeopleToolResult> => {
        try {
            const people = await options.peopleAdmin.list();
            const lines = people.map(describePerson);

            return textResult(lines.length === 0 ? 'There are no people yet.' : lines.join('\n'));
        } catch {
            return textResult(PEOPLE_SERVICE_ERROR, true);
        }
    });

    const addTool = tool(PERSON_ADD_TOOL_NAME, ADD_DESCRIPTION, NAME_SHAPE, async (args): Promise<PeopleToolResult> => {
        const invalidName = checkName(args.name);

        if (invalidName !== undefined) {
            return textResult(invalidName, true);
        }

        try {
            const isApproved = await requestApproval(options, 'Add', args.name);

            if (!isApproved) {
                return textResult(OWNER_DID_NOT_APPROVE, true);
            }

            const created = await options.peopleAdmin.add(args.name);

            announceCredentials(options, created.person, created.password);

            return textResult(`Added ${created.person.name}. The owner saw the sign-in details.`);
        } catch {
            return textResult(PEOPLE_SERVICE_ERROR, true);
        }
    });

    const deactivateTool = tool(PERSON_DEACTIVATE_TOOL_NAME, DEACTIVATE_DESCRIPTION, NAME_SHAPE, async (args): Promise<PeopleToolResult> => {
        const invalidName = checkName(args.name);

        if (invalidName !== undefined) {
            return textResult(invalidName, true);
        }

        try {
            const isApproved = await requestApproval(options, 'Deactivate', args.name);

            if (!isApproved) {
                return textResult(OWNER_DID_NOT_APPROVE, true);
            }

            const person = await options.peopleAdmin.deactivate(args.name);

            return textResult(`${person.name} is ${person.state}.`);
        } catch {
            return textResult(PEOPLE_SERVICE_ERROR, true);
        }
    });

    const reactivateTool = tool(PERSON_REACTIVATE_TOOL_NAME, REACTIVATE_DESCRIPTION, NAME_SHAPE, async (args): Promise<PeopleToolResult> => {
        const invalidName = checkName(args.name);

        if (invalidName !== undefined) {
            return textResult(invalidName, true);
        }

        try {
            const person = await options.peopleAdmin.reactivate(args.name);

            return textResult(`${person.name} is ${person.state}.`);
        } catch {
            return textResult(PEOPLE_SERVICE_ERROR, true);
        }
    });

    const resetPasswordTool = tool(PERSON_RESET_PASSWORD_TOOL_NAME, RESET_PASSWORD_DESCRIPTION, NAME_SHAPE, async (args): Promise<PeopleToolResult> => {
        const invalidName = checkName(args.name);

        if (invalidName !== undefined) {
            return textResult(invalidName, true);
        }

        try {
            const isApproved = await requestApproval(options, 'Reset the password for', args.name);

            if (!isApproved) {
                return textResult(OWNER_DID_NOT_APPROVE, true);
            }

            const people = await options.peopleAdmin.list();
            const person = people.find(candidate => candidate.name === args.name);

            if (person === undefined) {
                return textResult(PEOPLE_SERVICE_ERROR, true);
            }

            const result = await options.peopleAdmin.resetPassword(args.name);

            announceCredentials(options, person, result.password);

            return textResult(`Reset the password for ${person.name}. The owner saw the sign-in details.`);
        } catch {
            return textResult(PEOPLE_SERVICE_ERROR, true);
        }
    });

    return [listTool, addTool, deactivateTool, reactivateTool, resetPasswordTool];
}

export { PEOPLE_TOOL_FULL_NAMES, createPeopleTools };
export type { PeopleToolResult, PeopleToolsOptions };
