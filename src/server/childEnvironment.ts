// What a child process, such as the CLI of a provider, takes from the server's own environment.
// Settings come from config.ts. These three pass the live process values on and configure nothing,
// and they are the only reads of process.env outside config.ts.

// Callers filter it, see filterOwnerEnvironment, so no secret of the server reaches the child.
function inheritedEnvironment(): NodeJS.ProcessEnv {
    return process.env;
}

function childPath(): string {
    return process.env.PATH ?? '';
}

function childHome(): string {
    return process.env.HOME ?? '/';
}

export { childHome, childPath, inheritedEnvironment };
