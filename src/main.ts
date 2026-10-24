import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalConfig } from './config.ts';
import { Conductor } from './conductor.ts';
import { Store } from './state.ts';
import { Chat, describeError } from './telegram.ts';

const here = dirname(fileURLToPath(import.meta.url));
const configFile = resolve(process.env.CONDUCTOR_CONFIG ?? resolve(here, '..', 'config.toml'));

const local = loadLocalConfig(configFile);
const store = new Store(local.stateFile);
const chat = new Chat(local.telegram.token, local.telegram.allowedUserId);
const conductor = new Conductor(local, store, chat);

let quitting = false;

async function quit(code: number) {
    if (quitting) {
        return;
    }
    quitting = true;
    chat.stop();
    await conductor.shutdown().catch((e: Error) => console.error('shutdown:', e.message));
    process.exit(code);
}

// SIGHUP: the terminal closed; background jobs run in their own process groups and would survive.
// `on`, not `once`: npm forwards Ctrl-C's SIGINT again, and a default handler would kill us mid-stop.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => void quit(0));
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
