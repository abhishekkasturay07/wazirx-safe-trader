import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transport;
export async function notify(subject, text) {
  if (!config.email.user || !config.email.password || !config.email.to) return false;
  transport ??= nodemailer.createTransport({ service: 'gmail', auth: { user: config.email.user, pass: config.email.password } });
  await transport.sendMail({ from: config.email.user, to: config.email.to, subject, text });
  return true;
}
