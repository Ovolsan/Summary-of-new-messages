/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, sendBotMessage, unregisterCommand } from "@api/Commands";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { sendMessage } from "@utils/discord";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Channel, Message } from "@vencord/discord-types";
import {
    ChannelStore,
    GuildStore,
    ReadStateStore,
    RestAPI,
    SelectedChannelStore,
    Menu,
} from "@webpack/common";

const DEFAULT_PROMPT = `Ты — помощник для разбора непрочитанных сообщений в Discord.
Составь КОМПАКТНУЮ, но информативную сводку того, что произошло, пока пользователь не читал сообщения. Не делай лишних пустых строк.

Правила:
1. Объединяй сообщения в важные темы, а не пересказывай каждое сообщение.
2. Для каждой действительно важной темы добавляй ссылки на 1–3 наиболее релевантных исходных сообщения.
3. Используй ТОЛЬКО ссылки, которые присутствуют во входных данных. Никогда не придумывай URL.
4. Отдельно выделяй:
   - решения и договорённости;
   - задачи/просьбы, требующие действий;
   - вопросы, адресованные пользователю;
   - важные изменения, объявления и предупреждения.
5. Если тема несущественная, не включай её.
6. Не выдумывай отсутствующий контекст и явно отмечай неопределённость.
7. Группируй результат по серверу и каналу.
8. В конце сделай раздел «Требует внимания», если есть такие сообщения.
9. Пиши на русском языке.
10. Форматируй ответ Markdown.

Для ссылок используй обычный Markdown, но НИКОГДА не показывай URL пользователю как текст. Для каждой важной темы делай ссылку с понятным названием, например: [Sexy king добавил бота на сервер](ТОЧНЫЙ_URL_ИЗ_ВХОДНЫХ_ДАННЫХ). URL должен находиться только внутри круглых скобок Markdown-ссылки. Не используй HTML-теги, target, rel и не выводи голый https://discord.com/... в тексте.`;

const settings = definePluginSettings({
    apiKey: {
        type: OptionType.STRING,
        description: "Ключ API Gemini",
        default: "",
    },
    model: {
        type: OptionType.SELECT,
        description: "Модель Gemini",
        default: "gemini-2.5-flash",
        options: [
            { label: "Gemini 2.5 Flash", value: "gemini-2.5-flash", default: true },
            { label: "Gemini 2.5 Pro", value: "gemini-2.5-pro" },
            { label: "Gemini 3 Flash", value: "gemini-3-flash-preview" },
        ],
    },
    prompt: {
        type: OptionType.STRING,
        description: "Промпт для формирования сводки",
        default: DEFAULT_PROMPT,
        multiline: true,
    },
    maxMessagesPerChannel: {
        type: OptionType.NUMBER,
        description: "Максимальное количество непрочитанных сообщений на канал",
        default: 500,
    },
    openSeparateWindow: {
        type: OptionType.BOOLEAN,
        description: "Открывать готовую сводку в отдельном окне Discord",
        default: true,
    },
    windowWidth: {
        type: OptionType.NUMBER,
        description: "Ширина окна сводки (пикселей)",
        default: 980,
    },
    windowHeight: {
        type: OptionType.NUMBER,
        description: "Высота окна сводки (пикселей)",
        default: 760,
    },
    sendToChat: {
        type: OptionType.BOOLEAN,
        description: "Отправлять готовую сводку обычным сообщением в Discord вместо сообщения, видимого только вам",
        default: false,
    },
});


const Native = VencordNative.pluginHelpers["Summary of new messages"] as PluginNative<typeof import("./native")>;

const COMMAND_NAME = "summarize-unread";
interface DiscordMessage extends Message {
    id: string;
    channel_id: string;
    content: string;
    author?: {
        id: string;
        username?: string;
        global_name?: string;
    };
}

interface ChannelBatch {
    channel: Channel;
    messages: DiscordMessage[];
}

function chunkText(text: string, max = 1900): string[] {
    if (text.length <= max) return [text];

    const result: string[] = [];
    let rest = text;

    while (rest.length > max) {
        let cut = rest.lastIndexOf("\n", max);
        if (cut < Math.floor(max * 0.5)) cut = rest.lastIndexOf(" ", max);
        if (cut < Math.floor(max * 0.5)) cut = max;

        result.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }

    if (rest) result.push(rest);
    return result;
}

