import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { checkPersonName } from '../../shared/peopleTypes.ts';
import type { PeopleErrorResponse, Person, PersonWithPassword, ResetPasswordResult } from '../../shared/peopleTypes.ts';
import { PeopleAdminError } from './PeopleAdmin.ts';
import type { PeopleAdmin } from './PeopleAdmin.ts';

interface PeopleRoutesOptions {
    peopleAdmin: PeopleAdmin;
}

interface AddPersonPayload {
    name: string;
}

interface DeletePersonPayload {
    confirm: string;
}

const INVALID_JSON: PeopleErrorResponse = { error: 'Send a valid JSON body.' };
const NAME_REQUIRED: PeopleErrorResponse = { error: 'Send a person name.' };
const CONFIRMATION_REQUIRED: PeopleErrorResponse = { error: 'Type the person name to confirm deletion.' };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function validatePersonName(name: string): PeopleErrorResponse | undefined {
    const problem = checkPersonName(name);

    return problem === undefined ? undefined : { error: problem };
}

function isDeletePersonPayload(value: unknown): value is DeletePersonPayload {
    return isRecord(value) && typeof value.confirm === 'string';
}

function mapPeopleAdminError(error: unknown): PeopleAdminError {
    if (error instanceof PeopleAdminError) {
        return error;
    }

    throw error;
}

function errorResponse(error: unknown): PeopleErrorResponse {
    const peopleAdminError = mapPeopleAdminError(error);

    return { error: peopleAdminError.message };
}

function errorStatus(error: unknown): ContentfulStatusCode {
    const peopleAdminError = mapPeopleAdminError(error);

    return peopleAdminError.status as ContentfulStatusCode;
}

async function readAddPersonPayload(request: Request): Promise<AddPersonPayload | PeopleErrorResponse> {
    let payload: unknown;

    try {
        payload = await request.json();
    } catch {
        return INVALID_JSON;
    }

    if (!isRecord(payload) || typeof payload.name !== 'string') {
        return NAME_REQUIRED;
    }

    const nameProblem = validatePersonName(payload.name);

    return nameProblem ?? { name: payload.name };
}

function isPeopleErrorResponse(value: AddPersonPayload | PeopleErrorResponse): value is PeopleErrorResponse {
    return 'error' in value;
}

async function isDeleteConfirmed(request: Request, name: string): Promise<boolean> {
    const url = new URL(request.url);
    const queryConfirmation = url.searchParams.get('confirm');

    if (queryConfirmation === name) {
        return true;
    }

    try {
        const payload: unknown = await request.json();

        return isDeletePersonPayload(payload) && payload.confirm === name;
    } catch {
        return false;
    }
}

function createPeopleRoutes(options: PeopleRoutesOptions): Hono {
    const routes = new Hono();

    routes.get('/api/people', async (context) => {
        try {
            const people = await options.peopleAdmin.list();

            return context.json(people);
        } catch (error) {
            const body = errorResponse(error);
            const status = errorStatus(error);

            return context.json(body, status);
        }
    });

    routes.post('/api/people', async (context) => {
        const payload = await readAddPersonPayload(context.req.raw);

        if (isPeopleErrorResponse(payload)) {
            return context.json(payload, 400);
        }

        try {
            const createdPerson: PersonWithPassword = await options.peopleAdmin.add(payload.name);

            return context.json(createdPerson, 201);
        } catch (error) {
            const body = errorResponse(error);
            const status = errorStatus(error);

            return context.json(body, status);
        }
    });

    routes.post('/api/people/:name/deactivate', async (context) => {
        const name = context.req.param('name');
        const nameProblem = validatePersonName(name);

        if (nameProblem !== undefined) {
            return context.json(nameProblem, 400);
        }

        try {
            const person: Person = await options.peopleAdmin.deactivate(name);

            return context.json(person);
        } catch (error) {
            const body = errorResponse(error);
            const status = errorStatus(error);

            return context.json(body, status);
        }
    });

    routes.post('/api/people/:name/reactivate', async (context) => {
        const name = context.req.param('name');
        const nameProblem = validatePersonName(name);

        if (nameProblem !== undefined) {
            return context.json(nameProblem, 400);
        }

        try {
            const person: Person = await options.peopleAdmin.reactivate(name);

            return context.json(person);
        } catch (error) {
            const body = errorResponse(error);
            const status = errorStatus(error);

            return context.json(body, status);
        }
    });

    routes.post('/api/people/:name/reset-password', async (context) => {
        const name = context.req.param('name');
        const nameProblem = validatePersonName(name);

        if (nameProblem !== undefined) {
            return context.json(nameProblem, 400);
        }

        try {
            const result: ResetPasswordResult = await options.peopleAdmin.resetPassword(name);

            return context.json(result);
        } catch (error) {
            const body = errorResponse(error);
            const status = errorStatus(error);

            return context.json(body, status);
        }
    });

    routes.delete('/api/people/:name', async (context) => {
        const name = context.req.param('name');
        const nameProblem = validatePersonName(name);

        if (nameProblem !== undefined) {
            return context.json(nameProblem, 400);
        }

        const isConfirmed = await isDeleteConfirmed(context.req.raw, name);

        if (!isConfirmed) {
            return context.json(CONFIRMATION_REQUIRED, 400);
        }

        try {
            await options.peopleAdmin.remove(name);

            return context.body(null, 204);
        } catch (error) {
            const body = errorResponse(error);
            const status = errorStatus(error);

            return context.json(body, status);
        }
    });

    return routes;
}

export { createPeopleRoutes };
export type { PeopleRoutesOptions };
