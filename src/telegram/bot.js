import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN } from '../config.js';

const polling = process.env.CHARON_CLI !== '1';
export const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling });
