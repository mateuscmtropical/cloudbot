import { describe, expect, it } from 'vitest';

import { pickAvatarTextColor } from './pickAvatarTextColor.ts';

describe('pickAvatarTextColor', () => {
    it('uses dark text on a light background', () => {
        expect(pickAvatarTextColor('#e8e8e8'))
            .toBe('#111114');
    });

    it('uses white text on a dark or saturated background', () => {
        expect(pickAvatarTextColor('#e5484d'))
            .toBe('#ffffff');
        expect(pickAvatarTextColor('#1f2937'))
            .toBe('#ffffff');
    });

    it('falls back to white text for a color it cannot read', () => {
        expect(pickAvatarTextColor('tomato'))
            .toBe('#ffffff');
    });
});
