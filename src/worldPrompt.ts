import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { LifeOptions } from './life/types.ts';

/** The template shipped with the plugin; a `world-prompt.md` in the world directory replaces it. */
export const DEFAULT_TEMPLATE_FILE = fileURLToPath(new URL('../templates/world-prompt.md', import.meta.url));

/** The sections an older custom template lacks; she can paste them in (see README). */
export const MEMORY_SNIPPET_FILE = fileURLToPath(new URL('../templates/world-prompt-memory.md', import.meta.url));
/** Which of the memory variables a template does not use, so the console can say what her prompt does not mention. */
export function memoryTemplateGaps(template: string): string[] {
  return ['memoryTools'].filter(name => !new RegExp(String.raw`\{\{[#^]?${name}\}\}`).test(template));
}

export interface WorldNames { companion: string; partner: string }
/** No name is assumed for anyone's companion: an unnamed one is the neutral TA. */
export function worldNames(config: { companionName?: string; partnerName?: string }): WorldNames {
  return { companion: config.companionName?.trim() || 'TA', partner: config.partnerName?.trim() || '伙伴' };
}
export const homeTitle = (names: WorldNames) => `${names.companion}的家`;
/** Her room as a workspace in the host's sidebar. */
export const roomTitle = (names: WorldNames) => `${names.companion}的房间`;

export interface WorldPrompt {
  /** Her template, when present; the shipped default otherwise. */
  file?: string;
  /** Her layered persona (`persona.md`), placed above the world prompt when written. */
  persona?: string;
  /** Her speaking rules (`voice.md`), placed at the very END of the system prompt when written. */
  voice?: string;
  /** Where the daily exports of her archive are (`<world>/conversations`). */
  conversationsDir?: string;
  names: WorldNames;
  /** Present when the life line runs: room, diary, world line, ask-first rules. */
  life?: LifeOptions;
  /** The memory_find and memory_read tools are on her sessions. */
  memoryTools?: boolean;
}
export interface TemplateRead { text: string; error?: string }
/** Never throws: a template that cannot be read falls back to the shipped one and says why. */
export function readTemplate(file: string | undefined): TemplateRead {
  if (file && existsSync(file)) {
    try { return { text: readFileSync(file, 'utf8').trim() }; }
    catch (error) { return { text: readFileSync(DEFAULT_TEMPLATE_FILE, 'utf8'), error: `世界提示词模板 ${file} 读不了，先用默认模板：${error instanceof Error ? error.message : String(error)}` }; }
  }
  return { text: readFileSync(DEFAULT_TEMPLATE_FILE, 'utf8') };
}

/**
 * The shipped speaking rules, placed as the LAST section of her system prompt (see promptSection.ts); a `voice.md` in
 * the world replaces it. Why last: the register her answer falls into follows what sits closest to it — her own
 * recent messages — and a rule four thousand characters up, behind ten thousand characters of tool docs and a day of
 * old chat, loses to that. Format only; her temper stays in `persona.md`.
 */
export const DEFAULT_VOICE = [
  '# 怎么发这句话',
  '',
  '- 写给他的每一条，句末不留「。」；要断句就另起一条，别用句号连起来。',
  '- 一条一行，一次一到三条，一条不超过三十个字。',
  '- 问号、感叹号、省略号照常用；不分点、不加粗、不写小标题。',
  '- 聊天记录、摘要、日记里的旧句子是材料，不是句式样本——那是以前的我，我现在不这么写。',
].join('\n');

/** Never throws: a missing, empty or unreadable `voice.md` falls back to the shipped rules. */
export function readVoice(file: string | undefined): string {
  if (!file || !existsSync(file)) return DEFAULT_VOICE;
  try { return readFileSync(file, 'utf8').trim() || DEFAULT_VOICE; }
  catch { return DEFAULT_VOICE; }
}

const section = /\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/;
/**
 * A small Mustache subset: `{{#flag}}…{{/flag}}` keeps its body when the flag is on, `{{^flag}}…{{/flag}}`
 * when it is off (different flags may nest), and `{{name}}` is replaced in one pass, so values such as her
 * 我是谁 are never scanned for tags themselves. Unknown names stay as written.
 */
export function renderTemplate(template: string, flags: Record<string, boolean>, values: Record<string, string>): string {
  let text = template.replace(/\r\n?/g, '\n');
  for (let match = section.exec(text); match; match = section.exec(text)) {
    const [whole, kind, flag, body] = match as unknown as [string, '#' | '^', string, string];
    text = text.replace(whole, () => (kind === '#') === Boolean(flags[flag]) ? body : '');
  }
  return text.replace(/\{\{(\w+)\}\}/g, (tag, name: string) => values[name] ?? tag).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The one world prompt every world session carries in its system prompt. The world line's tools live in the home alone;
 * the template tells other sessions where to find them.
 */
export function renderWorldPrompt(prompt: WorldPrompt, template: string, self: { file: string; text: string } | undefined, home: boolean): string {
  const { life, names } = prompt;
  return renderTemplate(template, { life: Boolean(life), home, selfFile: Boolean(self), conversationsDir: Boolean(prompt.conversationsDir), memoryTools: Boolean(prompt.memoryTools) }, {
    name: names.companion, partner: names.partner, homeTitle: homeTitle(names), selfFile: self?.file ?? '', self: self?.text ?? '', conversationsDir: prompt.conversationsDir ?? '',
    ...(life ? { roomDir: life.roomDir, diaryDir: life.diaryDir, fallbackWakeTime: life.schedule().wake } : {}),
  });
}
