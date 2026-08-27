import { config } from '../config.js';

const apiUrl = method => `https://api.telegram.org/bot${config.telegram.botToken}/${method}`;

export async function telegramRequest(method, body, options = {}) {
  if (!config.telegram.enabled) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(apiUrl(method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.signal
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.description ?? `Telegram ${method} failed (${response.status})`);
  return data.result;
}

export async function sendTelegramMessage(text, options = {}) {
  if (!config.telegram.enabled) return false;
  const results = await Promise.allSettled(config.telegram.allowedChatIds.map(chatId =>
    telegramRequest('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4096), ...options })
  ));
  if (results.every(result => result.status === 'rejected')) throw results[0].reason;
  return true;
}
