// Signs in to the Antigravity CLI (agy), which has no login command. Its own screen signs in when it starts without a
// sign-in, and it needs a terminal, so it runs under script(1). This picks Google OAuth, prints the link once for the
// server, passes a code the owner pastes and ends with 0 when agy saved a sign-in.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

const AGY = '/usr/local/bin/agy';
// agy keeps its sign-in in this file, see the Antigravity CLI docs.
const SIGN_IN_FILE = join(process.env.HOME ?? '/tmp', '.gemini', 'antigravity-cli', 'antigravity-oauth-token');

// `--status` only answers whether a sign-in is saved, with no agy started.
if (process.argv.includes('--status')) {
    process.exit(hasSignIn() ? 0 : 1);
}

// A wide terminal, so the link is printed on one line.
const child = spawn('script', ['-qfc', `stty cols 4000 rows 50; exec ${AGY}`, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
let screen = '';
let isMenuAnswered = false;
let isLinkPrinted = false;
let isCodeSent = false;

function hasSignIn() {
    return existsSync(SIGN_IN_FILE);
}

function finish(code) {
    child.kill('SIGKILL');
    process.exit(code);
}

function onOutput(chunk) {
    const text = chunk.toString('utf8');

    screen = `${screen}${stripVTControlCharacters(text)}`.slice(-20000);

    if (!isMenuAnswered && /Select login method/i.test(screen)) {
        isMenuAnswered = true;
        child.stdin.write('\r');
    }

    const link = /https:\/\/accounts\.google\.com\/\S+/.exec(screen);

    if (!isLinkPrinted && link !== null && /redirect_uri=\S+&/.test(link[0])) {
        isLinkPrinted = true;
        process.stdout.write(`Please visit the following URL to authorize the application:\n${link[0]}\nEnter the authorization code:\n`);
    }

    if (isCodeSent && /Got an error|invalid_grant|failed/i.test(screen)) {
        process.stdout.write('Failed to authenticate with the authorization code.\n');
        finish(1);
    }
}

child.stdout.on('data', onOutput);
child.stderr.on('data', onOutput);
child.on('exit', () => {
    process.exit(hasSignIn() ? 0 : 1);
});
process.stdin.on('data', (chunk) => {
    const code = chunk.toString('utf8')
        .trim();

    if (code === '') {
        return;
    }

    isCodeSent = true;
    screen = '';
    child.stdin.write(`${code}\r`);
});
setInterval(() => {
    if (hasSignIn()) {
        finish(0);
    }
}, 1000);
