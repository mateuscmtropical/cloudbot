import { createInterface } from 'node:readline';

const terminal = createInterface({ input: process.stdin });

process.stdout.write('\u001b[32mSign in:\u001b[0m https://example.com/authorize?state=fake\n');
terminal.once('line', (code) => {
    terminal.close();
    process.exit(code === 'good-code' ? 0 : 1);
});
