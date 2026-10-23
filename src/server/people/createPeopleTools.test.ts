import { describe, expect, it, vi } from 'vitest';

import type { CloudbotToolResult } from '../agent/cloudbotTool.ts';
import type { ChatPersonCredentialsEvent } from '../../shared/chatTypes.ts';
import type { Person } from '../../shared/peopleTypes.ts';
import { PeopleAdminError } from './PeopleAdmin.ts';
import type { PeopleAdmin } from './PeopleAdmin.ts';
import { PEOPLE_TOOL_FULL_NAMES, createPeopleTools } from './createPeopleTools.ts';

const PERSON: Person = {
    name: 'maria',
    role: 'member',
    state: 'active',
    instance: 'stopped',
    address: 'https://maria.example.test',
    createdAt: 1,
    lastSeenAt: null,
};
const GENERATED_PASSWORD = 'one-time-secret';

function createAdmin(overrides: Partial<PeopleAdmin> = {}): PeopleAdmin {
    return {
        list: vi.fn(() => Promise.resolve([PERSON])),
        add: vi.fn((name: string) => Promise.resolve({ person: { ...PERSON, name }, password: GENERATED_PASSWORD })),
        deactivate: vi.fn((name: string) => Promise.resolve({ ...PERSON, name, state: 'inactive' as const })),
        reactivate: vi.fn((name: string) => Promise.resolve({ ...PERSON, name, state: 'active' as const })),
        resetPassword: vi.fn(() => Promise.resolve({ password: GENERATED_PASSWORD })),
        remove: vi.fn(() => Promise.resolve()),
        ...overrides,
    };
}

function createHarness(admin: PeopleAdmin = createAdmin(), approved = true): { tools: ReturnType<typeof createPeopleTools>; approve: ReturnType<typeof vi.fn>; announced: ChatPersonCredentialsEvent[] } {
    const announced: ChatPersonCredentialsEvent[] = [];
    const approve = vi.fn(() => Promise.resolve(approved));
    const tools = createPeopleTools({
        botId: 'bot-1',
        peopleAdmin: admin,
        approve,
        announce: (event) => {
            announced.push(event);
        },
    });

    return { tools, approve, announced };
}

function findTool(tools: ReturnType<typeof createPeopleTools>, name: string): ReturnType<typeof createPeopleTools>[number] {
    const found = tools.find(candidate => candidate.name === name);

    if (found === undefined) {
        throw new Error(`No tool ${name}`);
    }

    return found;
}

function resultText(result: CloudbotToolResult): string | undefined {
    const content = result.content[0];

    return content?.type === 'text' ? content.text : undefined;
}

