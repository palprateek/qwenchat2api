/**
 * Playwright Login Flow
 *
 * Automates browser login to chat.qwen.ai and
 * extracts authentication tokens and cookies.
 *
 * Usage: npm run login
 */

import { chromium, Browser, Page, BrowserContext } from 'playwright';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('playwright-login');

const QWEN_URL = 'https://chat.qwen.ai';

async function main() {
  logger.info('Starting Playwright login flow for chat.qwen.ai...');
  logger.info('A browser window will open. Please log in manually.');

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0',
      viewport: { width: 1280, height: 720 },
    });

    // Remove webdriver detection (runs in browser context)
    await context.addInitScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    `);

    const page = await context.newPage();

    logger.info('Navigating to chat.qwen.ai...');
    await page.goto(QWEN_URL, { waitUntil: 'networkidle' });

    // Wait for user to log in
    logger.info('');
    logger.info('========================================');
    logger.info('  Please log in to chat.qwen.ai');
    logger.info('  in the browser window that opened.');
    logger.info('');
    logger.info('  Once you see the chat interface,');
    logger.info('  press Enter here to extract tokens.');
    logger.info('========================================');
    logger.info('');

    // Wait for Enter key press
    await new Promise<void>((resolve) => {
      process.stdin.once('data', () => {
        resolve();
      });
    });

    // Extract token from localStorage
    const token = await page.evaluate(() => {
      // @ts-ignore - runs in browser context
      return localStorage.getItem('token');
    });

    if (!token) {
      logger.error('No token found in localStorage. Make sure you are logged in.');
      await browser.close();
      process.exit(1);
    }

    logger.info('Token extracted successfully!');

    // Extract cookies
    const cookies = await context.cookies();
    const cookieString = cookies
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');

    // Extract user info
    let userId: string | undefined;
    try {
      // @ts-ignore - runs in browser context
      const authResponse: any = await page.evaluate(async (tokenValue: string) => {
        const resp = await fetch('https://chat.qwen.ai/api/v1/auths/', {
          headers: {
            Authorization: `Bearer ${tokenValue}`,
          },
        });
        return resp.json();
      }, token);

      userId = (authResponse as any)?.id;
      logger.info(`User ID: ${userId}`);
    } catch (err) {
      logger.warn('Failed to fetch user info', { error: (err as Error).message });
    }

    // Save to auth state file
    const dataDir = process.env.DATA_DIR || './data';
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const authState = {
      token: token.replace(/^["']|["']$/g, ''), // Remove surrounding quotes
      cookie: cookieString,
      userId,
      obtainedAt: Date.now(),
    };

    const stateFile = path.join(dataDir, 'auth_state.json');
    fs.writeFileSync(stateFile, JSON.stringify(authState, null, 2), { mode: 0o600 });

    logger.info(`Auth state saved to ${stateFile}`);

    // Also update .env file if it exists
    const envFile = path.resolve(process.cwd(), '.env');
    const envContent = [
      `QWEN_AUTH_TOKEN=${authState.token}`,
      `QWEN_COOKIE="${cookieString}"`,
    ].join('\n');

    if (fs.existsSync(envFile)) {
      // Update existing .env
      let existing = fs.readFileSync(envFile, 'utf-8');

      // Update or add QWEN_AUTH_TOKEN
      if (existing.includes('QWEN_AUTH_TOKEN=')) {
        existing = existing.replace(
          /QWEN_AUTH_TOKEN=.*/,
          `QWEN_AUTH_TOKEN=${authState.token}`
        );
      } else {
        existing += `\nQWEN_AUTH_TOKEN=${authState.token}`;
      }

      // Update or add QWEN_COOKIE
      if (existing.includes('QWEN_COOKIE=')) {
        existing = existing.replace(
          /QWEN_COOKIE=.*/,
          `QWEN_COOKIE="${cookieString}"`
        );
      } else {
        existing += `\nQWEN_COOKIE="${cookieString}"`;
      }

      fs.writeFileSync(envFile, existing);
      logger.info(`Updated .env file at ${envFile}`);
    } else {
      fs.writeFileSync(envFile, envContent);
      logger.info(`Created .env file at ${envFile}`);
    }

    logger.info('');
    logger.info('✓ Login successful!');
    logger.info('  You can now start the proxy server with: npm start');

    await browser.close();
  } catch (err) {
    logger.error('Login flow failed', { error: (err as Error).message });
    if (browser) {
      await browser.close();
    }
    process.exit(1);
  }
}

main();
