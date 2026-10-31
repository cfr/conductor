import { parse } from 'smol-toml';
import { parseProjectConfig, type ProjectConfig } from './config.ts';

export type DefaultRole = keyof ProjectConfig['roles'];
export const defaultRoles: DefaultRole[] = ['implement', 'feedback', 'review', 'plan', 'chat', 'summary'];

// Replace only the selected assignment, keeping comments and unrelated configuration intact.
export function editRoleDefaults(root: string, text: string, role: string, names: string[]): string {
    if (!defaultRoles.includes(role as DefaultRole)) throw new Error(`unknown role "${role}"`);
    if (!names.length) throw new Error(`${role} requires at least one agent`);
    if (role !== 'feedback' && names.length !== 1) throw new Error(`${role} requires exactly one agent`);
    const config = parseProjectConfig(root, text);
    for (const name of names) if (!config.agents.has(name)) throw new Error(`unknown agent "${name}"; see /agents`);
    const lines = text.split('\n');
    const start = lines.findIndex((line) => /^\s*\[roles\]\s*(?:#.*)?$/.test(line));
    if (start < 0) throw new Error('add a [roles] table to CONDUCTOR.toml before editing roles');
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    const key = new RegExp(`^\\s*(?:${role}|"${role}"|'${role}')\\s*=`);
    const at = lines.findIndex((line, i) => i > start && i < end && key.test(line));
    const value = role === 'feedback' ? JSON.stringify(names) : JSON.stringify(names[0]);
    const replacement = `${role} = ${value}`;
    if (at < 0) lines.splice(start + 1, 0, replacement);
    else {
        let last = at;
        for (;;) {
            try { parse(lines.slice(at, last + 1).join('\n')); break; }
            catch { if (++last >= end) throw new Error(`cannot safely edit roles.${role}`); }
        }
        lines.splice(at, last - at + 1, replacement);
    }
    const result = lines.join('\n');
    const updated = parseProjectConfig(root, result);
    if (JSON.stringify(updated.roles[role as DefaultRole]) !== JSON.stringify(role === 'feedback' ? names : names[0])) {
        throw new Error(`could not update roles.${role}`);
    }
    return result;
}
