import { describe, expect, it } from 'vitest';

import { encodeProjectPath } from './claudeProjectFolder.ts';

describe('encodeProjectPath', () => {
    it('turns every character that is not a letter or a digit into a dash', () => {
        expect(encodeProjectPath('/var/lib/cloudbot-workspaces/bot_1'))
            .toBe('-var-lib-cloudbot-workspaces-bot-1');
    });
});