describe('createPeopleTools', () => {
    it('offers the five people tools', () => {
        const { tools } = createHarness();

        expect(tools.map(candidate => `mcp__cloudbot__${candidate.name}`))
            .toEqual(PEOPLE_TOOL_FULL_NAMES);
    });

    it('lists names, roles, states and instance status without passwords', async () => {
        const { tools } = createHarness();
        const result = await findTool(tools, 'person_list')
            .handler({}, {});

        expect(resultText(result))
            .toBe('- "maria": member, active, instance stopped');
        expect(JSON.stringify(result))
            .not.toContain(GENERATED_PASSWORD);
    });

    it('waits for approval before adding a person and sends the password only in the notice', async () => {
        let resolveApproval: (isApproved: boolean) => void = () => undefined;
        const pendingApproval = new Promise<boolean>((resolve) => {
            resolveApproval = resolve;
        });
        const admin = createAdmin();
        const approve = vi.fn(() => pendingApproval);
        const announced: ChatPersonCredentialsEvent[] = [];
        const tools = createPeopleTools({
            botId: 'bot-1',
            peopleAdmin: admin,
            approve,
            announce: event => announced.push(event),
        });
        const pendingResult = findTool(tools, 'person_add')
            .handler({ name: 'maria' }, {});

        expect(admin.add)
            .not.toHaveBeenCalled();
        expect(approve)
            .toHaveBeenCalledWith('Add person "maria".', 'Person: "maria"');

        resolveApproval(true);
        const result = await pendingResult;

        expect(admin.add)
            .toHaveBeenCalledWith('maria');
        expect(announced)
            .toEqual([{ type: 'personCredentials', botId: 'bot-1', name: 'maria', address: PERSON.address, password: GENERATED_PASSWORD }]);
        expect(resultText(result))
            .toBe('Added maria. The owner saw the sign-in details.');
        expect(JSON.stringify(result))
            .not.toContain(GENERATED_PASSWORD);
    });

    it('asks the owner to approve deactivation and returns the new state', async () => {
        const admin = createAdmin();
        const { tools, approve } = createHarness(admin);
        const result = await findTool(tools, 'person_deactivate')
            .handler({ name: 'maria' }, {});

        expect(approve)
            .toHaveBeenCalledWith('Deactivate person "maria".', 'Person: "maria"');
        expect(admin.deactivate)
            .toHaveBeenCalledWith('maria');
        expect(resultText(result))
            .toBe('maria is inactive.');
    });

    it('reactivates a person without asking for approval and returns the new state', async () => {
        const admin = createAdmin();
        const { tools, approve } = createHarness(admin);
        const result = await findTool(tools, 'person_reactivate')
            .handler({ name: 'maria' }, {});

        expect(approve)
            .not.toHaveBeenCalled();
        expect(admin.reactivate)
            .toHaveBeenCalledWith('maria');
        expect(resultText(result))
            .toBe('maria is active.');
    });

    it('asks for password reset approval and sends the new password only in the notice', async () => {
        const admin = createAdmin();
        const { tools, approve, announced } = createHarness(admin);
        const result = await findTool(tools, 'person_reset_password')
            .handler({ name: 'maria' }, {});

        expect(approve)
            .toHaveBeenCalledWith('Reset the password for person "maria".', 'Person: "maria"');
        expect(admin.resetPassword)
            .toHaveBeenCalledWith('maria');
        expect(announced)
            .toEqual([{ type: 'personCredentials', botId: 'bot-1', name: 'maria', address: PERSON.address, password: GENERATED_PASSWORD }]);
        expect(resultText(result))
            .toBe('Reset the password for maria. The owner saw the sign-in details.');
        expect(JSON.stringify(result))
            .not.toContain(GENERATED_PASSWORD);
    });

    it('refuses invalid names before approval or a hub call', async () => {
        const admin = createAdmin();
        const { tools, approve, announced } = createHarness(admin);
        const result = await findTool(tools, 'person_add')
            .handler({ name: 'Maria' }, {});

        expect(result.isError)
            .toBe(true);
        expect(resultText(result))
            .toContain('lowercase');
        expect(approve)
            .not.toHaveBeenCalled();
        expect(admin.add)
            .not.toHaveBeenCalled();
        expect(announced)
            .toEqual([]);
    });

    it('does not run owner-approved actions after the owner denies them', async () => {
        const admin = createAdmin();
        const { tools, announced } = createHarness(admin, false);
        const addResult = await findTool(tools, 'person_add')
            .handler({ name: 'maria' }, {});
        const deactivateResult = await findTool(tools, 'person_deactivate')
            .handler({ name: 'maria' }, {});
        const resetResult = await findTool(tools, 'person_reset_password')
            .handler({ name: 'maria' }, {});

        expect(resultText(addResult))
            .toBe('The owner did not approve this request.');
        expect(resultText(deactivateResult))
            .toBe('The owner did not approve this request.');
        expect(resultText(resetResult))
            .toBe('The owner did not approve this request.');
        expect(admin.add)
            .not.toHaveBeenCalled();
        expect(admin.deactivate)
            .not.toHaveBeenCalled();
        expect(admin.resetPassword)
            .not.toHaveBeenCalled();
        expect(announced)
            .toEqual([]);
    });

    it('hides PeopleAdminError details from every tool result', async () => {
        const internalMessage = 'secret hub response body';
        const failure = new PeopleAdminError(internalMessage, 502);
        const list = vi.fn()
            .mockRejectedValueOnce(failure)
            .mockResolvedValue([PERSON]);
        const admin = createAdmin({
            list,
            add: vi.fn(() => Promise.reject(failure)),
            deactivate: vi.fn(() => Promise.reject(failure)),
            reactivate: vi.fn(() => Promise.reject(failure)),
            resetPassword: vi.fn(() => Promise.reject(failure)),
        });
        const { tools } = createHarness(admin);
        const listResult = await findTool(tools, 'person_list')
            .handler({}, {});
        const addResult = await findTool(tools, 'person_add')
            .handler({ name: 'maria' }, {});
        const deactivateResult = await findTool(tools, 'person_deactivate')
            .handler({ name: 'maria' }, {});
        const reactivateResult = await findTool(tools, 'person_reactivate')
            .handler({ name: 'maria' }, {});
        const resetResult = await findTool(tools, 'person_reset_password')
            .handler({ name: 'maria' }, {});
        const resultText = JSON.stringify([listResult, addResult, deactivateResult, reactivateResult, resetResult]);

        expect(resultText)
            .not.toContain(internalMessage);
        expect(resultText.match(/people service could not complete that request/g))
            .toHaveLength(5);
    });
});
