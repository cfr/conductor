import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentConfig } from '../src/config.ts';
import { readCodexLimits } from '../src/limits-codex.ts';
import { AgentLimits, formatLimits, limitGroups, parseCodexLimits, parseDeepseekLimits, parseKimiLimits,
    parseMinimaxLimits, parseZaiLimits, readCredentials, type Credential } from '../src/limits.ts';

const reset = Date.parse('2026-11-03T03:00:00Z');
const codex = { rateLimits: { planType: 'plus', primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: reset / 1000 },
    secondary: { usedPercent: 72, windowDurationMins: 10080, resetsAt: reset / 1000 + 86400 } } };
const zai = { code: 200, success: true, data: { level: 'pro', limits: [
    { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 12000, currentValue: 2752, percentage: 22, nextResetTime: reset },
    { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 60000, currentValue: 2764, percentage: 4, nextResetTime: reset + 86400000 },
] } };
const kimi = { limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
    detail: { limit: '100', used: '88', remaining: '12', resetTime: '2026-11-03T03:00:00.123456Z' } }],
    usage: { limit: '100', used: '29', resetTime: '2026-11-04T03:00:00Z' },
    usages: { limit_5h: { used_ratio: 0, reset_time: '2026-11-03T03:00:00Z' },
        limit_7d: { used_ratio: 0 }, limit_month_total: { used_ratio: 0.0797, reset_time: '2026-12-02T00:00:00Z' },
        limit_month_code: { used_ratio: 0.05, reset_time: '2026-12-02T00:00:00Z' } } };
const minimax = { base_resp: { status_code: 0 }, model_remains: [{ model_name: 'general',
    start_time: reset - 18000000, end_time: reset, weekly_start_time: reset - 604800000, weekly_end_time: reset,
    current_interval_total_count: 0, current_interval_usage_count: 0,
    current_interval_remaining_percent: 100, current_weekly_remaining_percent: 92 }] };
const deepseek = { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '8.89' }] };

function agent(name: string, harness: AgentConfig['harness'], model: string): AgentConfig { return { name, harness, model, tag: name }; }
const agents = [agent('sol', 'codex', 'sol'), agent('terra', 'codex', 'terra'),
    agent('glm', 'opencode', 'zai-coding-plan/glm'), agent('glmf', 'opencode', 'zai-coding-plan/flash'),
    agent('kimi', 'opencode', 'kimi-code-plan-global/k3'), agent('mm', 'opencode', 'minimax-coding-plan/m3'),
    agent('mmf', 'opencode', 'minimax-coding-plan/flash'), agent('ds', 'opencode', 'deepseek/pro'), agent('dsf', 'opencode', 'deepseek/flash')];
const saved: Credential[] = ['zai-coding-plan', 'kimi-code-plan-global', 'minimax-coding-plan', 'deepseek']
    .map((integrationID) => ({ integrationID, active: true, value: { type: 'key', key: `private-${integrationID}` } }));

test('Codex uses reported window lengths and supports multiple buckets without assuming weekly limits', () => {
    const limits = parseCodexLimits(codex);
    assert.equal(limits.plan, 'plus');
    assert.deepEqual(limits.windows.map((w) => [w.name, w.usedPercent, w.resetsAt]), [
        ['5-hour', 5, reset], ['weekly', 72, reset + 86400000],
    ]);
    const multi = parseCodexLimits({ rateLimits: codex.rateLimits, rateLimitsByLimitId: {
        codex: { ...codex.rateLimits, limitId: 'codex' },
        other: { limitName: 'Other pool', primary: { usedPercent: 0, windowDurationMins: 60, resetsAt: null } },
    } });
    assert.deepEqual(multi.windows.map((w) => w.name), ['codex 5-hour', 'codex weekly', 'Other pool 1-hour']);
    assert.equal(multi.windows[2].usedPercent, 0);
    assert.equal(multi.windows[2].resetsAt, undefined);
    assert.deepEqual(parseCodexLimits({ rateLimits: { primary: { usedPercent: 25, windowDurationMins: null } } }).windows,
        [{ name: 'primary', usedPercent: 25 }]);
});

test('GLM credit counters give accurate usage rather than its rounded percentage', () => {
    const limits = parseZaiLimits(zai);
    assert.equal(limits.plan, 'pro');
    assert.deepEqual(limits.windows.map((w) => w.name), ['5-hour', 'weekly']);
    assert.equal(limits.windows[0].usedPercent, 2752 / 12000 * 100);
    assert.equal(limits.windows[0].resetsAt, reset);
    assert.throws(() => parseZaiLimits({ success: false, code: 401, msg: 'private' }), /rejected/);
});

test('Kimi live counters override zero ratios and label the code quota monthly without monthly total', () => {
    const limits = parseKimiLimits(kimi);
    assert.deepEqual(limits.windows.map((w) => [w.name, Number(w.usedPercent.toFixed(2))]), [['5-hour', 88], ['weekly', 29], ['monthly', 5]]);
    assert.equal(limits.windows[0].resetsAt, reset + 123);
    assert.equal(limits.windows[2].resetsAt, Date.parse('2026-12-02T00:00:00Z'));
    const monthly = parseKimiLimits({ usages: { limit_month_code: { used_ratio: 0 } } });
    assert.deepEqual(monthly.windows, [{ name: 'monthly', usedPercent: 0 }]);
});

test('MiniMax percentage fields work when counter totals are zero', () => {
    assert.deepEqual(parseMinimaxLimits(minimax).windows, [
        { name: '5-hour', usedPercent: 0, resetsAt: reset }, { name: 'weekly', usedPercent: 8, resetsAt: reset },
    ]);
    assert.throws(() => parseMinimaxLimits({ base_resp: { status_code: 1004 } }), /rejected/);
});

test('missing and malformed quota values never become zero or unlimited', () => {
    for (const parse of [parseCodexLimits, parseZaiLimits, parseKimiLimits, parseMinimaxLimits, parseDeepseekLimits]) {
        assert.throws(() => parse({}), /reported|rejected/);
    }
    assert.throws(() => parseCodexLimits({ rateLimits: { primary: { usedPercent: null } } }), /reported/);
    assert.throws(() => parseKimiLimits({ usage: { limit: '0', used: '0' } }), /reported/);
    assert.throws(() => parseKimiLimits({ usages: { limit_5h: { used_ratio: 'not-a-number' } } }), /reported/);
    assert.deepEqual(parseDeepseekLimits(deepseek).balances, ['8.89 USD']);
    assert.deepEqual(parseDeepseekLimits({ balance_infos: [{ currency: 'USD', total_balance: '0.00' }] }).balances, ['0.00 USD']);
});

test('aliases share a provider account report with only reported periods and reset times', () => {
    const groups = limitGroups(agents);
    assert.equal(groups.length, 5);
    assert.deepEqual(groups[0].aliases, ['sol', 'terra']);
    assert.deepEqual(groups[1].aliases, ['glm', 'glmf']);
    const text = formatLimits(groups[0], parseCodexLimits(codex), reset - 5400000);
    assert.match(text, /Codex \(sol terra\) — plus/);
    assert.match(text, /5-hour: 5% used; resets in 1h 30m\n/);
    assert.doesNotMatch(text, /2026-|UTC/);
    assert.doesNotMatch(text, /monthly|not reported/);
    assert.equal(formatLimits(groups[0], { windows: [{ name: 'primary', usedPercent: 0 }] }), 'Codex (sol terra)\n  primary: 0% used');
});

test('account queries use active credentials once, coalesce concurrent calls and refresh on the next call', async () => {
    let exports = 0, codexReads = 0;
    const urls: string[] = [];
    const sources = {
        codex: async () => { codexReads++; return codex; },
        credentials: async (url: string) => { assert.equal(url, 'http://configured-service'); exports++; return [
            { integrationID: 'deepseek', active: false, value: { type: 'key', key: 'inactive-secret' } }, ...saved,
        ]; },
        fetch: (async (input, init) => {
            const url = String(input);
            urls.push(url);
            assert.equal(init?.redirect, 'error');
            assert.ok(init?.signal);
            const provider = url.includes('z.ai') ? 'zai-coding-plan' : url.includes('kimi.com') ? 'kimi-code-plan-global' :
                url.includes('minimax.io') ? 'minimax-coding-plan' : 'deepseek';
            assert.equal(new Headers(init?.headers).get('authorization'), `Bearer private-${provider}`);
            return Response.json(provider === 'zai-coding-plan' ? zai : provider === 'kimi-code-plan-global' ? kimi :
                provider === 'minimax-coding-plan' ? minimax : deepseek);
        }) as typeof fetch,
    };
    const reader = new AgentLimits('http://configured-service', sources);
    const first = reader.read(agents);
    assert.equal(reader.read(agents), first);
    const text = await first;
    assert.equal(exports, 1); assert.equal(codexReads, 1); assert.equal(urls.length, 4);
    assert.match(text, /GLM Coding Plan \(glm glmf\) — pro/);
    assert.match(text, /MiniMax Coding Plan \(mm mmf\)/);
    assert.match(text, /DeepSeek \(ds dsf\)\n  balance: 8.89 USD/);
    assert.doesNotMatch(text, /private-|inactive-secret|not reported/);
    await reader.read(agents);
    assert.equal(exports, 2); assert.equal(codexReads, 2);
});

