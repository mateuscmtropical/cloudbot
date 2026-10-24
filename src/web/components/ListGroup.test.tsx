// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ListGroup } from './ListGroup.tsx';
import { ListRow } from './ListRow.tsx';

describe('ListGroup', () => {
    afterEach(cleanup);

    it('labels a group and contains its rows', () => {
        render(
            <ListGroup label="Bot settings">
                <ListRow title="Library" />
            </ListGroup>,
        );

        expect(screen.getByRole('region', { name: 'Bot settings' }))
            .toBeTruthy();
        expect(screen.getByText('Library'))
            .toBeTruthy();
    });
});
