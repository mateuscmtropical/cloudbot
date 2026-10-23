import type { ProviderId } from './providerIds.ts';

interface ProviderModelOption {
    id: string;
    label: string;
    efforts: string[];
    defaultEffort?: string | undefined;
}

interface ProviderModelCatalog {
    models: ProviderModelOption[];
    defaultModel: string | null;
    defaultEffort: string | null;
    currentModel?: string | null | undefined;
    currentEffort?: string | null | undefined;
    modelConfigId?: string | undefined;
    effortConfigId?: string | undefined;
    usesLegacySetModel?: boolean | undefined;
}

class ProviderModelCatalogs {
    private readonly catalogs = new Map<ProviderId, ProviderModelCatalog>();
    private readonly methods = new Map<ProviderId, string | undefined>();
    private readonly revisions = new Map<ProviderId, number>();

    get(provider: ProviderId): ProviderModelCatalog | undefined {
        return this.catalogs.get(provider);
    }

    clear(provider: ProviderId): void {
        this.catalogs.delete(provider);
        this.revisions.set(provider, this.revision(provider) + 1);
    }

    revision(provider: ProviderId): number {
        return this.revisions.get(provider) ?? 0;
    }

    getIfRevision(provider: ProviderId, revision: number): ProviderModelCatalog | undefined {
        return revision === this.revision(provider) ? this.get(provider) : undefined;
    }

    useMethod(provider: ProviderId, method: string | undefined): void {
        if (this.methods.has(provider) && this.methods.get(provider) !== method) {
            this.clear(provider);
        }

        this.methods.set(provider, method);
    }

    setIfRevision(provider: ProviderId, catalog: ProviderModelCatalog, revision: number): ProviderModelCatalog | undefined {
        if (revision !== this.revision(provider)) {
            return undefined;
        }

        return this.set(provider, catalog);
    }

    set(provider: ProviderId, catalog: ProviderModelCatalog): ProviderModelCatalog | undefined {
        if (catalog.models.length === 0) {
            return this.catalogs.get(provider);
        }

        const previous = this.catalogs.get(provider);
        const keepPreviousDefault = previous?.defaultModel !== null && previous?.defaultModel !== undefined
            && catalog.models.some(model => model.id === previous.defaultModel);
        const saved = previous === undefined
            ? catalog
            : {
                    ...catalog,
                    defaultModel: keepPreviousDefault ? previous.defaultModel : catalog.defaultModel,
                    defaultEffort: keepPreviousDefault ? previous.defaultEffort : catalog.defaultEffort,
                };

        this.catalogs.set(provider, saved);

        return saved;
    }
}

export { ProviderModelCatalogs };
export type { ProviderModelCatalog, ProviderModelOption };
