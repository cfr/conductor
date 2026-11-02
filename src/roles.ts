import { parse } from 'smol-toml';
import { parseProjectConfig, type ProjectConfig } from './config.ts';

export type DefaultRole = keyof ProjectConfig['roles'];
export const defaultRoles: DefaultRole[] = ['implement', 'feedback', 'review', 'plan', 'chat', 'summary'];

export function swapRoleDefaults(root: string, text: string, first: string, second: string): string {
    if (first === second) throw new Error('choose two different agents to swap');
    const config = parseProjectConfig(root, text);
    const assignment = (name: string) => {
        if (!config.agents.has(name)) throw new Error(`unknown agent "${name}"; see /agents`);
        const found = defaultRoles.flatMap((role) => {
            const value = config.roles[role];
            const names = Array.isArray(value) ? value : [value];
            return names.flatMap((agent, index) => agent === name ? [{ role, index }] : []);
        });
        if (found.length !== 1) {
            const labels = found.map(({ role, index }) => role === 'feedback' ? `${role}[${index + 1}]` : role);
            throw new Error(`${name} must have exactly one role assignment; found ${labels.join(', ') || 'none'}. Use /roles for explicit changes.`);
        }
        return found[0];
    };
    const a = assignment(first);
    const b = assignment(second);
    const updates = new Map<DefaultRole, string[]>();
    for (const [slot, replacement] of [[a, second], [b, first]] as const) {
        if (!updates.has(slot.role)) {
            const value = config.roles[slot.role];
            updates.set(slot.role, Array.isArray(value) ? [...value] : [value]);
        }
        updates.get(slot.role)![slot.index] = replacement;
    }
    let updated = text;
    for (const [role, names] of updates) updated = editRoleDefaults(root, updated, role, names);
    const result = parseProjectConfig(root, updated);
    for (const role of defaultRoles) {
        const desired = config.roles[role];
        const replace = (name: string) => name === first ? second : name === second ? first : name;
        const expected = Array.isArray(desired) ? desired.map(replace) : replace(desired);
        if (JSON.stringify(result.roles[role]) !== JSON.stringify(expected)) throw new Error('swap would change inherited roles ambiguously');
    }
    return updated;
}

export function onlyRoleChanges(before: string, after: string): boolean {
    const outsideRoles = (text: string): string | undefined => {
        const lines = text.split('\n');
        const start = lines.findIndex((line) => /^\s*\[roles\]\s*(?:#.*)?$/.test(line));
        if (start < 0) return undefined;
        let end = start + 1;
        while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
        return [...lines.slice(0, start + 1), ...lines.slice(end)].join('\n');
    };
    if (outsideRoles(before) === undefined || outsideRoles(before) !== outsideRoles(after)) return false;
    const extras = (text: string) => Object.entries((parse(text).roles ?? {}) as Record<string, unknown>)
        .filter(([key]) => !defaultRoles.includes(key as DefaultRole));
    return JSON.stringify(extras(before)) === JSON.stringify(extras(after));
}

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
