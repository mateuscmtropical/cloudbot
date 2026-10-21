// The interpreters an integration may run. The model picks one of these, never a path.
const INTEGRATION_COMMANDS = ['node', 'python3', 'bash'] as const;

type IntegrationCommand = (typeof INTEGRATION_COMMANDS)[number];

export { INTEGRATION_COMMANDS };
export type { IntegrationCommand };
