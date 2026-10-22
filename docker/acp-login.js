// Signs in to an ACP agent with one of its own auth methods, for a CLI without a login command, such as Mistral Vibe.
// It sends initialize and authenticate, prints what the agent prints so the server can read the link, and passes its
// own input to the agent, so a code the owner pastes reaches a CLI that asks for one, such as the Gemini CLI.
// It ends with 0 when the agent accepted the sign-in.
'use strict';

const { spawn } = require('node:child_process');
const [methodId, command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '';

function send(message) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

child.on('exit', () => {
    process.exit(1);
});
child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');

    buffer = lines.pop() ?? '';
    lines.forEach((line) => {
        let message;

        try {
            message = JSON.parse(line);
        } catch {
            process.stderr.write(`${line}\n`);

            return;
        }

        if (message.id === 1 && message.result !== undefined) {
            send({ id: 2, method: 'authenticate', params: { methodId } });
        }

        if (message.id === 2) {
            child.kill('SIGTERM');
            process.exit(message.error === undefined ? 0 : 1);
        }
    });
});
process.stdin.on('data', (chunk) => {
    child.stdin.write(chunk);
});
send({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } });