import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalConfig } from './config.ts';
import { Conductor } from './conductor.ts';
import { Store } from './state.ts';
import { Chat, describeError } from './telegram.ts';

for (const level of ['log', 'error'] as const) {
    const write = console[level].bind(console);
    console[level] = (...args: unknown[]) => write(stamp(), ...args);
}

function stamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const here = dirname(fileURLToPath(import.meta.url));
const configFile = resolve(process.env.CONDUCTOR_CONFIG ?? resolve(here, '..', 'config.toml'));

const local = loadLocalConfig(configFile);
const store = new Store(local.stateFile);
const chat = new Chat(local.telegram.token, local.telegram.allowedUserId);
const conductor = new Conductor(local, store, chat);

let quitting = false;

async function quit(code: number) {
    if (quitting) {
        console.error('forced exit');
        process.exit(code || 130);
    }
    quitting = true;
    // a stuck job or Telegram call must not keep the process alive
    setTimeout(() => {
        console.error('shutdown timed out');
        process.exit(code || 1);
    }, 15000).unref();
    chat.stop();
    await conductor.shutdown().catch((e: Error) => console.error('shutdown:', e.message));
    process.exit(code);
}

// SIGHUP: the terminal closed; background jobs run in their own process groups and would survive.
// npm forwards Ctrl-C's SIGINT too, so one keypress can arrive twice: a second signal within a
// second of the first is that echo, not a request to force.
let firstSignal = 0;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
        if (quitting && Date.now() - firstSignal < 1000) {
            return;
        }
        if (!quitting) {
            firstSignal = Date.now();
            console.log(`${sig}: stopping (Ctrl-C again to force)`);
        }
        void quit(0);
    });
}

// A failure nothing awaited (a Telegram send that ran out of retries) must not kill running agent turns.
process.on('unhandledRejection', (e) => console.error('unhandled:', describeError(e)));

try {
    await chat.start(() => {
        console.log(`conductor: polling Telegram for ${local.project}`);
        conductor.announce().catch((e: Error) => console.error('announce:', e.message));
    });
} catch (e) {
    console.error(describeError(e));
    await quit(1);
}
