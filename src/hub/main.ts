import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';

import { readHubSettings } from './config.ts';
import type { HubSettings } from './config.ts';
import { createHubApp } from './createHubApp.ts';
import type { CreateHubAppOptions } from './createHubApp.ts';
import { DockerApi } from './docker/DockerApi.ts';
import { DockerInstanceManager } from './instances/DockerInstanceManager.ts';
import { generatePassword, hashPassword } from './passwords.ts';
import { openHubDatabase } from './store/openHubDatabase.ts';
import { SqlitePeopleStore } from './store/SqlitePeopleStore.ts';
import type { InstanceManager, PeopleStore, PersonRecord } from './contract.ts';

interface CreateOwnerIfMissingOptions {
    people: PeopleStore;
    instances: InstanceManager;
    ownerName: string;
    writeLine: (line: string) => void;
}

function makeOwnerRecord(ownerName: string, passwordHash: string): PersonRecord {
    const secretBytes = randomBytes(32);

    return {
        name: ownerName,
        role: 'owner',
        state: 'active',
        passwordHash,
        mustChangePassword: true,
        instanceSecret: secretBytes.toString('base64url'),
        createdAt: Date.now(),
        lastSeenAt: null,
    };
}

async function createOwnerIfMissing(options: CreateOwnerIfMissingOptions): Promise<void> {
    const existingPeople = options.people.list();
    const hasOwner = existingPeople.some(person => person.role === 'owner');

    if (hasOwner) {
        return;
    }

    const password = generatePassword();
    const passwordHash = await hashPassword(password);
    const ownerRecord = makeOwnerRecord(options.ownerName, passwordHash);

    await options.instances.create(ownerRecord);
    options.people.add(ownerRecord);
    options.writeLine(`Owner ${options.ownerName} password: ${password}`);
}

async function resetPassword(people: PeopleStore, name: string): Promise<string> {
    const person = people.find(name);

    if (person === undefined) {
        throw new Error(`Person ${name} does not exist.`);
    }

    const password = generatePassword();
    const passwordHash = await hashPassword(password);

    people.update(name, { passwordHash, mustChangePassword: true });

    return password;
}

function readCommand(argumentsList: string[]): string | undefined {
    const command = argumentsList[0];

    if (command === undefined) {
        return undefined;
    }

    if (command === 'reset-password' && argumentsList.length === 2) {
        return command;
    }

    throw new Error('Usage: node dist/hub/main.js [reset-password <name>].');
}

function serveHub(app: ReturnType<typeof createHubApp>, settings: HubSettings, closeDatabase: () => void): void {
    const serverOptions = { fetch: app.fetch, port: settings.port, hostname: settings.host };
    const server = serve(serverOptions, () => undefined);
    const shutdown = (): void => {
        server.close();
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    server.once('close', closeDatabase);
}

async function main(): Promise<void> {
    const settings = readHubSettings(process.env);
    const database = openHubDatabase(settings.dataDir);
    const people = new SqlitePeopleStore(database);
    const docker = new DockerApi(settings.dockerApiUrl);
    const instances = new DockerInstanceManager({ docker, people, settings });
    const commandArguments = process.argv.slice(2);
    const command = readCommand(commandArguments);

    if (command === 'reset-password') {
        const name = process.argv[3];

        if (name === undefined) {
            throw new Error('A person name is required.');
        }

        const password = await resetPassword(people, name);

        console.log(`Password for ${name}: ${password}`);
        database.close();

        return;
    }

    const ownerOptions: CreateOwnerIfMissingOptions = {
        people,
        instances,
        ownerName: settings.ownerName,
        writeLine: (line) => {
            console.log(line);
        },
    };

    await createOwnerIfMissing(ownerOptions);
    const appOptions: CreateHubAppOptions = { people, instances, domain: settings.domain, secure: settings.domain !== 'localhost' };
    const app = createHubApp(appOptions);

    const closeDatabase = (): void => {
        database.close();
    };

    serveHub(app, settings, closeDatabase);
}

function isMainModule(): boolean {
    const scriptPath = process.argv[1];

    if (scriptPath === undefined) {
        return false;
    }

    const absoluteScriptPath = resolve(scriptPath);
    const scriptUrl = pathToFileURL(absoluteScriptPath);

    return scriptUrl.href === import.meta.url;
}

if (isMainModule()) {
    main()
        .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : 'Unknown error.';

            console.error(`CloudBot hub could not start: ${message}`);
            process.exitCode = 1;
        });
}

export { createOwnerIfMissing, main, resetPassword };
