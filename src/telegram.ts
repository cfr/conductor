import { Bot, GrammyError, HttpError, InlineKeyboard, InputFile, type Transformer } from 'grammy';
import { escapeHtml, markdownToHtml } from './format.ts';

const maxMessage = 4000;
const maxChunks = 3;
const retryDelays = [1, 2, 5, 10, 20, 30, 60, 60].map((s) => s * 1000);

// The nested fetch error's message carries the request URL, and with it the bot token.
// getUpdates is left to the poller, which retries on its own.
export function retryNetwork(delays = retryDelays): Transformer {
    return async (prev, method, payload, signal) => {
        for (let attempt = 0; ; attempt++) {
            try {
                return await prev(method, payload, signal);
            } catch (e) {
                if (!(e instanceof HttpError) || method === 'getUpdates' || attempt >= delays.length) {
                    throw e;
                }
                console.error(`telegram: ${method} failed (${describeError(e)}); retrying`);
                await new Promise((r) => setTimeout(r, delays[attempt]));
            }
        }
    };
}

export function describeError(e: unknown): string {
    if (e instanceof HttpError) {
        const cause = (e.error as Error | undefined)?.message ?? '';
        return `${e.message} ${cause.replace(/\/bot[^/\s]+/g, '/bot***')}`.trim();
    }
    return e instanceof Error ? e.message : String(e);
}

export type CommandHandler = (args: string) => Promise<void>;
export type TextHandler = (text: string, route: string | undefined) => Promise<void>;

export interface Messenger {
    onText: TextHandler;
    command(name: string, handler: CommandHandler): void;
    send(text: string, route?: string): Promise<void>;
    sendMarkdown(prefix: string, markdown: string, route?: string): Promise<void>;
    sendQuoted(text: string, quote: string, route?: string): Promise<void>;
    sendLog(text: string, log: string, route?: string): Promise<void>;
    sendHtml(html: string, route?: string): Promise<void>;
    sendFile(name: string, content: string, caption?: string, route?: string): Promise<void>;
    ask(text: string, choices: string[], allowText: boolean): Promise<string>;
    pendingQuestions(): number;
    takeOver(text: string, commands: { command: string; description: string }[]): Promise<void>;
}

interface Pending {
    id: number;
    choices: string[];
    allowText: boolean;
    resolve(answer: string): void;
}

export function chunk(text: string, size = maxMessage): string[] {
    const out: string[] = [];
    let rest = text;
    while (rest.length > size) {
        let cut = rest.lastIndexOf('\n', size);
        if (cut < size / 2) {
            cut = size;
        }
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n/, '');
    }
    if (rest.length || out.length === 0) {
        out.push(rest);
    }
    return out;
}

function stripHtml(html: string): string {
    return html
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&');
}

export class Chat implements Messenger {
    private bot: Bot;
    private commands = new Map<string, CommandHandler>();
    private pending: Pending[] = [];
    private nextQuestion = 1;
    private routes = new Map<number, string>();
    onText: TextHandler = async () => {};
    private userId: number;

