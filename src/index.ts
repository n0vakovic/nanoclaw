import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
  STORE_DIR,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupSessionsIndex,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { PROXY_BIND_HOST } from './container-runtime.js';
import { checkDocker, reconcileContainers } from './runtime-health.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import {
  handleGoogleApprovalCommand,
  recoverGoogleApprovalWork,
  waitForGoogleExecutions,
} from './google-workspace.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { JobManager } from './job-manager.js';
import { configureBackgroundJobs } from './host-actions.js';
import { CONTROL_COMMANDS, handleControlCommand } from './control.js';
import {
  captureIncident,
  readBuildIdentity,
  writeHeartbeat,
  RecoverySnapshot,
} from './recovery.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
// Watermark of what the agent has actually FINISHED processing (a container
// query completed), as opposed to lastAgentTimestamp which advances the moment
// a message is handed off / piped. Crash recovery keys off this so a message
// piped into a container that then died is re-delivered instead of lost.
let lastConfirmedTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();
let jobs: JobManager;
let runtimeReady = false;
let runtimeFailure: string | undefined;
const recoveryEpoch = new Map<string, number>();
const activity = new Map<string, { phase: string; at: string }>();

function recoverySnapshot(jid?: string): RecoverySnapshot {
  return {
    groupJid: jid,
    sessionId: jid ? sessions[registeredGroups[jid]?.folder] : undefined,
    messageCursor: jid ? lastAgentTimestamp[jid] : undefined,
    phase: jid
      ? activity.get(jid)?.phase
      : runtimeReady
        ? 'ready'
        : 'runtime_unavailable',
    uptimeSeconds: process.uptime(),
    activeContainers: queue.snapshot().filter((s) => s.active).length,
    queue: queue.snapshot().map((s) => ({
      groupJid: s.groupJid,
      active: s.active,
      pendingMessages: s.pendingMessages,
      pendingTasks: s.pendingTasks.length,
      containerName: s.containerName || undefined,
      runningTaskId: s.runningTaskId || undefined,
      cancelling: s.cancelling,
      startedAt: s.startedAt || undefined,
      lastProgressAt:
        activity.get(s.groupJid)?.at || s.lastProgressAt || undefined,
    })),
  };
}

async function sendStrict(jid: string, text: string): Promise<void> {
  const channel = findChannel(channels, jid);
  if (!channel) throw new Error('Channel unavailable');
  await (channel.sendMessageStrict?.(jid, text) ??
    channel.sendMessage(jid, text));
}

