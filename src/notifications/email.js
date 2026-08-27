import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { sendTelegramMessage } from './telegram-client.js';

let transport;
export async function notify(subject, text) {
  const deliveries = [sendTelegramMessage(`${subject}\n\n${text}`)];
  if (config.email.enabled && config.email.user && config.email.password && config.email.to) {
    transport ??= nodemailer.createTransport({ service: 'gmail', auth: { user: config.email.user, pass: config.email.password } });
    deliveries.push(transport.sendMail({ from: config.email.user, to: config.email.to, subject, text }));
  }
  const results = await Promise.allSettled(deliveries);
  return results.some(result => result.status === 'fulfilled' && result.value !== false);
}
