import type { Agent } from '@deepseek-ai/dsh-agent';
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
  'ask_user_question', 'create_goal', 'exit_plan_mode', 'get_goal', 'interrupt_agent',
  'job_kill', 'job_list', 'job_output', 'list_agents',
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
  'schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update',
  'send_message', 'skill', 'subagent', 'subagent_fork', 'todo_write', 'update_goal', 'workflow',
] as const;

/** Hides `names` from one agent's global tools. Names this host no longer has are skipped, and a host without `restrict` keeps everything. */
export function hideGlobalTools(agent: Agent, names: readonly string[]): () => void {
  const tools = agent.ctx.tools;
  if (typeof tools.restrict !== 'function') return () => {};
  const present = names.filter(name => tools.get(name) !== undefined);
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
export function createToolRegistry(deps: { faults: Faults; logger: { error(...args: unknown[]): void }; tools: (agent: Agent) => readonly ToolDefinition[]; isHome(agent: Agent): boolean; inWorld(agent: Agent): boolean; guard?: ToolGuard }) {
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
          try {
            if (deps.guard) done.push(agent.ctx.tools.guard(execution => deps.inWorld(agent) ? deps.guard!(execution) : undefined));
            done.push(hideGlobalTools(agent, UNUSED_GLOBAL));
          }
          catch (error) { undo(done); throw error; }
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