function getChannelLabel(channel: Channel): string {
    if ((channel as any).name) return `#${(channel as any).name}`;

    const recipients = (channel as any).recipients;
    if (Array.isArray(recipients) && recipients.length > 0) {
        const first = recipients[0];
        return first?.global_name || first?.username || "Личные сообщения";
    }

    return `Канал ${channel.id}`;
}

function getMessageUrl(channel: Channel, messageId: string): string {
    const guildId = (channel as any).guild_id;
    return `https://discord.com/channels/${guildId || "@me"}/${channel.id}/${messageId}`;
}

function messageToPrompt(channel: Channel, message: DiscordMessage): string {
    const author = message.author?.global_name || message.author?.username || "Неизвестный пользователь";
    const content = (message.content || "").trim() || "[сообщение без текста / вложение]";
    return `[MESSAGE ${message.id}] ${author}: ${content}\nURL: ${getMessageUrl(channel, message.id)}`;
}

async function fetchUnreadMessages(channel: Channel): Promise<DiscordMessage[]> {
    const max = Math.max(1, Math.min(5000, Math.floor(settings.store.maxMessagesPerChannel || 500)));
    const oldestUnread = ReadStateStore.getOldestUnreadMessageId(channel.id);

    if (!oldestUnread) return [];

    const result: DiscordMessage[] = [];
    let after = ReadStateStore.getTrackedAckMessageId(channel.id) || undefined;

    // If Discord has no tracked ack, use the oldest unread message as an anchor.
    // We fetch it separately with `around`, then continue with `after`.
    if (!after) {
        const around = await RestAPI.get({
            url: `/channels/${channel.id}/messages`,
            query: { limit: 1, around: oldestUnread },
        }) as { body?: DiscordMessage[]; };

        if (Array.isArray(around.body)) {
            result.push(...around.body.filter(m => m.id === oldestUnread));
        }
        after = oldestUnread;
    }

    while (result.length < max) {
        const response = await RestAPI.get({
            url: `/channels/${channel.id}/messages`,
            query: {
                limit: Math.min(100, max - result.length),
                ...(after ? { after } : {}),
            },
        }) as { body?: DiscordMessage[]; };

        const batch = Array.isArray(response.body) ? response.body : [];
        if (!batch.length) break;

        // Discord returns newest-first.
        const ascending = [...batch].sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)));
        result.push(...ascending);
        after = ascending[ascending.length - 1].id;

        if (batch.length < 100) break;
    }

    // Keep only the unread range and remove duplicates.
    const seen = new Set<string>();
    return result
        .filter(message => {
            if (seen.has(message.id)) return false;
            seen.add(message.id);
            return BigInt(message.id) >= BigInt(oldestUnread);
        })
        .slice(0, max);
}

async function collectUnread(filterChannelId?: string, filterGuildId?: string): Promise<ChannelBatch[]> {
    const states = ReadStateStore.getAllReadStates(true);
    const batches: ChannelBatch[] = [];

    for (const state of states) {
        if (!state.channelId || !ReadStateStore.hasUnread(state.channelId)) continue;
        if (filterChannelId && state.channelId !== filterChannelId) continue;

        const channel = ChannelStore.getChannel(state.channelId);
        if (!channel) continue;

        const guildId = (channel as any).guild_id;
        if (filterGuildId && guildId !== filterGuildId) continue;

        const messages = await fetchUnreadMessages(channel);
        if (messages.length) batches.push({ channel, messages });
    }

    return batches;
}

function buildInput(batches: ChannelBatch[]): string {
    const sections = batches.map(({ channel, messages }) => {
        const guildId = (channel as any).guild_id;
        const guildName = guildId ? GuildStore.getGuild(guildId)?.name || "Неизвестный сервер" : "Личные сообщения";

        return [
            `=== SERVER: ${guildName} ===`,
            `=== CHANNEL: ${getChannelLabel(channel)} (ID: ${channel.id}) ===`,
            ...messages.map(message => messageToPrompt(channel, message)),
        ].join("\n");
    });

    return `${settings.store.prompt.trim()}\n\nНиже исходные новые сообщения.\n\n${sections.join("\n\n")}`;
}

async function callGemini(input: string): Promise<string> {
    const apiKey = settings.store.apiKey.trim();
    if (!apiKey) throw new Error("Не указан Gemini API key.");

    const model = settings.store.model || "gemini-2.5-flash";
    const result = await Native.generateContent(model, apiKey, input);

    if (!result.success) {
        throw new Error(result.error);
    }

    return result.text;
}
async function showLocalStatus(text: string, channelId: string, title: string) {
    if (settings.store.openSeparateWindow && !settings.store.sendToChat) {
        await Native.openSummaryWindow(
            title,
            text,
            Math.max(600, Math.min(2400, Math.floor(settings.store.windowWidth || 980))),
            Math.max(450, Math.min(1600, Math.floor(settings.store.windowHeight || 760))),
        );
        return;
    }

    if (settings.store.sendToChat) {
        await sendMessage(channelId, { content: text });
    } else {
        sendBotMessage(channelId, { content: text });
    }
}

