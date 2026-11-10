import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import type {} from '@deepseek-ai/dsh-tools';
import { errorText, type Faults } from '../faults.ts';
import { registerScopedTool } from '../worldScope.ts';
import type { ToolDefinition, ToolGuard } from '@deepseek-ai/dsh-tools';

type Registration = (() => void)[];
const ALARM_TOOLS = ['plan_next', 'check_alarm', 'cancel_alarm'];
const HOME_TOOLS = ['reach_out', 'keep_photo', 'list_photos', 'forget_photo'];
/**
 * 本地定制（fork）：她一轮里用得上的只有文件、搜索、记忆和自己的世界工具，其余都是每轮重发一遍的
 * 编码助手家具和旧 bridge 的 MCP 接口。后者尤其有害——那套 QQ 接口缺会话令牌，她一调就失败，
 * 还会据此以为消息没发出去，把同一句话再说一遍。DSH 的 restrict 只过滤全局工具，她自己那批
 * scoped 登记不受影响，所以这里只列全局名字；宿主没有的名字会被跳过，升级不会变成一次抛错。
 */
const UNUSED_GLOBAL = [
  'ask_user_question', 'create_goal', 'exit_plan_mode', 'get_goal', 'goal_status', 'interrupt_agent',
  'job_kill', 'job_list', 'job_output', 'list_agents', 'list_subagent_models',
  'glob', 'grep', 'ops_result', 'working_directory',
  'list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource',
  'mcp__snowluma-host__snowluma_status',
  'mcp__snowluma__qq_collect_sticker', 'mcp__snowluma__qq_get_active_members',
  'mcp__snowluma__qq_get_forward_msg', 'mcp__snowluma__qq_get_group_members',
  'mcp__snowluma__qq_get_message_detail', 'mcp__snowluma__qq_get_message_images',
  'mcp__snowluma__qq_get_my_recent_messages', 'mcp__snowluma__qq_get_prompt',
  'mcp__snowluma__qq_get_recent_messages', 'mcp__snowluma__qq_get_self_image',
  'mcp__snowluma__qq_get_sticker_image', 'mcp__snowluma__qq_get_unread_messages',
  'mcp__snowluma__qq_list_stickers', 'mcp__snowluma__qq_mark_read',
  'mcp__snowluma__qq_memory_append', 'mcp__snowluma__qq_memory_clear',
  'mcp__snowluma__qq_memory_query', 'mcp__snowluma__qq_memory_remove',
  'mcp__snowluma__qq_reply', 'mcp__snowluma__qq_report_feedback',
  'mcp__snowluma__qq_send_burst', 'mcp__snowluma__qq_send_group_message',
  'mcp__snowluma__qq_send_message', 'mcp__snowluma__qq_send_poke',
  'mcp__snowluma__qq_send_private_message', 'mcp__snowluma__qq_send_sticker',
  'mcp__snowluma__qq_set_wake_config', 'mcp__snowluma__qq_slang_query',
  'mcp__snowluma__qq_slang_submit', 'mcp__snowluma__qq_social_state', 'mcp__snowluma__qq_status',
  'mcp__snowluma__qq_sticker_note', 'mcp__snowluma__qq_wait_for_messages',
  'mcp__web-search-safe__web_fetch', 'mcp__web-search-safe__web_search',
  'present',
  'schedule_create', 'schedule_delete', 'schedule_edit', 'schedule_list', 'schedule_update', 'schedule_view',
  'send_message', 'skill', 'subagent', 'subagent_fork', 'todo_write', 'update_goal', 'video_help',
  'video_storyboard_settings', 'watch_together_settings', 'workflow',
] as const;
export { UNUSED_GLOBAL };

/**
 * Hides the named tools from her requests at the moment they are assembled.
 *
 * `hideGlobalTools` asks the registry what it has at attach time; on a resumed session that runs before the preset's
 * layer is complete, so it finds nothing and quietly does nothing (the fault list stays empty and it looks applied).
 * This one edits the assembled tool list itself: a tool the request never carries is one the model cannot call.
 */
/**
 * Drops the hidden tools from one assembled request. The tool list is not guaranteed to be there — a brand-new
 * session assembles before any tool provider has contributed — so a missing or non-array list is left untouched:
 * a filter must never be the reason her turn dies.
 */
export function dropHiddenTools<T>(assembly: T, deny: ReadonlySet<string>): T {
  const tools = (assembly as { tools?: unknown } | undefined)?.tools;
  if (Array.isArray(tools)) (assembly as { tools: unknown }).tools = tools.filter(tool => !deny.has((tool as { name?: string } | null)?.name ?? ''));
  return assembly;
}

export function hideToolsOnAssemble(ctx: Context, hers: (agent: Agent) => boolean, names: readonly string[], note?: (text: string) => void): () => void {
  const deny = new Set<string>(names);
  return ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    if (!context.agent || !hers(context.agent)) return next();
    const before = (assembly as { tools?: unknown } | undefined)?.tools;
    const count = Array.isArray(before) ? before.length : -1;
    dropHiddenTools(assembly, deny);
    const result = dropHiddenTools(await next(), deny);
    const after = (result as { tools?: unknown } | undefined)?.tools;
    // 让她到底带了多少工具可核实：header 记的是建会话那一刻的快照，不是请求本身（2026-11-10 实测）。
    note?.(`${count} -> ${Array.isArray(after) ? after.length : -1}`);
    return result;
  });
}

