import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Account reads use the CLI's managed login without creating a thread or starting inference.
export function readCodexLimits(executable = 'codex', timeoutMs = 20000): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] });
        const lines = createInterface({ input: child.stdout });
        let value: unknown;
        let received = false;
        let failure: Error | undefined;
        let finished = false;
        const stop = (error?: Error) => {
            if (finished) return;
            finished = true;
            failure = error;
            child.stdin.end();
            child.kill('SIGTERM');
        };
        const timer = setTimeout(() => {
            finished = true;
            failure = new Error('Codex limits request timed out');
            child.kill('SIGKILL');
        }, timeoutMs);
        const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
        child.stdin.on('error', () => {});
        child.once('error', () => { clearTimeout(timer); lines.close(); reject(new Error('Could not start Codex CLI')); });
        child.once('close', () => {
            clearTimeout(timer);
            lines.close();
            if (failure) reject(failure);
            else if (received) resolve(value);
            else reject(new Error('Codex exited before returning limits'));
        });
        lines.on('line', (line) => {
            if (finished) return;
            let message: { id?: number; error?: { code?: number }; result?: unknown };
            try {
                const parsed: unknown = JSON.parse(line);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
                message = parsed as typeof message;
            } catch { return; }
            if (message.id !== 1 && message.id !== 2) return;
            if (message.error) {
                stop(new Error(`Codex account request failed (${message.error.code ?? 'unknown error'}); check codex login`));
            } else if (message.id === 1) {
                send({ method: 'initialized' });
                send({ method: 'account/rateLimits/read', id: 2 });
            } else {
                value = message.result;
                received = true;
                stop();
            }
        });
        send({ method: 'initialize', id: 1, params: {
            clientInfo: { name: 'conductor', title: 'Conductor', version: '0.1.0' },
        } });
    });
}
