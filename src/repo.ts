import type { GateStep } from './config.ts';
import { git, shell } from './proc.ts';

export async function head(root: string): Promise<string> {
    return (await git(root, 'rev-parse', 'HEAD')).trim();
}

export async function commitsSince(root: string, from: string): Promise<string[]> {
    const out = await git(root, 'log', '--format=%H', `${from}..HEAD`);
    return out.split('\n').filter(Boolean);
}

export async function commitMessages(root: string, from: string): Promise<string> {
    return (await git(root, 'log', '--reverse', '--format=%h %B', `${from}..HEAD`)).trim();
}

export async function diffStat(root: string, from: string): Promise<string> {
    return (await git(root, 'diff', '--stat', from, 'HEAD')).trimEnd();
}

export async function diff(root: string, from: string): Promise<string> {
    return git(root, 'diff', from, 'HEAD');
}

export async function status(root: string): Promise<string> {
    return (await git(root, 'status', '--short')).trimEnd();
}

export async function changedSince(root: string, from: string): Promise<string[]> {
    const out = await git(root, 'diff', '--name-only', from);
    return out.split('\n').filter(Boolean);
}

export async function fileDiff(root: string, file: string): Promise<string> {
    return git(root, 'diff', 'HEAD', '--', file);
}

export interface GateResult {
    ok: boolean;
    failedStep?: string;
    log: string;
    seconds: number;
}

export async function runGate(root: string, steps: GateStep[]): Promise<GateResult> {
    const started = Date.now();
    let log = '';
    for (const step of steps) {
        const r = await shell(step.cmd, root);
        log += `$ ${step.cmd}\n${r.output}\n[exit ${r.code}]\n\n`;
        if (r.code !== 0) {
            return { ok: false, failedStep: step.name, log, seconds: (Date.now() - started) / 1000 };
        }
    }
    return { ok: true, log, seconds: (Date.now() - started) / 1000 };
}
