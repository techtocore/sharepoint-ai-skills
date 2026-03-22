/**
 * player.js
 *
 * Controls a Playwriter session to drive SharePoint AI demos.
 *
 * Playwriter wraps the user's real Chrome browser, so no login is needed —
 * the user stays authenticated. Communication is via the Playwriter CLI:
 *   playwriter session new            → creates a session, returns ID
 *   playwriter -s <id> -e '<code>'   → runs Playwright code in that session
 *
 * Code is passed via spawn (array args) to avoid any shell-escaping issues.
 */

import { spawn } from 'child_process';

// ── Typing speed presets (ms delay between keystrokes) ──────────────────────
const SPEEDS = {
  slow: 80,
  normal: 35,
  fast: 8,
};

// ── SharePoint AI input selector candidates (tried in order) ────────────────
// Configurable via player options; these cover the most common Copilot layouts.
const DEFAULT_SELECTORS = [
  '[data-testid="chat-input"]',
  '[data-automationid="chat-input"]',
  'textarea[placeholder*="Ask"]',
  'textarea[placeholder*="Message"]',
  'div[contenteditable="true"][aria-label*="Ask"]',
  'div[contenteditable="true"][aria-label*="Message"]',
  'div[contenteditable="true"]',
];

// ── Pause button injected into the live Chrome tab ───────────────────────────
const PAUSE_BUTTON_INJECT = `
  (() => {
    if (document.getElementById('__demo_next__')) return;
    const btn = document.createElement('button');
    btn.id = '__demo_next__';
    btn.textContent = '▶  Next';
    btn.style.cssText = [
      'position: fixed',
      'bottom: 28px',
      'right: 28px',
      'z-index: 2147483647',
      'padding: 12px 24px',
      'font-size: 15px',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      'font-weight: 600',
      'color: #fff',
      'background: #0f7b0f',
      'border: none',
      'border-radius: 8px',
      'box-shadow: 0 4px 16px rgba(0,0,0,0.3)',
      'cursor: pointer',
      'transition: background 0.15s',
    ].join(';');
    btn.onmouseenter = () => btn.style.background = '#0a5c0a';
    btn.onmouseleave = () => btn.style.background = '#0f7b0f';
    document.body.appendChild(btn);
  })();
`;

const PAUSE_BUTTON_REMOVE = `
  (() => {
    const el = document.getElementById('__demo_next__');
    if (el) el.remove();
  })();
`;

/**
 * Run a Playwriter CLI command and return { stdout, stderr }.
 * Uses spawn with an args array — no shell, no escaping issues.
 */
function runPlaywriter(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('playwriter', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`playwriter exited ${code}\n${stderr}`));
      } else {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error('playwriter not found — install it: npm install -g playwriter'));
      } else {
        reject(err);
      }
    });
  });
}

export class Player {
  /**
   * @param {object} options
   * @param {string}   options.sessionId  - existing Playwriter session ID
   * @param {string}   [options.speed]    - 'slow' | 'normal' | 'fast'
   * @param {string}   [options.selector] - custom SharePoint AI input selector
   * @param {string}   [options.screenshots] - directory path for screenshots
   */
  constructor(options = {}) {
    this.sessionId = options.sessionId;
    this.speed = options.speed || 'normal';
    this.customSelector = options.selector || '';
    this.screenshotsDir = options.screenshots || '';
    this._screenshotCount = 0;
  }

  /** Create a new Playwriter session and return a configured Player. */
  static async create(options = {}) {
    console.log('[player] Starting Playwriter session…');
    const { stdout } = await runPlaywriter(['session', 'new']);
    // The CLI prints something like "Session ID: 1" or just "1"
    const idMatch = stdout.match(/\d+/);
    if (!idMatch) throw new Error(`Unexpected session output: ${stdout}`);
    const sessionId = idMatch[0];
    console.log(`[player] Session ${sessionId} ready`);
    return new Player({ ...options, sessionId });
  }

  /** Execute arbitrary Playwright code in this session. */
  async execute(code) {
    const { stdout } = await runPlaywriter(['-s', this.sessionId, '-e', code]);
    return stdout;
  }

  // ── Step handlers ──────────────────────────────────────────────────────────

  async navigate(url) {
    console.log(`[player] → ${url}`);
    await this.execute(`await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded' })`);
  }

  /**
   * Type text into the SharePoint AI input and submit it.
   * Tries each candidate selector until one is found.
   */
  async typeInAI(text) {
    const delay = SPEEDS[this.speed] ?? SPEEDS.normal;
    const selectors = this.customSelector
      ? [this.customSelector]
      : DEFAULT_SELECTORS;

    // Build the code to find the input, focus it, type, and submit
    const code = `
      const selectors = ${JSON.stringify(selectors)};
      let input = null;
      for (const sel of selectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1500 })) {
            input = el;
            break;
          }
        } catch (_) {}
      }
      if (!input) throw new Error('Could not find SharePoint AI input box. Set selector: in your script frontmatter.');
      await input.click();
      await page.keyboard.type(${JSON.stringify(text)}, { delay: ${delay} });
      await page.keyboard.press('Enter');
    `;
    await this.execute(code);
  }

  /**
   * Pause: inject a ▶ Next button into the live Chrome tab.
   * Returns only after the presenter clicks it.
   */
  async pause() {
    process.stdout.write('[player] Paused — click ▶ Next in the browser to continue…');

    // Inject the button
    await this.execute(`await page.evaluate(\`${PAUSE_BUTTON_INJECT}\`)`);

    // Wait for click — poll every 300ms
    await this.execute(`
      await page.waitForSelector('#__demo_next__', { state: 'attached', timeout: 0 });
      await page.locator('#__demo_next__').click({ timeout: 0 });
    `);

    // Remove the button
    await this.execute(`await page.evaluate(\`${PAUSE_BUTTON_REMOVE}\`)`);

    process.stdout.write(' ✓\n');
  }

  async wait(ms) {
    console.log(`[player] Waiting ${ms}ms…`);
    await this.execute(`await page.waitForTimeout(${ms})`);
  }

  async screenshot(caption) {
    this._screenshotCount += 1;
    const slug = caption
      ? caption.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      : `step-${this._screenshotCount}`;
    const filename = `${String(this._screenshotCount).padStart(2, '0')}-${slug}.png`;

    const dir = this.screenshotsDir || './screenshots';

    const code = `
      const fs = require('fs');
      fs.mkdirSync(${JSON.stringify(dir)}, { recursive: true });
      await page.screenshot({ path: ${JSON.stringify(dir + '/' + filename)}, fullPage: false });
    `;
    await this.execute(code);
    console.log(`[player] Screenshot saved: ${dir}/${filename}`);
  }

  setSpeed(value) {
    if (!SPEEDS[value]) {
      console.warn(`[player] Unknown speed "${value}", ignoring`);
      return;
    }
    this.speed = value;
    console.log(`[player] Typing speed set to "${value}"`);
  }
}
