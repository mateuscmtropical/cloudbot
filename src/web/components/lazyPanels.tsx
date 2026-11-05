import { Suspense, createElement } from 'react';
import type { ComponentProps, ReactElement } from 'react';

import { lazyPanel } from '../lazyPanel.ts';

// Loaded on first use, because most visits only chat. They take the app logos and the settings forms with them.
const lazyConnectAppsPanel = lazyPanel(async () => {
    const panelModule = await import('./ConnectAppsPanel.tsx');

    return panelModule.ConnectAppsPanel;
});
const lazyAccountPanel = lazyPanel(async () => {
    const panelModule = await import('./AccountPanel.tsx');

    return panelModule.AccountPanel;
});
const lazyBotProfilePanel = lazyPanel(async () => {
    const panelModule = await import('./BotProfilePanel.tsx');

    return panelModule.BotProfilePanel;
});
const lazyActionLogPanel = lazyPanel(async () => {
    const panelModule = await import('./ActionLogPanel.tsx');

    return panelModule.ActionLogPanel;
});
const lazyAppUpdatePanel = lazyPanel(async () => {
    const panelModule = await import('./AppUpdatePanel.tsx');

    return panelModule.AppUpdatePanel;
});
const lazyPeoplePanel = lazyPanel(async () => {
    const panelModule = await import('./PeoplePanel.tsx');

    return panelModule.PeoplePanel;
});

const LOADING = <p className="panel-loading" role="status">Loading...</p>;

function ConnectAppsPanel(props: ComponentProps<typeof lazyConnectAppsPanel>): ReactElement {
    return <Suspense fallback={LOADING}>{createElement(lazyConnectAppsPanel, props)}</Suspense>;
}

function AccountPanel(props: ComponentProps<typeof lazyAccountPanel>): ReactElement {
    return <Suspense fallback={LOADING}>{createElement(lazyAccountPanel, props)}</Suspense>;
}

function BotProfilePanel(props: ComponentProps<typeof lazyBotProfilePanel>): ReactElement {
    return <Suspense fallback={LOADING}>{createElement(lazyBotProfilePanel, props)}</Suspense>;
}

function ActionLogPanel(props: ComponentProps<typeof lazyActionLogPanel>): ReactElement {
    return <Suspense fallback={LOADING}>{createElement(lazyActionLogPanel, props)}</Suspense>;
}

function AppUpdatePanel(props: ComponentProps<typeof lazyAppUpdatePanel>): ReactElement {
    return <Suspense fallback={LOADING}>{createElement(lazyAppUpdatePanel, props)}</Suspense>;
}

function PeoplePanel(props: ComponentProps<typeof lazyPeoplePanel>): ReactElement {
    return <Suspense fallback={LOADING}>{createElement(lazyPeoplePanel, props)}</Suspense>;
}

export { AccountPanel, ActionLogPanel, AppUpdatePanel, BotProfilePanel, ConnectAppsPanel, PeoplePanel };
