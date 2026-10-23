import type { ProviderModelCatalog, ProviderModelOption } from '../providers/ProviderModelCatalogs.ts';

interface ConfigOption {
    id: string;
    category: string | undefined;
    name: string;
    currentValue: string | undefined;
    options: ProviderModelOption[];
}

function readRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(record: Record<string, unknown>, ...fields: string[]): string | undefined {
    const found = fields.map(field => record[field])
        .find(value => typeof value === 'string');

    return typeof found === 'string' ? found : undefined;
}

function readSelectOptions(value: unknown): ProviderModelOption[] {
    const options = Array.isArray(value) ? value : [];
    const flattened = options.flatMap((option) => {
        const record = readRecord(option);

        const nestedOptions: unknown[] = Array.isArray(record.options) ? record.options as unknown[] : [option];

        return nestedOptions;
    });

    return flattened.flatMap((option) => {
        const record = readRecord(option);
        const id = readString(record, 'value', 'id');

        return id === undefined ? [] : [{ id, label: readString(record, 'name', 'label') ?? id, efforts: [] }];
    });
}

function readConfigOption(value: unknown): ConfigOption | undefined {
    const record = readRecord(value);
    const id = readString(record, 'id', 'configId');

    if (id === undefined || record.type !== 'select') {
        return undefined;
    }

    return {
        id,
        category: readString(record, 'category'),
        name: readString(record, 'name') ?? id,
        currentValue: readString(record, 'currentValue'),
        options: readSelectOptions(record.options),
    };
}

function readLegacyModels(value: unknown): { models: ProviderModelOption[]; currentModel: string | undefined } {
    const record = readRecord(value);
    const available = Array.isArray(record.availableModels) ? record.availableModels : [];
    const models = available.flatMap((item) => {
        const model = readRecord(item);
        const id = readString(model, 'modelId', 'id');

        return id === undefined ? [] : [{ id, label: readString(model, 'name', 'label') ?? id, efforts: [] }];
    });

    return { models, currentModel: readString(record, 'currentModelId', 'currentModel') };
}

function readAcpModelCatalog(value: unknown): ProviderModelCatalog | undefined {
    const result = readRecord(value);
    const rawOptions = Array.isArray(result.configOptions) ? result.configOptions : [];
    const configOptions = rawOptions.map(readConfigOption)
        .filter((option): option is ConfigOption => option !== undefined);
    const modelOption = configOptions.find(option => option.category === 'model' || option.id === 'model');
    const effortOption = configOptions.find((option) => {
        const category = option.category?.toLowerCase() ?? '';
        const identity = `${option.id} ${option.name}`.toLowerCase();

        return category === 'thought_level' || category === 'effort' || /effort|thinking/.test(identity);
    });
    const legacy = readLegacyModels(result.models);
    const listedModels: ProviderModelOption[] = modelOption === undefined ? legacy.models : modelOption.options;

    if (listedModels.length === 0) {
        return undefined;
    }

    const effortIds = effortOption?.options.map(option => option.id) ?? [];
    const models = listedModels.map(option => ({ ...option, efforts: option.efforts.length === 0 ? effortIds : option.efforts }));
    const currentModel = modelOption?.currentValue ?? legacy.currentModel ?? models[0]?.id ?? null;
    const currentEffort = effortOption?.currentValue ?? null;

    return {
        models,
        defaultModel: currentModel,
        defaultEffort: currentEffort,
        currentModel,
        currentEffort,
        ...(modelOption === undefined ? { usesLegacySetModel: true } : { modelConfigId: modelOption.id }),
        ...(effortOption === undefined ? {} : { effortConfigId: effortOption.id }),
    };
}

export { readAcpModelCatalog };