function setupBackgroundJobs(): void {
  jobs = new JobManager(path.join(STORE_DIR, 'agent-jobs.db'), {
    groups: () => registeredGroups,
    enqueue: (key, id, fn) => queue.enqueueTask(key, id, fn),
    cancel: (key) => queue.cancel(key),
    steer: (key, text) => queue.steerTask(key, text),
    send: sendStrict,
    incident: (reason, job) =>
      captureIncident(reason, {
        ...recoverySnapshot(job.chat_jid),
        phase: job.phase,
        messageId: job.id,
        sessionId: undefined,
      }),
    run: async (job, group, progress) => {
      if (!runtimeReady) throw new Error('Container runtime unavailable');
      let result = '';
      let failure = false;
      const key = `job:${job.id}`;
      const output = await runContainerAgent(
        group,
        {
          prompt: `You are executing detached job ${job.id}. Complete the task and return the final result. Do not start another background job or wait for the foreground agent.\n\n${job.task}`,
          groupFolder: group.folder,
          chatJid: job.chat_jid,
          isMain: group.isMain === true,
          executionId: job.id,
          isScheduledTask: true,
          assistantName: ASSISTANT_NAME,
        },
        (proc, name) =>
          queue.registerProcess(
            key,
            proc,
            name,
            group.folder,
            `${group.folder}/executions/${job.id}`,
          ),
        async (event) => {
          if (event.result)
            result = (result + '\n' + event.result).trim().slice(0, 64000);
          if (event.status === 'error') failure = true;
          if (event.completed || event.result || event.status === 'error')
            queue.closeStdin(key);
        },
        progress,
      );
      if (output.status === 'error' || failure)
        throw new Error('Detached execution failed');
      return result || output.result || 'Job completed without a text result.';
    },
  });
  configureBackgroundJobs(async (params, ctx) => {
    if (!ctx?.sourceGroup || !params) throw new Error('Missing job context');
    const op = params.op;
    if (op === 'start') {
      if (!runtimeReady)
        throw new Error(
          'Docker unavailable; use /status. Your request has not been started.',
        );
      const task = typeof params.task === 'string' ? params.task : '';
      const job = jobs.start(ctx.sourceGroup, ctx.requestId!, task);
      return JSON.stringify({
        id: job.id,
        state: job.state,
        instruction:
          'Acknowledge this ID and end the foreground turn. The result will be delivered separately.',
      });
    }
    if (op === 'list') return JSON.stringify(jobs.list(ctx.sourceGroup));
    if (typeof params.id !== 'string') throw new Error('Missing job ID');
    if (op === 'get')
      return JSON.stringify(jobs.get(ctx.sourceGroup, params.id));
    if (op === 'cancel') return jobs.cancel(ctx.sourceGroup, params.id);
    if (op === 'steer' && typeof params.instruction === 'string')
      return jobs.steer(ctx.sourceGroup, params.id, params.instruction);
    throw new Error('Unknown job operation');
  });
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  const confirmedTs = getRouterState('last_confirmed_timestamp');
  try {
    // Migration default: absent → trust the existing handoff cursor, so an
    // upgrade doesn't reprocess the whole backlog. It then lags only for
    // genuinely in-flight messages going forward.
    lastConfirmedTimestamp = confirmedTs
      ? JSON.parse(confirmedTs)
      : { ...lastAgentTimestamp };
  } catch {
    logger.warn('Corrupted last_confirmed_timestamp in DB, resetting');
    lastConfirmedTimestamp = { ...lastAgentTimestamp };
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
  setRouterState(
    'last_confirmed_timestamp',
    JSON.stringify(lastConfirmedTimestamp),
  );
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  if (!runtimeReady) return true; // Durable inbound history is retried when runtime recovers.
  const epoch = recoveryEpoch.get(chatJid) || 0;
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    if ((recoveryEpoch.get(chatJid) || 0) !== epoch) return;
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success' && (result.completed || result.result)) {
      // A container query fully completed, so everything piped up to now has
      // been processed — safe to confirm. Crash recovery keys off this.
      lastConfirmedTimestamp[chatJid] = lastAgentTimestamp[chatJid] || '';
      saveState();
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if ((recoveryEpoch.get(chatJid) || 0) !== epoch) return true;

  if (output === 'error' || hadError) {
    const incident = captureIncident('foreground_failed', {
      ...recoverySnapshot(chatJid),
      messageId: missedMessages[missedMessages.length - 1].id,
    });
    await sendStrict(
      chatJid,
      `I couldn't complete that turn. Incident ${incident}. Use /status to inspect, /cancel to stop retries, or /clear for a fresh session.`,
    ).catch((err) =>
      logger.warn({ err, incident }, 'Failure notice delivery failed'),
    );
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];
  const epoch = recoveryEpoch.get(chatJid) || 0;

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );
  if (isMain) {
    writeGroupSessionsIndex(registeredGroups);
  }

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if ((recoveryEpoch.get(chatJid) || 0) !== epoch) return;
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
      (phase) => activity.set(chatJid, { phase, at: new Date().toISOString() }),
    );

    if (output.newSessionId && (recoveryEpoch.get(chatJid) || 0) === epoch) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

function findRegisteredGroupByFolder(
  groupFolder: string,
): { jid: string; group: RegisteredGroup } | null {
  const entry = Object.entries(registeredGroups).find(
    ([, group]) => group.folder === groupFolder,
  );
  if (!entry) return null;
  return { jid: entry[0], group: entry[1] };
}

