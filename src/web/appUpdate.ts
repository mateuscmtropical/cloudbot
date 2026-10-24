interface AppBuild {
    moduleScript: string;
    stylesheets: string[];
}

interface ReloadRecord {
    buildId: string;
    reloadedAt: number;
}

const RELOAD_GUARD_MS = 60_000;
const HASHED_ASSET_PATTERN = /-[a-z0-9_-]{8,}\.[a-z0-9]+$/i;

function readAssetPath(source: string | null, baseUrl: string): string | undefined {
    if (source === null) {
        return undefined;
    }

    let assetUrl: URL;

    try {
        assetUrl = new URL(source, baseUrl);
    } catch {
        return undefined;
    }

    if (!assetUrl.pathname.includes('/assets/')) {
        return undefined;
    }

    return assetUrl.pathname;
}

function hasHashedAsset(assetPath: string): boolean {
    return HASHED_ASSET_PATTERN.test(assetPath);
}

function parseAppBuild(document: Document, baseUrl: string): AppBuild | undefined {
    const moduleScript = document.querySelector<HTMLScriptElement>('script[type="module"][src]');

    if (moduleScript === null) {
        return undefined;
    }

    const moduleScriptSource = moduleScript.getAttribute('src');
    const moduleScriptPath = readAssetPath(moduleScriptSource, baseUrl);

    if (moduleScriptPath === undefined) {
        return undefined;
    }

    const stylesheetElements = document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]');
    const stylesheetPaths: string[] = [];

    stylesheetElements.forEach((stylesheet) => {
        const source = stylesheet.getAttribute('href');
        const stylesheetPath = readAssetPath(source, baseUrl);

        if (stylesheetPath !== undefined) {
            stylesheetPaths.push(stylesheetPath);
        }
    });

    stylesheetPaths.sort();
    const hasHashedAssets = [moduleScriptPath, ...stylesheetPaths].some(hasHashedAsset);

    if (!hasHashedAssets) {
        return undefined;
    }

    return { moduleScript: moduleScriptPath, stylesheets: stylesheetPaths };
}

function appBuildId(build: AppBuild): string {
    return JSON.stringify({ moduleScript: build.moduleScript, stylesheets: build.stylesheets });
}

function isNewAppBuild(currentBuild: AppBuild | undefined, freshBuild: AppBuild | undefined): boolean {
    if (currentBuild === undefined || freshBuild === undefined) {
        return false;
    }

    return appBuildId(currentBuild) !== appBuildId(freshBuild);
}

function reloadGuardDelay(record: ReloadRecord | undefined, targetBuildId: string, now: number): number {
    if (record?.buildId !== targetBuildId) {
        return 0;
    }

    const elapsed = Math.max(0, now - record.reloadedAt);

    return Math.max(0, RELOAD_GUARD_MS - elapsed);
}

export { appBuildId, isNewAppBuild, parseAppBuild, reloadGuardDelay, RELOAD_GUARD_MS };
export type { AppBuild, ReloadRecord };
