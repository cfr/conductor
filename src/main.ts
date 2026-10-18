import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalConfig } from './config.ts';
import { Conductor } from './conductor.ts';
import { Store } from './state.ts';
import { Chat } from './telegram.ts';

const here = dirname(fileURLToPath(import.meta.url));
const configFile = resolve(process.env.CONDUCTOR_CONFIG ?? resolve(here, '..', 'conductor.toml'));

const local = loadLocalConfig(configFile);
const store = new Store(local.stateFile);
const chat = new Chat(local.telegram.token, local.telegram.allowedUserId);
const conductor = new Conductor(local, store, chat);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
        chat.stop();
        void conductor.shutdown().finally(() => process.exit(0));
    });
}

await chat.start(() => {
    console.log(`conductor: polling Telegram for ${local.project}`);
    conductor.announce().catch((e: Error) => console.error('announce:', e.message));
});