async function messageGroupAgent(opts: {
  requestId: string;
  sourceGroup: string;
  targetGroupFolder: string;
  prompt: string;
  replyTo: 'main' | 'target_group' | 'both';
  contextMode: 'group' | 'isolated';
  allowSelfEdit: boolean;
  deliverToTargetChat: boolean;
  deliverToMainChat: boolean;
}): Promise<void> {
  const target = findRegisteredGroupByFolder(opts.targetGroupFolder);
  if (!target) {
    throw new Error(`Target group not registered: ${opts.targetGroupFolder}`);
  }

  const source =
    findRegisteredGroupByFolder(opts.sourceGroup) ||
    Object.entries(registeredGroups)
      .map(([jid, group]) => ({ jid, group }))
      .find(({ group }) => group.isMain === true);
  if (!source) throw new Error('Main group registration not found');

  const taskId = opts.requestId;
  const sessionId =
    opts.contextMode === 'group' ? sessions[target.group.folder] : undefined;
  const startedAt = new Date().toISOString();

  const wrappedPrompt = [
    '[MAIN-GROUP MESSAGE]',
    `Origin: ${source.group.name} (${opts.sourceGroup})`,
    `Target group: ${target.group.name} (${target.group.folder})`,
    `Reply mode: ${opts.replyTo}`,
    `Context mode: ${opts.contextMode}`,
    `Self-edit allowed: ${opts.allowSelfEdit ? 'yes' : 'no'}`,
    '',
    'Your result will be returned to the main agent as structured data. Telegram delivery is optional and controlled separately.',
    '',
    opts.allowSelfEdit
      ? 'You may update files in your group folder only if the request explicitly calls for it.'
      : 'Do not modify files in your group folder. If changes would help, draft the proposed change in your reply.',
    '',
    opts.prompt,
  ].join('\n');

  const writeResult = (result: {
    status: 'queued' | 'success' | 'error';
    result?: string | null;
    error?: string | null;
    newSessionId?: string;
  }) => {
    const sourceIpcDir = path.join(DATA_DIR, 'ipc', opts.sourceGroup);
    const resultsDir = path.join(sourceIpcDir, 'intergroup-results');
    fs.mkdirSync(resultsDir, { recursive: true });
    const payload = {
      requestId: opts.requestId,
      status: result.status,
      sourceGroup: opts.sourceGroup,
      sourceJid: source.jid,
      sourceName: source.group.name,
      targetGroup: target.group.folder,
      targetJid: target.jid,
      targetName: target.group.name,
      replyTo: opts.replyTo,
      contextMode: opts.contextMode,
      allowSelfEdit: opts.allowSelfEdit,
      deliverToTargetChat: opts.deliverToTargetChat,
      deliverToMainChat: opts.deliverToMainChat,
      prompt: opts.prompt,
      result: result.result ?? null,
      error: result.error ?? null,
      newSessionId: result.newSessionId,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    const resultPath = path.join(resultsDir, `${opts.requestId}.json`);
    const tmpPath = `${resultPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n');
    fs.renameSync(tmpPath, resultPath);

    const auditPath = path.join(DATA_DIR, 'intergroup-messages.jsonl');
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, JSON.stringify(payload) + '\n');
  };

  writeResult({ status: 'queued' });

  queue.enqueueTask(target.jid, taskId, async () => {
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    const streamedResults: string[] = [];
    const scheduleClose = () => {
      if (closeTimer) return;
      closeTimer = setTimeout(() => queue.closeStdin(target.jid), 2_000);
    };
    const sendTo = async (jid: string, rawText: string) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn(
          { jid },
          'No channel owns JID, cannot send intergroup reply',
        );
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    };

    try {
      const isTargetMain = target.group.isMain === true;
      const tasks = getAllTasks();
      writeTasksSnapshot(
        target.group.folder,
        isTargetMain,
        tasks.map((t) => ({
          id: t.id,
          groupFolder: t.group_folder,
          prompt: t.prompt,
          schedule_type: t.schedule_type,
          schedule_value: t.schedule_value,
          status: t.status,
          next_run: t.next_run,
        })),
      );
      writeGroupsSnapshot(
        target.group.folder,
        isTargetMain,
        getAvailableGroups(),
        new Set(Object.keys(registeredGroups)),
      );
      if (isTargetMain) {
        writeGroupSessionsIndex(registeredGroups);
      }

      const output = await runContainerAgent(
        target.group,
        {
          prompt: wrappedPrompt,
          sessionId,
          groupFolder: target.group.folder,
          chatJid: target.jid,
          isMain: isTargetMain,
          isScheduledTask: true,
          assistantName: ASSISTANT_NAME,
        },
        (proc, containerName) =>
          queue.registerProcess(
            target.jid,
            proc,
            containerName,
            target.group.folder,
          ),
        async (streamedOutput: ContainerOutput) => {
          if (streamedOutput.newSessionId) {
            sessions[target.group.folder] = streamedOutput.newSessionId;
            setSession(target.group.folder, streamedOutput.newSessionId);
          }
          if (streamedOutput.result) {
            streamedResults.push(streamedOutput.result);
            if (opts.deliverToMainChat) {
              const text = `[${target.group.name}]\n${streamedOutput.result}`;
              await sendTo(source.jid, text);
            }
            if (opts.deliverToTargetChat) {
              await sendTo(target.jid, streamedOutput.result);
            }
            scheduleClose();
          }
          if (streamedOutput.status === 'success') {
            queue.notifyIdle(target.jid);
            scheduleClose();
          }
        },
      );

      if (output.newSessionId) {
        sessions[target.group.folder] = output.newSessionId;
        setSession(target.group.folder, output.newSessionId);
      }
      if (output.status === 'error') {
        const errorText = output.error || 'unknown error';
        if (opts.deliverToMainChat) {
          await sendTo(
            source.jid,
            `Inter-group message to ${target.group.name} failed: ${errorText}`,
          );
        }
        writeResult({
          status: 'error',
          error: errorText,
          newSessionId: output.newSessionId,
        });
      } else {
        writeResult({
          status: 'success',
          result:
            streamedResults.length > 0
              ? streamedResults.join('\n\n')
              : output.result,
          newSessionId: output.newSessionId,
        });
      }
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      writeResult({ status: 'error', error: errorText });
      throw err;
    } finally {
      if (closeTimer) clearTimeout(closeTimer);
    }
  });
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    // Key off the CONFIRMED cursor, not the handoff cursor: a message piped
    // into a container that then crashed advanced lastAgentTimestamp but was
    // never processed, so only lastConfirmedTimestamp reflects real completion.
    const sinceTimestamp =
      lastConfirmedTimestamp[chatJid] || lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      // Re-processing re-reads from the confirmed cursor, so reset the handoff
      // cursor too — otherwise the loop's getMessagesSince would skip them.
      lastAgentTimestamp[chatJid] = sinceTimestamp;
      saveState();
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

async function main(): Promise<void> {
  try {
    await checkDocker();
    await reconcileContainers();
    runtimeReady = true;
  } catch {
    runtimeFailure = captureIncident('runtime_unavailable', {
      phase: 'startup',
      errorCode: 'DOCKER_UNAVAILABLE',
    });
    logger.error(
      { incident: runtimeFailure },
      'Docker unavailable; starting Telegram recovery controls in degraded mode',
    );
  }
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();
  setupBackgroundJobs();
  let jobsRecovered = false;

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    logger.info({ signal }, 'Shutdown signal received');
    captureIncident('service_shutdown', recoverySnapshot());
    shuttingDown = true;
    runtimeReady = false;
    // A broken provider/channel must not defeat the owner's recovery command.
    // Running jobs remain persisted and are reconciled as interrupted next boot.
    setTimeout(() => process.exit(0), 15000).unref();
    proxyServer.close();
    await queue.shutdown(10000);
    await waitForGoogleExecutions(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const controlDeps = {
    groups: () => registeredGroups,
    status: (jid: string, id?: string) => {
      const group = registeredGroups[jid];
      if (id) {
        const job = jobs.get(group.folder, id);
        return `${job.id} · ${job.state} · ${job.phase}\nLast activity: ${job.updated_at}\nDelivery: ${job.delivery}${job.incident_id ? '\nIncident: ' + job.incident_id : ''}${job.result ? '\n' + job.result.slice(0, 3000) : ''}`;
      }
      const build = readBuildIdentity();
      const lanes = queue
        .snapshot()
        .filter((s) => group.isMain || s.groupJid === jid);
      return (
        `NanoClaw ${build.sha.slice(0, 12)} · ${build.branch}${build.dirty ? ' (uncommitted build)' : ''}\nDocker: ${runtimeReady ? 'ready' : 'unavailable'}${runtimeFailure ? '\nRuntime incident: ' + runtimeFailure : ''}\n` +
        (lanes.length
          ? lanes
              .slice(0, 15)
              .map(
                (s) =>
                  `${s.groupJid}: ${s.cancelling ? 'cancelling' : s.active ? 'running' : 'idle'}; ${s.pendingTasks.length} queued tasks; messages ${s.pendingMessages ? 'waiting' : 'clear'}${activity.get(s.groupJid) ? '; ' + activity.get(s.groupJid)!.phase + ' at ' + activity.get(s.groupJid)!.at : ''}`,
              )
              .join('\n')
          : 'No active work.')
      );
    },
    jobs: (source: string) =>
      jobs
        .list(source)
        .map((j) => `${j.id} · ${j.state} · ${j.phase} · ${j.updated_at}`)
        .join('\n') || 'No background jobs.',
    cancelJob: (source: string, id: string) => jobs.cancel(source, id),
    steerJob: (source: string, id: string, text: string) =>
      jobs.steer(source, id, text),
    capture: (reason: string, jid: string, msg: NewMessage) =>
      captureIncident(reason, { ...recoverySnapshot(jid), messageId: msg.id }),
    reset: async (jid: string, clear: boolean, msg: NewMessage) => {
      recoveryEpoch.set(jid, (recoveryEpoch.get(jid) || 0) + 1);
      // Explicit cancellation acknowledges the interrupted batch without deleting its history.
      // Advance before stop so completion callbacks/retry timers cannot resurrect it.
      lastAgentTimestamp[jid] = msg.timestamp;
      lastConfirmedTimestamp[jid] = msg.timestamp;
      saveState();
      await queue.cancel(jid);
      const inputDir = path.join(
        resolveGroupIpcPath(registeredGroups[jid].folder),
        'input',
      );
      if (fs.existsSync(inputDir)) {
        const archived = `${inputDir}-cancelled-${Date.now()}`;
        fs.renameSync(inputDir, archived);
        fs.mkdirSync(inputDir, { recursive: true });
      }
      if (clear) {
        delete sessions[registeredGroups[jid].folder];
        setSession(registeredGroups[jid].folder, '');
      }
      activity.set(jid, {
        phase: clear ? 'cleared' : 'cancelled',
        at: new Date().toISOString(),
      });
    },
    restart: () => {
      void (async () => {
        // Explicit restart must not replay foreground side effects on startup.
        for (const jid of Object.keys(registeredGroups)) {
          recoveryEpoch.set(jid, (recoveryEpoch.get(jid) || 0) + 1);
          lastConfirmedTimestamp[jid] = lastAgentTimestamp[jid] || '';
        }
        saveState();
        await shutdown('owner_restart');
      })().catch((err) => logger.error({ err }, 'Owner restart failed'));
    },
  };

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onFatal: (error: unknown) => {
      logger.fatal(
        { error },
        'Channel polling stopped; restarting to preserve incoming delivery',
      );
      try {
        captureIncident('channel_polling_failed', {
          phase: 'telegram_ingress',
          errorCode: 'POLLING_STOPPED',
        });
      } catch {
        /* Disk failure is precisely why polling must stop without acknowledgment. */
      }
      process.exit(1);
    },
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
      if (!runtimeReady && registeredGroups[chatJid]) {
        void sendStrict(
          chatJid,
          `Your message is saved. Docker is unavailable, so I cannot run the agent yet. /status and recovery commands still work.${runtimeFailure ? ' Incident ' + runtimeFailure : ''}`,
        ).catch((err) => logger.warn({ err }, 'Degraded notice failed'));
      }
    },
    onHostCommand: async (
      command: string,
      args: string,
      chatJid: string,
      msg: NewMessage,
    ) => {
      if (CONTROL_COMMANDS.includes(command))
        return handleControlCommand(controlDeps, command, args, chatJid, msg);
      if (command !== 'approve' && command !== 'reject') {
        throw new Error(`Unsupported host command /${command}`);
      }
      const outcome = await handleGoogleApprovalCommand(
        command,
        args,
        chatJid,
        msg.sender,
        resolveGroupIpcPath,
        async (targetJid, text) => {
          const targetChannel = findChannel(channels, targetJid);
          if (!targetChannel) {
            throw new Error(`No channel owns approval target ${targetJid}`);
          }
          if (targetChannel.sendMessageStrict) {
            await targetChannel.sendMessageStrict(targetJid, text);
          } else {
            await targetChannel.sendMessage(targetJid, text);
          }
        },
      );
      return { reply: outcome.reply };
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }
  const beat = () => {
    try {
      writeHeartbeat(recoverySnapshot());
    } catch (err) {
      logger.error({ err }, 'Heartbeat write failed');
    }
  };
  beat();
  setInterval(beat, 10000);
  let checkingRuntime = false;
  const checkRuntime = async () => {
    if (checkingRuntime || shuttingDown) return;
    checkingRuntime = true;
    const wasReady = runtimeReady;
    try {
      await checkDocker();
      if (shuttingDown) return;
      if (!wasReady) await reconcileContainers();
      runtimeReady = true;
      if (!wasReady) {
        runtimeFailure = undefined;
        recoverPendingMessages();
      }
      if (!jobsRecovered) {
        jobsRecovered = true;
        await jobs.recover();
      }
    } catch {
      runtimeReady = false;
      if (wasReady)
        runtimeFailure = captureIncident('runtime_unavailable', {
          phase: 'runtime_check',
          errorCode: 'DOCKER_UNAVAILABLE',
        });
    } finally {
      checkingRuntime = false;
    }
  };
  void checkRuntime();
  setInterval(checkRuntime, 30000);
  recoverGoogleApprovalWork(resolveGroupIpcPath, async (targetJid, text) => {
    const targetChannel = findChannel(channels, targetJid);
    if (!targetChannel) {
      throw new Error(`No channel owns approval target ${targetJid}`);
    }
    if (targetChannel.sendMessageStrict) {
      await targetChannel.sendMessageStrict(targetJid, text);
    } else {
      await targetChannel.sendMessage(targetJid, text);
    }
  });

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    runtimeReady: () => runtimeReady,
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendApprovalMessage: (jid, text, approvalId) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (approvalId && channel.sendApprovalMessageStrict) {
        return channel.sendApprovalMessageStrict(jid, text, approvalId);
      }
      if (channel.sendMessageStrict) {
        return channel.sendMessageStrict(jid, text);
      }
      return channel.sendMessage(jid, text);
    },
    sendVoice: (jid, audioPath) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendVoice)
        throw new Error(`Channel ${channel.name} does not support voice`);
      return channel.sendVoice(jid, audioPath);
    },
    sendAudio: (jid, audioPath, meta) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendAudio)
        throw new Error(`Channel ${channel.name} does not support audio`);
      return channel.sendAudio(jid, audioPath, meta);
    },
    sendDocument: (jid, filePath, meta) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendDocument)
        throw new Error(`Channel ${channel.name} does not support document`);
      return channel.sendDocument(jid, filePath, meta);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    messageGroupAgent,
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
