import { spawn } from 'node:child_process';

export interface RunResult {
    code: number;
    output: string;
}

export function run(
    cmd: string,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        child.stdout.on('data', (b: Buffer) => chunks.push(b));
        child.stderr.on('data', (b: Buffer) => chunks.push(b));
        child.on('error', reject);
        child.on('close', (code) => {
            resolve({ code: code ?? -1, output: Buffer.concat(chunks).toString('utf8') });
        });
    });
}

export function shell(cmd: string, cwd: string, signal?: AbortSignal): Promise<RunResult> {
    return run('sh', ['-c', cmd], cwd, signal);
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
    const r = await run('git', args, cwd);
    if (r.code !== 0) {
        throw new Error(`git ${args.join(' ')}: ${r.output.trim()}`);
    }
    return r.output;
}

export function tail(text: string, lines: number): string {
    const all = text.trimEnd().split('\n');
    return all.slice(-lines).join('\n');
}
