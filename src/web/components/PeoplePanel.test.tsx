// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Person, PersonWithPassword } from '../../shared/peopleTypes.ts';
import { RequestFailedError } from '../apiClient.ts';
import { addPerson, deletePerson, listPeople, resetPersonPassword } from '../peopleClient.ts';
import { PeoplePanel } from './PeoplePanel.tsx';

vi.mock('../peopleClient.ts', () => ({
    addPerson: vi.fn(),
    deactivatePerson: vi.fn(),
    deletePerson: vi.fn(),
    listPeople: vi.fn(),
    reactivatePerson: vi.fn(),
    resetPersonPassword: vi.fn(),
}));

const OWNER: Person = {
    name: 'owner',
    role: 'owner',
    state: 'active',
    instance: 'running',
    address: 'https://owner.example.com',
    createdAt: 1,
    lastSeenAt: 1000,
};

const MARIA: Person = {
    name: 'maria',
    role: 'member',
    state: 'inactive',
    instance: 'missing',
    address: 'https://maria.example.com',
    createdAt: 2,
    lastSeenAt: null,
};

const CREATED: PersonWithPassword = { person: { ...MARIA, state: 'active' }, password: 'first-password' };

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('PeoplePanel', () => {
    it('lists people with their states and omits owner access controls', async () => {
        vi.mocked(listPeople)
            .mockResolvedValue([OWNER, MARIA]);

        render(<PeoplePanel onClose={() => {}} />);

        expect(await screen.findByText('Not created'))
            .toBeTruthy();
        expect(screen.getByText('Running'))
            .toBeTruthy();
        expect(screen.getByText('Inactive'))
            .toBeTruthy();
        expect(screen.getByText('Never'))
            .toBeTruthy();
        expect(screen.getAllByText('https://maria.example.com'))
            .toBeTruthy();

        const ownerHeading = screen.getByRole('heading', { name: 'owner' });
        const ownerCard = ownerHeading.closest('article');

        expect(ownerCard)
            .not.toBeNull();
        const ownerCardContent = within(ownerCard as HTMLElement);
        const ownerDeactivationButton = ownerCardContent.queryByRole('button', { name: 'Deactivate' });
        const ownerDeleteButton = ownerCardContent.queryByRole('button', { name: 'Delete' });

        expect(ownerDeactivationButton)
            .toBeNull();
        expect(ownerDeleteButton)
            .toBeNull();
    });

    it('shows and dismisses a one time password card after adding a person', async () => {
        vi.mocked(listPeople)
            .mockResolvedValue([]);
        vi.mocked(addPerson)
            .mockResolvedValue(CREATED);

        render(<PeoplePanel onClose={() => {}} />);

        fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'maria' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add person' }));

        expect(await screen.findByText('Save this now. It is not shown again.'))
            .toBeTruthy();
        expect(screen.getAllByText('https://maria.example.com'))
            .toBeTruthy();
        expect(screen.getByText('first-password'))
            .toBeTruthy();
        expect(screen.getByRole('button', { name: 'Copy address' }))
            .toBeTruthy();
        expect(screen.getByRole('button', { name: 'Copy password' }))
            .toBeTruthy();
        expect(addPerson)
            .toHaveBeenCalledWith('maria');

        fireEvent.click(screen.getByRole('button', { name: 'I saved it' }));

        expect(screen.queryByText('first-password'))
            .toBeNull();
    });

    it('shows a one time password card after resetting a password', async () => {
        vi.mocked(listPeople)
            .mockResolvedValue([MARIA]);
        vi.mocked(resetPersonPassword)
            .mockResolvedValue({ password: 'new-password' });

        render(<PeoplePanel onClose={() => {}} />);

        fireEvent.click(await screen.findByRole('button', { name: 'Reset password' }));

        expect(await screen.findByText('new-password'))
            .toBeTruthy();
        expect(screen.getAllByText('https://maria.example.com'))
            .toBeTruthy();
        expect(resetPersonPassword)
            .toHaveBeenCalledWith('maria');
    });

    it('deletes a person only after the exact name is typed', async () => {
        vi.mocked(listPeople)
            .mockResolvedValue([MARIA]);
        vi.mocked(deletePerson)
            .mockResolvedValue(undefined);

        render(<PeoplePanel onClose={() => {}} />);

        fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

        const confirmButton = screen.getByRole('button', { name: 'Confirm delete' });

        expect((confirmButton as HTMLButtonElement).disabled)
            .toBe(true);
        fireEvent.change(screen.getByLabelText('Type maria to confirm deletion'), { target: { value: 'Maria' } });
        expect((confirmButton as HTMLButtonElement).disabled)
            .toBe(true);
        fireEvent.change(screen.getByLabelText('Type maria to confirm deletion'), { target: { value: 'maria' } });
        expect((confirmButton as HTMLButtonElement).disabled)
            .toBe(false);
        fireEvent.click(confirmButton);

        await waitFor(() => {
            expect(screen.queryByRole('heading', { name: 'maria' }))
                .toBeNull();
        });
        expect(deletePerson)
            .toHaveBeenCalledWith('maria');
    });

    it('shows the server validation message when adding a person fails', async () => {
        vi.mocked(listPeople)
            .mockResolvedValue([]);
        vi.mocked(addPerson)
            .mockRejectedValue(new RequestFailedError('/api/people', 400, 'That name is reserved. Pick another one.'));

        render(<PeoplePanel onClose={() => {}} />);

        fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'admin' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add person' }));

        const errorAlert = await screen.findByRole('alert');

        expect(errorAlert.textContent)
            .toBe('That name is reserved. Pick another one.');
    });

    it('closes from the close button', async () => {
        vi.mocked(listPeople)
            .mockResolvedValue([]);
        const onClose = vi.fn();

        render(<PeoplePanel onClose={onClose} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Close people panel' }));

        expect(onClose)
            .toHaveBeenCalledTimes(1);
    });
});
