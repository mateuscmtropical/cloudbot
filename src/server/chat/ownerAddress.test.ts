import { describe, expect, it } from 'vitest';

import type { Channel } from '../store/ChannelStore.ts';
import type { Bot } from '../store/types.ts';
import { findOwnerAddress } from './ownerAddress.ts';

function makeBot(id: string, name: string): Bot {
    return { id, name } as Bot;
}

const ANA = makeBot('ana', 'Ana');
const ANA_LEE = makeBot('ana-lee', 'Ana Lee');
const BEN = makeBot('ben', 'Ben');
const TEAM: Channel = { id: 'team', name: 'Team', isIsolated: false, createdAt: 0, members: [{ botId: 'ben', isManager: true, joinedAt: 0 }] };
const BOTS = [ANA, ANA_LEE, BEN];

describe('findOwnerAddress', () => {
    it('finds another bot by its name, and keeps the text after it', () => {
        const address = findOwnerAddress('@ben  check the list', BOTS, [TEAM], 'ana');

        expect(address?.bot?.id)
            .toBe('ben');
        expect(address?.text)
            .toBe('check the list');
    });

    it('picks the longer name', () => {
        const address = findOwnerAddress('@Ana Lee hello', BOTS, [], 'ben');

        expect(address?.bot?.id)
            .toBe('ana-lee');
    });

    it('finds a group', () => {
        const address = findOwnerAddress('@team plan the week', BOTS, [TEAM], 'ana');

        expect(address?.group?.id)
            .toBe('team');
    });

    it('leaves a message for the bot of the chat, a name with no text, and a name inside a word', () => {
        expect(findOwnerAddress('@ana hello', BOTS, [], 'ana'))
            .toBeUndefined();
        expect(findOwnerAddress('@ben', BOTS, [], 'ana'))
            .toBeUndefined();
        expect(findOwnerAddress('@benjamin hello', BOTS, [], 'ana'))
            .toBeUndefined();
        expect(findOwnerAddress('hello @ben', BOTS, [], 'ana'))
            .toBeUndefined();
    });
});