async function showSummary(text: string, channelId: string, title: string) {
    if (settings.store.openSeparateWindow && !settings.store.sendToChat) {
        await Native.openSummaryWindow(
            title,
            text,
            Math.max(600, Math.min(2400, Math.floor(settings.store.windowWidth || 980))),
            Math.max(450, Math.min(1600, Math.floor(settings.store.windowHeight || 760))),
        );
        return;
    }

    const chunks = chunkText(text);
    if (settings.store.sendToChat) {
        for (const chunk of chunks) {
            await sendMessage(channelId, { content: chunk });
        }
    } else {
        for (const chunk of chunks) {
            sendBotMessage(channelId, { content: chunk });
        }
    }
}

async function summarizeScope(channelId: string, title: string, filterChannelId?: string, filterGuildId?: string) {
    try {
        await showLocalStatus("⏳ Ищу новые сообщения…", channelId, title);
        const batches = await collectUnread(filterChannelId, filterGuildId);

        if (!batches.length) {
            await showLocalStatus("📭 В выбранной области новых сообщений для сводки не найдено.", channelId, title);
            return;
        }

        const messageCount = batches.reduce((sum, batch) => sum + batch.messages.length, 0);
        await showLocalStatus(
            `⏳ Формирую сводку: ${messageCount} новых сообщений из ${batches.length} каналов…`,
            channelId,
            title,
        );

        const summary = await callGemini(buildInput(batches));
        await showSummary(summary, channelId, title);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await showLocalStatus(`❌ Ошибка при создании сводки: ${message}`, channelId, title);
    }
}

async function summarizeUnread(channelId: string) {
    await summarizeScope(channelId, "Сводка новых сообщений");
}

const channelContextMenu: NavContextMenuPatchCallback = (children, props) => {
    if (!props?.channel) return;

    const channel = props.channel as Channel;
    const item = (
        <Menu.MenuItem
            id="discord-unread-summary-channel"
            label="📋Сводка новых сообщений"
            action={() => {
                void summarizeScope(
                    channel.id,
                    `Сводка канала ${getChannelLabel(channel)}`,
                    channel.id,
                );
            }}
        />
    );

    const group = findGroupChildrenByChildId(["mark-channel-read", "mute-channel", "unmute-channel"], children);
    if (group) group.push(item);
    else children.push(<Menu.MenuGroup>{item}</Menu.MenuGroup>);
};

const guildContextMenu: NavContextMenuPatchCallback = (children, props) => {
    if (!props?.guild) return;

    const guild = props.guild;
    const item = (
        <Menu.MenuItem
            id="discord-unread-summary-guild"
            label="📋 Сводка новых сообщений сервера"
            action={() => {
                const selectedChannelId = SelectedChannelStore.getChannelId();
                if (!selectedChannelId) return;

                void summarizeScope(
                    selectedChannelId,
                    `Сводка сервера ${guild.name}`,
                    undefined,
                    guild.id,
                );
            }}
        />
    );

    const group = findGroupChildrenByChildId(["privacy", "notifications", "settings"], children);
    if (group) group.push(item);
    else children.push(<Menu.MenuGroup>{item}</Menu.MenuGroup>);
};

function getCurrentChannelId(): string | null {
    const channelId = SelectedChannelStore.getChannelId();
    return typeof channelId === "string" ? channelId : null;
}

export default definePlugin({
    name: "Summary of new messages",
    description: "Сводка по новым сообщениям с помощью Gemini.",
    authors: [{ name: "Ovolya", id: 139438379170398208n }],
    tags: ["Chat", "Utility"],
    settings,

    commands: [
        {
            name: COMMAND_NAME,
            description: "Сделать сводку новых сообщений",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: async (_args, ctx) => {
                await summarizeUnread(ctx.channel.id);
            },
        },
    ],

    contextMenus: {
        "channel-context": channelContextMenu,
        "guild-context": guildContextMenu,
        "guild-header-popout": guildContextMenu,
    },

    start() { },

    stop() {
        unregisterCommand(COMMAND_NAME);
    },
});
