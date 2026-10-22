// The PreToolUse hook of the Antigravity CLI (agy), see src/server/agent/AgyEngine.ts. agy gives it each tool call
// before the call runs. It asks the CloudBot review of the turn through the loopback server and answers auto_approve
// or deny. Any failure is a deny, so a call never runs without a review.
import { request } from 'node:http';

const REVIEW_URL = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/mcp$/;
const TOKEN = /^[0-9a-f]{64}$/;

function answer(decision, reason) {
    process.stdout.write(`${JSON.stringify(reason === undefined ? { decision } : { decision, reason })}\n`);
    process.exit(0);
}

function deny(reason) {
    answer('deny', reason ?? 'CloudBot could not review this call, so it was refused.');
}

function readInput() {
    return new Promise((resolve) => {
        let text = '';

        process.stdin.on('data', (chunk) => {
            text += chunk.toString('utf8');
        });
        process.stdin.on('end', () => {
            resolve(text);
        });
    });
}

const url = REVIEW_URL.exec(process.env.CLOUDBOT_AGY_REVIEW_URL ?? '');
const token = process.env.CLOUDBOT_TOOLS_TOKEN ?? '';

if (url === null || !TOKEN.test(token)) {
    deny();
}

const input = await readInput();
let toolCall;

try {
    toolCall = JSON.parse(input).toolCall;
} catch {
    deny();
}

if (typeof toolCall?.name !== 'string') {
    deny();
}

const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: toolCall.name, input: toolCall.args ?? {} } } });
// No timeout here: the owner may take a while to answer. agy ends the hook at its own timeout, which is a deny.
const call = request({ host: '127.0.0.1', port: Number(url[1]), path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` } }, (response) => {
    let text = '';

    response.on('data', (chunk) => {
        text += chunk.toString('utf8');
    });
    response.on('end', () => {
        try {
            const decision = JSON.parse(JSON.parse(text).result.content[0].text);

            if (decision.behavior === 'allow') {
                answer('auto_approve');
            }

            deny(typeof decision.message === 'string' ? decision.message : undefined);
        } catch {
            deny();
        }
    });
});

call.on('error', () => {
    deny();
});
call.end(body);
