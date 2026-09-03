/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { shell } from "electron";

const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com";
const MAX_INPUT_CHARS = 2_000_000;
const MAX_RESPONSE_CHARS = 1_000_000;
const REQUEST_TIMEOUT_MS = 60_000;

interface GeminiResult {
    success: boolean;
    text: string;
    error?: string;
}

export async function generateContent(
    _: IpcMainInvokeEvent,
    model: string,
    apiKey: string,
    input: string,
): Promise<GeminiResult> {
    if (typeof model !== "string" || !/^[a-zA-Z0-9._-]+$/.test(model) || model.length > 100) {
        return { success: false, text: "", error: "Некорректная модель Gemini." };
    }

    if (typeof apiKey !== "string" || apiKey.length < 10 || apiKey.length > 500) {
        return { success: false, text: "", error: "Некорректный Gemini API key." };
    }

    if (typeof input !== "string" || !input.trim()) {
        return { success: false, text: "", error: "Пустой запрос к Gemini." };
    }

    if (input.length > MAX_INPUT_CHARS) {
        return { success: false, text: "", error: `Запрос слишком большой (${input.length.toLocaleString()} символов).` };
    }

    const url = new URL(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, GEMINI_ORIGIN);
    url.searchParams.set("key", apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: input }] }],
                generationConfig: { temperature: 0.2 },
            }),
            signal: controller.signal,
        });

        const raw = await response.text();
        const body = raw.slice(0, MAX_RESPONSE_CHARS);

        let data: any;
        try {
            data = JSON.parse(body);
        } catch {
            return {
                success: false,
                text: "",
                error: `Gemini вернул HTTP ${response.status}, но ответ не является JSON.`,
            };
        }

        if (!response.ok) {
            const message = data?.error?.message || `HTTP ${response.status}`;
            return { success: false, text: "", error: `Gemini: ${message}` };
        }

        const text = data?.candidates?.[0]?.content?.parts
            ?.map((part: any) => typeof part?.text === "string" ? part.text : "")
            .join("")
            .trim();

        if (!text) {
            const finishReason = data?.candidates?.[0]?.finishReason;
            return {
                success: false,
                text: "",
                error: finishReason ? `Gemini не вернул текст (finishReason: ${finishReason}).` : "Gemini не вернул текстовый ответ.",
            };
        }

        return { success: true, text };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            text: "",
            error: message === "The operation was aborted."
                ? "Превышено время ожидания ответа Gemini (60 секунд)."
                : `Ошибка соединения с Gemini: ${message}`,
        };
    } finally {
        clearTimeout(timer);
    }
}


let summaryWindow: BrowserWindow | null = null;

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function discordDeepLink(url: string): string | null {
    const match = url.match(/^https:\/\/discord\.com\/channels\/([^\/\s)]+)\/([^\/\s)]+)\/([^\/\s)]+)$/);
    if (!match) return null;

    const [, guildId, channelId, messageId] = match;
    return `discord://-/channels/${encodeURIComponent(guildId)}/${encodeURIComponent(channelId)}/${encodeURIComponent(messageId)}`;
}

function summaryToHtml(text: string): string {
    // Gemini is instructed to return Markdown only. Strip accidental HTML
    // so it cannot leak into our HTML document or distort the layout.
    let source = text
        .replace(/<[^>]*>/g, "")
        .replace(/\r\n?/g, "\n");

    const links: string[] = [];

    // Proper Markdown links.
    source = source.replace(
        /\[([^\]\n]+)\]\((https:\/\/discord\.com\/channels\/[^\s)]+)\)/g,
        (full, label: string, url: string) => {
            const deepLink = discordDeepLink(url);
            if (!deepLink) return full;

            const index = links.length;
            links.push(
                `<a class="discord-link" href="${escapeHtml(deepLink)}" target="_blank" rel="noreferrer">${escapeHtml(label.trim())}</a>`
            );
            return `\\u0000LINK${index}\\u0000`;
        }
    );

    // Bare Discord message URLs: compact clickable link.
    source = source.replace(
        /https:\/\/discord\.com\/channels\/[^\s<>)\]"']+/g,
        url => {
            const cleanUrl = url.replace(/[.,;:!?]+$/g, "");
            const deepLink = discordDeepLink(cleanUrl);
            if (!deepLink) return cleanUrl;

            const index = links.length;
            links.push(
                `<a class="discord-link" href="${escapeHtml(deepLink)}" target="_blank" rel="noreferrer">открыть сообщение</a>`
            );
            return `\\u0000LINK${index}\\u0000`;
        }
    );

    let html = escapeHtml(source);
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

    html = html.replace(/\\u0000LINK(\d+)\\u0000/g, (_, index) => links[Number(index)]);
    html = html.replace(/^(?:[ \t]*)[-*] (.+)$/gm, "<div class=\"summary-list-item\">• $1</div>");
    html = html.replace(/\n/g, "<br>");

    return html;
}


export async function openSummaryWindow(
    _: IpcMainInvokeEvent,
    title: string,
    text: string,
    width = 980,
    height = 760,
): Promise<void> {
    if (summaryWindow && !summaryWindow.isDestroyed()) {
        summaryWindow.focus();
    } else {
        summaryWindow = new BrowserWindow({
            width: Math.max(600, Math.min(2400, Math.floor(width))),
            height: Math.max(450, Math.min(1600, Math.floor(height))),
            minWidth: 600,
            minHeight: 450,
            title: "Сводка Discord",
            autoHideMenuBar: true,
            backgroundColor: "#1e1f22",
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });

        summaryWindow.on("closed", () => {
            summaryWindow = null;
        });

        summaryWindow.webContents.setWindowOpenHandler(({ url }) => {
            if (url.startsWith("discord://-/channels/")) {
                void shell.openExternal(url);
            } else if (url.startsWith("https://discord.com/channels/")) {
                const deepLink = discordDeepLink(url);
                if (deepLink) void shell.openExternal(deepLink);
            }
            return { action: "deny" };
        });

        summaryWindow.webContents.on("will-navigate", (event, url) => {
            if (url.startsWith("discord://-/channels/")) {
                event.preventDefault();
                void shell.openExternal(url);
                return;
            }

            if (url.startsWith("https://discord.com/channels/")) {
                event.preventDefault();
                const deepLink = discordDeepLink(url);
                if (deepLink) void shell.openExternal(deepLink);
                return;
            }

            event.preventDefault();
        });
    }

    const safeTitle = escapeHtml(title);
    const body = summaryToHtml(text);
    const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
:root { color-scheme: dark; }
html, body { margin: 0; min-height: 100%; background: #1e1f22; color: #dbdee1; font-family: Arial, sans-serif; }
body { box-sizing: border-box; padding: 28px 34px 40px; }
header { position: sticky; top: 0; background: #1e1f22ee; backdrop-filter: blur(8px); padding-bottom: 18px; margin-bottom: 20px; border-bottom: 1px solid #3f4147; }
h1 { font-size: 22px; margin: 0; color: #f2f3f5; }
main { font-size: 15px; line-height: 1.6; max-width: 900px; white-space: normal; overflow-wrap: anywhere; }
h2 { margin-top: 26px; color: #f2f3f5; }
h3 { margin-top: 20px; color: #f2f3f5; }
strong { color: #fff; }
code { background: #2b2d31; padding: 2px 5px; border-radius: 4px; }
a { color: #00a8fc; text-decoration: none; }
a:hover { text-decoration: underline; }
</style>
</head>
<body>
<header><h1>${safeTitle}</h1></header>
<main>${body}</main>
</body>
</html>`;

    await summaryWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    summaryWindow.focus();
}
