import { statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { readPersona, renderPersona } from './persona.ts';
import { renderSelf } from './self.ts';
import { belongsToWorld, inWorld } from './sourceArchive.ts';
import type { WorldConfig } from './types.ts';
import { DEFAULT_TEMPLATE_FILE, readTemplate, readVoice, renderWorldPrompt, type WorldNames, type WorldPrompt } from './worldPrompt.ts';
import { reassembleOnChange } from './worldScope.ts';

export const WORLD_PROMPT_PREFIX = 'dsh-world:';

export interface WorldPromptSource {
  prompt: WorldPrompt; isHome(sessionId: string): boolean; archiveSession?(sessionId: string): boolean;
  /** Resolved with the persona, so a rename appears in both parts of the prompt together. */
  names?(): WorldNames;
  /** Her room's workspace; her world and persona reach only its sessions. Absent, every session of hers. */
  inWorkspace?(sessionId: string): boolean;
  /** Long-term memory; its two tools are registered on world sessions. */
  memory?: import('./memory.ts').MemoryService;
}
interface PromptText { template: string; self?: { file: string; text: string }; persona: string; voice: string; names: WorldNames }
/** `active`: the world prompt and any written persona are placed. */
interface Entry { text: PromptText; active: boolean; restart: boolean; dispose: () => void; persona?: () => void }
/** DSH 的 stock identity section 名（见 dsh-system-prompt 的 section 表）；同名才能 shadow。 */
const HARNESS_IDENTITY = 'harness:identity';
/** preset 的 persona 前缀槽（`You are a coding agent…` 就在这一槽）；她的世界不该带着这句。 */
const DEPLOYMENT_PERSONA = 'deployment:persona-prefix';
/**
 * 系统提示词最后一个槽位的编号（`DEPLOYMENT_PERSONA_SUFFIX` 是 10200，排在所有工具说明之后）。
 * 说话规则放这儿：压不过最近处那批旧话，规则写多远都是白写。
 */
const VOICE_ORDER = 10250;

function cachePromptFile<T>(file: string | undefined, read: () => T): (force?: boolean) => T {
  let cached: { version: string; value: T } | undefined;
  return force => {
    let version = '';
    try {
      const stat = file ? statSync(file, { throwIfNoEntry: false }) : undefined;
      if (stat) version = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch { cached = undefined; return read(); }
    if (!force && cached?.version === version) return cached.value;
    const value = read();
    cached = { version, value };
    return value;
  };
}

/**
 * Her persona and the world prompt both reach only sessions of her preset inside the world's workspace, and come and
 * go together as a session enters or leaves it: the preset alone is DSH's default `standard` for most setups, so it
 * would turn every unrelated session into her (#37). Both are sections of the session's system prompt so she sees them on every
 * request. Checking the files during assembly also covers compression outside DSH (#42). The prompt stays in the
 * provider-cached prefix while its content is the same. Whether the session is her home is asked per request.
 *
 * Her persona takes the place of DeepSeek Harness's stock identity line, but never of a persona someone has set: it is its own
 * section placed right after the host's persona slot, so a system persona the deployment or her preset already has stays
 * where it is and hers follows it.
 */
export function createPromptSections(config: WorldConfig, world: WorldPromptSource, deps: { logger: { warn(...args: unknown[]): void } }) {
  const sectionName = WORLD_PROMPT_PREFIX + config.worldId;
  const entries = new Map<Agent, Entry>();
  const agents = new WeakMap<Session, Agent>();
  const persona = cachePromptFile(world.prompt.persona, () => ({
    persona: world.prompt.persona ? renderPersona(readPersona(world.prompt.persona)) : '',
    names: world.names?.() ?? world.prompt.names,
  }));
  const template = cachePromptFile(world.prompt.file ?? DEFAULT_TEMPLATE_FILE, () => {
    const template = readTemplate(world.prompt.file);
    if (template.error) deps.logger.warn(`dsh-world: ${template.error}`);
    return template.text;
  });
  const self = cachePromptFile(config.selfFile, () => config.selfFile ? { file: config.selfFile, text: renderSelf(config.selfFile) } : undefined);
  // 说话规则也吃文件缓存：改 voice.md 下一轮就生效，和改人设一样，不用重启。
  const voice = cachePromptFile(world.prompt.voice, () => readVoice(world.prompt.voice));
  let forceRead = false;
  function read(): PromptText {
    const force = forceRead;
    forceRead = false;
    return { template: template(force), self: self(force), voice: voice(force), ...persona(force) };
  }
  /** Registers her persona while the session is in her workspace and she has one; drops it otherwise. */
  function placePersona(agent: Agent, entry: Entry): void {
    if (!entry.active || !entry.text.persona) { entry.persona?.(); delete entry.persona; return; }
    if (entry.persona) return;
    const prompt = agent.ctx.systemPrompt;
    const order = prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') ?? 0;
    const text = () => entry.text.persona;
    const persona = prompt.section({ name: sectionName + ':persona', order: order + 1, interpolate: false, text });
    // DeepSeek Harness's own identity line gives way to hers; a persona someone set in DSH sits in its own slot and is left alone.
    // If a preset already put its own words on that identity slot for this agent, they stay exactly as written.
    let identity: (() => void) | undefined;
    let deployment: (() => void) | undefined;
    try { identity = prompt.section({ name: HARNESS_IDENTITY, order: prompt.getSectionOrder('HARNESS_IDENTITY'), interpolate: false, text: () => '' }); }
    catch { /* the slot is already taken for this agent */ }
    // preset 往 `DEPLOYMENT_PERSONA_PREFIX` 槽里塞的那句（`You are a coding agent…`）也一并盖掉：
    // 她的 system prompt 开头不该先声明自己是编码助手，再自称女朋友。
    try { deployment = prompt.section({ name: DEPLOYMENT_PERSONA, order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), interpolate: false, text: () => '' }); }
    catch { /* the slot is already taken for this agent */ }
    entry.persona = () => { persona(); identity?.(); deployment?.(); };
  }
  function refresh(agent: Agent, entry: Entry): boolean {
    const text = read();
    if (isDeepStrictEqual(text, entry.text)) return false;
    entry.text = text;
    entry.restart = true;
    placePersona(agent, entry);
    return true;
  }
  return {
    add(agent: Agent): void {
      if (entries.has(agent) || !belongsToWorld(agent.session, config)) return;
      let disposeWorld: (() => void) | undefined;
      let disposeVoice: (() => void) | undefined;
      /** Reassemble if the placement or the content changed since the host collected the sections. */
      const sync = (current: Agent): boolean => {
        if (current !== agent) return false;
        const active = inWorld(agent.session, config, world.inWorkspace);
        if (active === entry.active) return active && refresh(agent, entry);
        entry.active = active;
        entry.restart = true;
        if (!entry.active) { disposeWorld?.(); disposeWorld = undefined; disposeVoice?.(); disposeVoice = undefined; placePersona(agent, entry); return true; }
        entry.text = read();
        disposeWorld = agent.ctx.systemPrompt.section({ name: sectionName, order: 50, interpolate: false, text: () => renderWorldPrompt({ ...world.prompt, names: entry.text.names }, entry.text.template, entry.text.self, world.isHome(agent.id)) });
        // 单独一段，落在最后一个槽位，紧跟在她自己的聊天记录前面。
        disposeVoice = agent.ctx.systemPrompt.section({ name: sectionName + ':voice', order: VOICE_ORDER, interpolate: false, text: () => entry.text.voice });
        placePersona(agent, entry);
        return true;
      };
      const disposeSync = reassembleOnChange(agent.ctx, sync);
      const entry: Entry = { text: { template: '', persona: '', voice: '', names: world.prompt.names }, active: false, restart: false, dispose: () => { disposeSync(); disposeWorld?.(); disposeVoice?.(); } };
      entries.set(agent, entry); agents.set(agent.session, agent);
      sync(agent);
    },
    active(session: Session): boolean {
      const agent = agents.get(session);
      return !!(agent && entries.get(agent)?.active);
    },
    /** On in-history routes, start a new series to replace the old prompt instead of appending to it. */
    takeRestart(session: Session): boolean {
      const agent = agents.get(session); const entry = agent && entries.get(agent);
      if (!entry?.restart) return false;
      entry.restart = false;
      return true;
    },
    refresh(session: Session): void {
      const agent = agents.get(session);
      // A compaction can finish after the current step assembled its prompt.
      if (agent && entries.get(agent)?.active) forceRead = true;
    },
    clear(): void {
      for (const entry of entries.values()) for (const dispose of [entry.dispose, entry.persona]) { try { dispose?.(); } catch { /* agent scope already gone */ } }
      entries.clear();
    },
  };
}