test('one provider failing does not hide other quotas or expose error bodies and credentials', async () => {
    const reader = new AgentLimits('http://service', {
        codex: async () => codex, credentials: async () => saved,
        fetch: async () => new Response('private-provider-response', { status: 401 }),
    });
    const text = await reader.read(agents);
    assert.match(text, /Codex \(sol terra\) — plus/);
    assert.equal(text.match(/unavailable: Quota request returned HTTP 401/g)?.length, 4);
    assert.doesNotMatch(text, /private-/);
    const unsupported = new AgentLimits('unused', { credentials: async () => { throw new Error('must not read credentials'); } });
    const unavailable = await unsupported.read([agent('opus', 'claude', 'opus'), agent('custom', 'opencode', 'custom/model')]);
    assert.equal(unavailable.match(/not supported/g)?.length, 1);
    assert.doesNotMatch(unavailable, /must not read|Claude|opus/);
    assert.equal(await unsupported.read([agent('opus', 'claude', 'opus')]), 'No usage data available for configured agents');
});

test('credential exports use the configured service and sanitize failures that contain secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-limit-credentials-'));
    const executable = join(dir, 'opencode');
    const args = join(dir, 'args.json');
    const originalPassword = process.env.OPENCODE_PASSWORD;
    delete process.env.OPENCODE_PASSWORD;
    try {
        writeFileSync(executable, `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(args)},JSON.stringify(process.argv.slice(2))+'\\n');
if(process.argv[2]==='service')console.log('fixture-password');
else {if(process.env.OPENCODE_PASSWORD!=='fixture-password')process.exit(1);console.log(${JSON.stringify(JSON.stringify(saved))});}
`, { mode: 0o700 });
        assert.deepEqual(await readCredentials('http://service', executable), saved);
        assert.deepEqual(readFileSync(args, 'utf8').trim().split('\n').map((s) => JSON.parse(s)),
            [['service', 'get', 'password'], ['auth', 'export', '--server', 'http://service']]);
        writeFileSync(executable, '#!/usr/bin/env node\nconsole.log("private-key");console.error("private-key");process.exit(1);', { mode: 0o700 });
        await assert.rejects(readCredentials('http://service', executable), (error: Error) => {
            assert.match(error.message, /Could not read OpenCode credentials/);
            assert.doesNotMatch(error.message, /private-key/);
            return true;
        });
    } finally {
        if (originalPassword === undefined) delete process.env.OPENCODE_PASSWORD;
        else process.env.OPENCODE_PASSWORD = originalPassword;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('Codex limits use the account-only handshake and reap the CLI before returning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-limit-rpc-'));
    const executable = join(dir, 'codex');
    const requests = join(dir, 'requests.jsonl');
    try {
        writeFileSync(executable, `#!/usr/bin/env node
const fs=require('fs');console.log('non-JSON diagnostic');console.log('null');console.log('[]');
require('readline').createInterface({input:process.stdin}).on('line',line=>{
  fs.appendFileSync(${JSON.stringify(requests)},line+'\\n');const m=JSON.parse(line);
  if(m.id===1)console.log(JSON.stringify({id:1,result:{}}));
  if(m.id===2){console.log(JSON.stringify({method:'notification',params:{}}));console.log(JSON.stringify({id:2,result:${JSON.stringify(codex)}}));}
});
`, { mode: 0o700 });
        assert.deepEqual(await readCodexLimits(executable), codex);
        const messages = readFileSync(requests, 'utf8').trim().split('\n').map((s) => JSON.parse(s));
        assert.deepEqual(messages.map((m) => m.method), ['initialize', 'initialized', 'account/rateLimits/read']);
        assert.equal(messages[0].params.clientInfo.name, 'conductor');
        writeFileSync(executable, '#!/usr/bin/env node\nprocess.on("SIGTERM",()=>{});setInterval(()=>{},1000);', { mode: 0o700 });
        await assert.rejects(readCodexLimits(executable, 300), /timed out/);
        writeFileSync(executable, '#!/usr/bin/env node\nconsole.log(JSON.stringify({id:1,error:{code:-1,message:"private"}}));setInterval(()=>{},1000);', { mode: 0o700 });
        await assert.rejects(readCodexLimits(executable), (error: Error) => {
            assert.match(error.message, /check codex login/); assert.doesNotMatch(error.message, /private/); return true;
        });
        await assert.rejects(readCodexLimits(join(dir, 'missing')), /Could not start/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
