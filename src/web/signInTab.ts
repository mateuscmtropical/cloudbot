import type { ChatMessage } from '../shared/chatTypes.ts';
import { isSafeUrl } from './markdown.ts';

// An empty tab closes by itself when no link came by then, such as a Claude login that was already done.
const SIGN_IN_TAB_WAIT_MS = 30_000;

interface SignInTab {
    tab: Window;
    // Only a message after the tap can carry the link.
    afterSequence: number;
}

// Browsers block a tab opened after the tap, so an empty one opens now and the link goes in when the server sends it.
function openSignInTab(afterSequence: number): SignInTab | undefined {
    const tab = window.open('', '_blank');

    if (tab === null) {
        return undefined;
    }

    tab.opener = null;

    return { tab, afterSequence };
}

// Puts the sign-in link in the tab, or closes the tab when the server asked something else. True when the tab is settled.
function settleSignInTab(signInTab: SignInTab, messages: ChatMessage[]): boolean {
    const newer = messages.filter(message => message.sequence > signInTab.afterSequence && message.role !== 'user');
    const link = newer.find(message => message.body.kind === 'link');

    if (link?.body.kind === 'link' && isSafeUrl(link.body.url)) {
        signInTab.tab.location.href = link.body.url;

        return true;
    }

    const isAskedElse = newer.some(message => message.body.kind !== 'text' && message.body.kind !== 'link');

    if (isAskedElse) {
        signInTab.tab.close();
    }

    return isAskedElse;
}

export { openSignInTab, settleSignInTab, SIGN_IN_TAB_WAIT_MS };
export type { SignInTab };