    constructor(token: string, userId: number) {
        this.userId = userId;
        this.bot = new Bot(token);
        this.bot.api.config.use(retryNetwork());
        this.bot.use(async (ctx, next) => {
            if (ctx.from?.id === this.userId) {
                await next();
            }
        });
        this.bot.on('callback_query:data', async (ctx) => {
            const m = /^q:(\d+):(\d+)$/.exec(ctx.callbackQuery.data);
            const p = m ? this.pending.find((x) => x.id === Number(m[1])) : undefined;
            await ctx.answerCallbackQuery();
            if (!m || !p) {
                return;
            }
            const answer = p.choices[Number(m[2])];
            await ctx.editMessageReplyMarkup().catch(() => {});
            await this.send(`→ ${answer}`);
            this.settle(p, answer);
        });
        this.bot.on('message:text', (ctx) => {
            const text = ctx.message.text;
            const cmd = /^\/([a-z_-]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
            if (cmd) {
                const name = cmd[1].toLowerCase().replace(/_/g, '-');
                const handler = this.commands.get(name);
                if (!handler) {
                    void this.send(`unknown command /${name}; try /help`);
                    return;
                }
                this.detach(handler((cmd[2] ?? '').trim()));
                return;
            }
            const reply = ctx.message.reply_to_message?.message_id;
            const route = reply === undefined ? undefined : this.routes.get(reply);
            const waiting = this.pending.find((p) => p.allowText);
            if (waiting && route === undefined) {
                this.settle(waiting, text);
                return;
            }
            this.detach(this.onText(text, route));
        });
        this.bot.catch((err) => console.error('telegram:', describeError(err.error)));
    }

    private detach(p: Promise<void>) {
        p.catch((e: unknown) => {
            console.error('error:', describeError(e));
            this.send(`error: ${describeError(e)}`).catch(() => {});
        });
    }

    private settle(p: Pending, answer: string) {
        this.pending = this.pending.filter((x) => x !== p);
        p.resolve(answer);
    }

    command(name: string, handler: CommandHandler) {
        this.commands.set(name, handler);
    }

    async send(text: string, route?: string): Promise<void> {
        let parts = chunk(text);
        let attachment: string | undefined;
        if (parts.length > maxChunks) {
            attachment = text;
            parts = [chunk(text, maxMessage - 200)[0] + '\n\n… (full text attached)'];
        }
        for (const part of parts) {
            const msg = await this.bot.api.sendMessage(this.userId, part, {
                link_preview_options: { is_disabled: true },
            });
            if (route) {
                this.routes.set(msg.message_id, route);
            }
        }
        if (attachment !== undefined) {
            await this.sendFile('message.md', attachment, undefined, route);
        }
    }

    sendQuoted(text: string, quote: string, route?: string): Promise<void> {
        const room = maxMessage - text.length - 100;
        const body = quote.length > room ? `${quote.slice(0, room)}… (${quote.length - room} more chars)` : quote;
        return this.sendWrapped(text, body, '<blockquote expandable>', '</blockquote>', route);
    }

    sendLog(text: string, log: string, route?: string): Promise<void> {
        if (!log) {
            return this.send(text, route);
        }
        const room = maxMessage - text.length - 100;
        const body = log.length > room ? `…${log.slice(log.length - room)}` : log;
        return this.sendWrapped(text, body, '<pre>', '</pre>', route);
    }

    async sendHtml(html: string, route?: string): Promise<void> {
        let msg;
        try {
            msg = await this.bot.api.sendMessage(this.userId, html, {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
            });
        } catch (e) {
            if (!(e instanceof GrammyError && e.error_code === 400)) {
                throw e;
            }
            msg = await this.bot.api.sendMessage(this.userId, stripHtml(html), {
                link_preview_options: { is_disabled: true },
            });
        }
        if (route) {
            this.routes.set(msg.message_id, route);
        }
    }

    private async sendWrapped(text: string, body: string, open: string, close: string, route?: string) {
        let msg;
        try {
            msg = await this.bot.api.sendMessage(this.userId, `${escapeHtml(text)}\n${open}${escapeHtml(body)}${close}`, {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
            });
        } catch (e) {
            if (!(e instanceof GrammyError && e.error_code === 400)) {
                throw e;
            }
            msg = await this.bot.api.sendMessage(this.userId, `${text}\n${body}`, {
                link_preview_options: { is_disabled: true },
            });
        }
        if (route) {
            this.routes.set(msg.message_id, route);
        }
    }

    async sendMarkdown(prefix: string, markdown: string, route?: string): Promise<void> {
        const head = `<b>${escapeHtml(prefix)}</b>\n`;
        let chunks = markdownToHtml(markdown, maxMessage - head.length);
        const attach = chunks.length > maxChunks;
        if (attach) {
            chunks = [chunks[0] + '\n\n<i>… (full text attached)</i>'];
        }
        for (const [i, html] of chunks.entries()) {
            const text = i === 0 ? head + html : html;
            let id: number;
            try {
                const msg = await this.bot.api.sendMessage(this.userId, text, {
                    parse_mode: 'HTML',
                    link_preview_options: { is_disabled: true },
                });
                id = msg.message_id;
            } catch (e) {
                if (!(e instanceof GrammyError && e.error_code === 400)) {
                    throw e;
                }
                const msg = await this.bot.api.sendMessage(this.userId, stripHtml(text), {
                    link_preview_options: { is_disabled: true },
                });
                id = msg.message_id;
            }
            if (route) {
                this.routes.set(id, route);
            }
        }
        if (attach) {
            await this.sendFile('message.md', markdown, undefined, route);
        }
    }

    async sendFile(name: string, content: string, caption?: string, route?: string) {
        const msg = await this.bot.api.sendDocument(
            this.userId,
            new InputFile(Buffer.from(content, 'utf8'), name),
            caption ? { caption: caption.slice(0, 1000) } : {},
        );
        if (route) {
            this.routes.set(msg.message_id, route);
        }
    }

    ask(text: string, choices: string[], allowText: boolean): Promise<string> {
        return new Promise((resolve) => {
            const p: Pending = { id: this.nextQuestion++, choices, allowText, resolve };
            this.pending.push(p);
            const kb = new InlineKeyboard();
            choices.forEach((c, i) => kb.text(c.slice(0, 60), `q:${p.id}:${i}`).row());
            const hint = allowText ? '\n\n(or answer in text)' : '';
            this.bot.api
                .sendMessage(this.userId, chunk(text + hint)[0], { reply_markup: kb })
                .catch((e: Error) => console.error('ask:', e.message));
        });
    }

    pendingQuestions(): number {
        return this.pending.length;
    }

    async takeOver(text: string, commands: { command: string; description: string }[]) {
        await this.bot.api.setMyCommands(commands);
        // a chat-scoped list (another bot sets one) overrides the default list in this chat
        await this.bot.api.setMyCommands(commands, { scope: { type: 'chat', chat_id: this.userId } });
        await this.bot.api.setChatMenuButton({ menu_button: { type: 'commands' } });
        await this.bot.api.setChatMenuButton({ chat_id: this.userId, menu_button: { type: 'commands' } });
        await this.bot.api.sendMessage(this.userId, text, { reply_markup: { remove_keyboard: true } });
    }

    async start(onStart: () => void) {
        try {
            await this.bot.start({ onStart, allowed_updates: ['message', 'callback_query'] });
        } catch (e) {
            if (e instanceof GrammyError && e.error_code === 409) {
                throw new Error(
                    'Another process is polling this bot token (409 Conflict). ' +
                        'Stop opencode-telegram-bot first; the token is shared.',
                );
            }
            throw e;
        }
    }

    stop() {
        void this.bot.stop();
    }
}
