import { tool } from '../agent/cloudbotTool.ts';
import type { CloudbotTool } from '../agent/cloudbotTool.ts';
import { z } from 'zod/v4';

import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import { BrowserError } from '../desktop/BrowserControl.ts';
import type { BrowserControl } from '../desktop/BrowserControl.ts';
import { SCREEN_HELD_BY_PERSON_MESSAGE } from '../desktop/ScreenHolder.ts';
import type { ScreenHolder } from '../desktop/ScreenHolder.ts';
import type { SecretToolResult } from '../secrets/createSecretTools.ts';
import { BitwardenError } from './BitwardenCli.ts';
import type { BitwardenLoginItem } from './BitwardenCli.ts';
import type { BitwardenVault } from './BitwardenVault.ts';
import { matchLoginItems } from './matchLoginItems.ts';

// The vault part the tool needs. The bot id is fixed by the caller.
type LoginVault = Pick<BitwardenVault, 'isConfigured' | 'listLogins' | 'getValue' | 'hasApproval' | 'rememberApproval'>;
type LoginBrowser = Pick<BrowserControl, 'readPageOrigin' | 'typeLogin' | 'takeDismissedDialogs'>;
// Asks the owner in the chat. It answers true only when the owner approves.
type OwnerAsker = (summary: string, detail: string | undefined) => Promise<boolean>;

interface FillLoginToolDependencies {
    botId: string;
    browser: LoginBrowser;
    vault: LoginVault;
    askOwner: OwnerAsker;
    screen?: ScreenHolder | undefined;
}

const FILL_LOGIN_TOOL_NAME = 'browser_fill_login';
const FILL_LOGIN_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${FILL_LOGIN_TOOL_NAME}`;
const FILL_LOGIN_DESCRIPTION = 'Type the user name, the password or the one-time code of a login from the owner\'s Bitwarden vault into the focused field of your browser. You never see the value. Click the field first. The server looks at the page that is really open and offers only logins saved for that site. The owner approves each login. If several logins match, the answer lists their names and you call again with item set to one of them.';
const NOT_SET_UP_MESSAGE = 'Bitwarden is not connected. Ask the owner to connect Bitwarden in Connect apps.';
const MAX_NAME_LENGTH = 80;
const MAX_LISTED_NAMES = 20;
// A name that comes from the vault is cut and cleaned before it goes in a card or an answer.
const CONTROL_CHARACTERS = /\p{Cc}/gu;

const FILL_LOGIN_SHAPE = {
    field: z.enum(['username', 'password', 'totp']),
    item: z.string()
        .trim()
        .min(1)
        .max(200)
        .optional(),
};

function textResult(text: string, isError = false): SecretToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

function cleanName(name: string): string {
    const withoutControls = name.replace(CONTROL_CHARACTERS, ' ')
        .trim();

    return withoutControls.slice(0, MAX_NAME_LENGTH);
}

function describeFieldName(field: 'username' | 'password' | 'totp'): string {
    return field === 'totp' ? 'one-time code' : field;
}

function listNames(items: BitwardenLoginItem[]): string {
    const names = items.slice(0, MAX_LISTED_NAMES)
        .map(item => `'${cleanName(item.name)}'`);

    return names.join(', ');
}

// Picks the login to use among the ones that match the page. It answers with the item, or with the text for the model.
function chooseItem(matches: BitwardenLoginItem[], hint: string | undefined): { item: BitwardenLoginItem } | { problem: string } {
    const [onlyMatch] = matches;

    if (hint === undefined) {
        if (matches.length === 1 && onlyMatch !== undefined) {
            return { item: onlyMatch };
        }

        return { problem: `Several logins match this site. Call again with item set to one of these names: ${listNames(matches)}.` };
    }

    const wanted = hint.toLowerCase();
    const named = matches.filter(item => cleanName(item.name)
        .toLowerCase() === wanted);
    const [firstNamed] = named;

    if (named.length === 1 && firstNamed !== undefined) {
        return { item: firstNamed };
    }

    if (named.length > 1) {
        return { problem: 'Several logins have that name. Ask the owner to rename one of them in Bitwarden.' };
    }

    return { problem: `No login with that name matches this site. These names do: ${listNames(matches)}.` };
}

function createFillLoginTool(dependencies: FillLoginToolDependencies): CloudbotTool<typeof FILL_LOGIN_SHAPE> {
    const { botId, browser, vault, askOwner, screen } = dependencies;

    return tool(
        FILL_LOGIN_TOOL_NAME,
        FILL_LOGIN_DESCRIPTION,
        FILL_LOGIN_SHAPE,
        async (args): Promise<SecretToolResult> => {
            if (screen?.isPersonHolding === true) {
                return textResult(SCREEN_HELD_BY_PERSON_MESSAGE, true);
            }

            if (!vault.isConfigured(botId)) {
                return textResult(NOT_SET_UP_MESSAGE, true);
            }

            try {
                // The real page decides. A site the model names is never used.
                const origin = await browser.readPageOrigin();

                if (!origin.startsWith('https://')) {
                    return textResult('A login is filled only on an https page.', true);
                }

                const logins = await vault.listLogins(botId);
                const matches = matchLoginItems(logins, origin);

                if (matches.length === 0) {
                    return textResult(`The Bitwarden vault has no login for ${origin}.`, true);
                }

                const chosen = chooseItem(matches, args.item);

                if ('problem' in chosen) {
                    return textResult(chosen.problem, true);
                }

                const { item } = chosen;
                const itemName = cleanName(item.name);

                if (args.field === 'totp' && !item.hasTotp) {
                    return textResult(`The login '${itemName}' has no one-time code saved.`, true);
                }

                if (!vault.hasApproval(botId, item.id, origin)) {
                    const summary = `Fill the ${describeFieldName(args.field)} of '${itemName}' on ${origin}?`;
                    const detail = 'If you approve, the bot can also fill the user name, the password and the one-time code of this login on this site for 10 minutes. It never sees the values.';
                    const isApproved = await askOwner(summary, detail);

                    if (!isApproved) {
                        return textResult('The owner did not approve this login, so nothing was typed. Do not try again. Tell the owner.', true);
                    }

                    vault.rememberApproval(botId, item.id, origin);
                }

                const value = await vault.getValue(botId, item.id, args.field);

                // The page is checked again while the value goes in, since the owner may have taken long to answer.
                await browser.typeLogin(origin, args.field, value);

                return textResult(`Typed the ${describeFieldName(args.field)} of '${itemName}'.`);
            } catch (error: unknown) {
                // Only the text of these errors goes back. None of it holds a value.
                if (error instanceof BrowserError || error instanceof BitwardenError) {
                    return textResult(error.message, true);
                }

                return textResult('The login could not be filled.', true);
            } finally {
                browser.takeDismissedDialogs();
            }
        },
    );
}

export { FILL_LOGIN_TOOL_FULL_NAME, FILL_LOGIN_TOOL_NAME, createFillLoginTool };
export type { FillLoginToolDependencies, LoginBrowser, LoginVault, OwnerAsker };
