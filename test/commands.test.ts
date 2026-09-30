import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { subcommand } from '../api/slack/commands.js';

describe('slash commands', () => {
  it('reads the option from the command name or the text', () => {
    expect(subcommand('/hpp-start', '')).toBe('start');
    expect(subcommand('/hpp-update', 'ignored')).toBe('update');
    expect(subcommand('/hpp', ' Score ')).toBe('score');
    expect(subcommand('/hpp', '')).toBe('');
  });

  it('every command in the Slack manifest is one the bot handles', () => {
    const manifest = JSON.parse(readFileSync(new URL('../slack-manifest.json', import.meta.url), 'utf8'));
    const known = ['', 'start', 'update', 'score', 'pause', 'resume', 'settings'];
    for (const c of manifest.features.slash_commands) {
      expect(known).toContain(subcommand(c.command, ''));
      expect(c.url).toBe('https://hpp-message-bot.vercel.app/api/slack/commands');
    }
  });
});