/** The Web host's preset registry; a session preset is an isolated realm the host plane cannot see (0.2.1-rc.2 on). */
export interface PresetServices { serviceFor?(agent: Agent, name: string): unknown }

/**
 * The tool service this agent's presets actually use. Her tools are contributed by a preset plugin list, which runs
 * in its own realm: `agent.ctx.tools` there is the host plane and holds none of them, so a restriction registered on
 * it is a silent no-op (2026-11-10 实测：glob 仍在 deny 名单里却被她成功调用). The preset realm is reached the same
 * way compaction is (see console/homeApply.ts).
 */
function toolsServiceOf(agent: Agent, preset?: PresetServices): typeof agent.ctx.tools {
  return (preset?.serviceFor?.(agent, 'tools') as typeof agent.ctx.tools | undefined) ?? agent.ctx.tools;
}

/** Hides `names` from one agent's tools. Names this host no longer has are skipped, and a host without `restrict` keeps everything. */
export function hideGlobalTools(agent: Agent, names: readonly string[], preset?: PresetServices, faults?: Faults): () => void {
  const tools = toolsServiceOf(agent, preset);
  if (typeof tools.restrict !== 'function') return () => {};
  // Without the scope, `get` reads the global layer alone; hers sit in the preset's ancestor layers.
  const scope = scopeOf(agent.ctx);
  const present = names.filter(name => tools.get(name, scope) !== undefined);
  // A wrong service finds nothing and would look applied forever; say so where the console can see it.
  if (!present.length) faults?.set(`restrict:${agent.id}`, `工具瘦身一个名字都没认出（${names.length} 个待删，工具服务可能不在这层）`);
  else faults?.clear(`restrict:${agent.id}`);
  return present.length ? tools.restrict({ deny: present }) : () => {};
}

/** Disposes in reverse; a disposer whose agent scope is already gone may throw and is skipped. */
function undo(list: Registration): void {
  for (const dispose of list.splice(0).reverse()) { try { dispose(); } catch { /* scope already disposed */ } }
}

/**
 * The alarm tools are held by every world session (she can set her alarm anywhere; it rings at home), with `guard`
 * checking each of its tool calls; reach_out only by the current home. A registration that fails (a name clash) is a fault and never breaks
 * agent creation; it registers all of a group or none. Each tool refuses to run once its session leaves her world.
 */
export function createToolRegistry(deps: { faults: Faults; logger: { error(...args: unknown[]): void }; tools: (agent: Agent) => readonly ToolDefinition[]; isHome(agent: Agent): boolean; inWorld(agent: Agent): boolean; guard?: ToolGuard; preset?: PresetServices }) {
  const alarm = new Map<Agent, Registration>();
  const home = new Map<Agent, Registration>();
  function register(agent: Agent, tools: readonly ToolDefinition[], names: string[]): Registration {
    const done: Registration = [];
    try { for (const tool of tools) if (names.includes(tool.name)) done.push(registerScopedTool(agent, tool, () => deps.inWorld(agent))); }
    catch (error) { undo(done); throw error; }
    return done;
  }
  function forget(agent: Agent): void { alarm.delete(agent); home.delete(agent); deps.faults.clear(`attach:${agent.id}`); }
  return {
    /** Registers what the agent is missing; true when its tool list changed. */
    attach(agent: Agent): boolean {
      const needsAlarm = !alarm.get(agent)?.length, needsHome = deps.isHome(agent) && !home.get(agent)?.length;
      if (!needsAlarm && !needsHome) return false;
      let changed = false;
      try {
        const tools = deps.tools(agent);
        if (needsAlarm) {
          const done = register(agent, tools, ALARM_TOOLS);
          // The world sessions' own policy comes and goes with their alarm tools.
          try { if (deps.guard) done.push(agent.ctx.tools.guard(execution => deps.inWorld(agent) ? deps.guard!(execution) : undefined)); }
          catch (error) { undo(done); throw error; }
          // A host that refuses the tool list must not cost her the alarm tools; the fault says what happened.
          try { done.push(hideGlobalTools(agent, UNUSED_GLOBAL, deps.preset, deps.faults)); }
          catch (error) { deps.faults.set(`restrict:${agent.id}`, `工具限制没能挂上：${errorText(error)}`); deps.logger.error(error); }
          alarm.set(agent, done); changed = true;
        }
        if (needsHome) { home.set(agent, register(agent, tools, HOME_TOOLS)); changed = true; }
        deps.faults.clear(`attach:${agent.id}`);
      } catch (error) { deps.faults.set(`attach:${agent.id}`, `工具挂载失败：${errorText(error)}`); deps.logger.error(error); }
      return changed;
    },
    forget,
    /** Takes every tool away from an agent that left her world; true when it had any. */
    detach(agent: Agent): boolean {
      const lists = [alarm.get(agent), home.get(agent)];
      const changed = lists.some(list => list?.length);
      for (const list of lists) if (list) undo(list);
      forget(agent);
      return changed;
    },
    /** A rebuilt home takes reach_out from the old one. */
    releaseOldHomes(): void { for (const [agent, list] of home) if (!deps.isHome(agent)) undo(list); },
    clear(): void {
      for (const list of [...home.values(), ...alarm.values()]) undo(list);
      home.clear(); alarm.clear();
    },
  };
}
