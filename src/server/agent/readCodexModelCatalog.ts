import type { ProviderModelCatalog, ProviderModelOption } from '../providers/ProviderModelCatalogs.ts';

function readRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(record: Record<string, unknown>, ...fields: string[]): string | undefined {
    const found = fields.map(field => record[field])
        .find(value => typeof value === 'string');

    return typeof found === 'string' ? found : undefined;
}

function readCodexModelCatalog(value: unknown): ProviderModelCatalog | undefined {
    const models = Array.isArray(value) ? value : [];
    const options = models.flatMap((item) => {
        const model = readRecord(item);
        const id = readString(model, 'model', 'id');

        if (id === undefined) {
            return [];
        }

        const reasoningOptions = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
        const efforts = reasoningOptions.flatMap((reasoningOption) => {
            const effortRecord = readRecord(reasoningOption);
            const effort = readString(effortRecord, 'reasoningEffort', 'id');

            return effort === undefined ? [] : [effort];
        });
        const option: ProviderModelOption = {
            id,
            label: readString(model, 'displayName', 'name') ?? id,
            efforts,
            defaultEffort: readString(model, 'defaultReasoningEffort'),
        };

        return [{ option, isDefault: model.isDefault === true }];
    });

    if (options.length === 0) {
        return undefined;
    }

    const defaultOption = options.find(item => item.isDefault) ?? options[0];

    return {
        models: options.map(item => item.option),
        defaultModel: defaultOption?.option.id ?? null,
        defaultEffort: defaultOption?.option.defaultEffort ?? null,
    };
}

export { readCodexModelCatalog };
