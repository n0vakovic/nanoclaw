/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'send_voice_note',
  'Convert text to speech and send as a voice note to the chat. Use when the user requests voice output or when /voice mode is active. Write naturally for speech — no markdown, no bullet lists, short sentences. Optional `voice` param picks a non-default voice (see param description).',
  {
    text: z.string().describe('The text to speak. Write for natural speech — no markdown, no bullets, no headers.'),
    voice: z
      .enum(['lucy', 'funny-nigerian', 'indian', 'vlad'])
      .optional()
      .describe(
        'Optional named voice. Omit for default. Options: ' +
          '"lucy" (British, energetic — good for upbeat or playful lines); ' +
          '"funny-nigerian" (Nigerian accent, slow and comedic — good for jokes or character bits); ' +
          '"indian" (Indian accent, energetic — good for animated delivery); ' +
          '"vlad" (Russian accent — good for deadpan or dramatic lines). ' +
          'Pick to match tone; default voice is fine for normal replies.',
      ),
  },
  async (args) => {
    const ACTIONS_DIR = path.join(IPC_DIR, 'actions');
    const RESULTS_DIR = path.join(IPC_DIR, 'action-results');
    const requestId = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Step 1: Request TTS via host action
    writeIpcFile(ACTIONS_DIR, {
      action: 'ttsSpeak',
      requestId,
      params: { text: args.text, ...(args.voice ? { voice: args.voice } : {}) },
    });

    // Step 2: Poll for result (host processes actions asynchronously)
    const resultPath = path.join(RESULTS_DIR, `${requestId}.json`);
    const maxWait = 30_000;
    const pollInterval = 500;
    let elapsed = 0;

    while (elapsed < maxWait) {
      if (fs.existsSync(resultPath)) {
        const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
        fs.unlinkSync(resultPath);

        if (!result.ok) {
          return {
            content: [{ type: 'text' as const, text: `TTS failed: ${result.output}` }],
            isError: true,
          };
        }

        const { audioPath } = JSON.parse(result.output);

        // Step 3: Send voice note via IPC message
        writeIpcFile(MESSAGES_DIR, {
          type: 'voice_note',
          chatJid,
          audioPath,
          groupFolder,
          timestamp: new Date().toISOString(),
        });

        return { content: [{ type: 'text' as const, text: 'Voice note sent.' }] };
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      elapsed += pollInterval;
    }

    return {
      content: [{ type: 'text' as const, text: 'TTS timed out after 30 seconds.' }],
      isError: true,
    };
  },
);

/**
 * Send a pre-existing audio file as a Telegram audio (music-track UX with
 * optional title/performer metadata). For longer audio like podcasts or
 * stitched multi-voice output. For a single TTS line, use send_voice_note.
 *
 * The file must be at a /workspace/ipc/media/ path — copy or move your
 * output there before calling. After sending, the host deletes the file.
 */
server.tool(
  'send_audio_file',
  'Send a pre-existing audio file as a Telegram audio track. Use for longer audio (podcasts, stitched output, music) — gets the music-player UX with optional title/performer. For a single TTS line, use send_voice_note instead. The file must live at /workspace/ipc/media/<name>.mp3; copy or move your output there first. After sending, the host deletes the file.',
  {
    audioPath: z
      .string()
      .describe('Container path under /workspace/ipc/media/ (e.g. "/workspace/ipc/media/podcast.mp3")'),
    title: z.string().optional().describe('Track title shown in Telegram audio player'),
    performer: z.string().optional().describe('Performer/artist shown in audio player'),
    caption: z.string().optional().describe('Optional caption text shown below the audio'),
  },
  async (args) => {
    writeIpcFile(MESSAGES_DIR, {
      type: 'audio_file',
      chatJid,
      audioPath: args.audioPath,
      title: args.title,
      performer: args.performer,
      caption: args.caption,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Audio file queued for send.' }] };
  },
);

/**
 * Send a pre-existing file as a Telegram document (generic file attachment).
 * Same /workspace/ipc/media/ staging rule as send_audio_file.
 */
server.tool(
  'send_document',
  'Send a pre-existing file as a Telegram document (generic file attachment — .md, .pdf, .txt, .json, etc.). The file must live at /workspace/ipc/media/<name>.<ext>; copy or move it there first. After sending, the host deletes the file. Telegram does not render markdown inline — the recipient opens the file in their OS app.',
  {
    filePath: z
      .string()
      .describe('Container path under /workspace/ipc/media/ (e.g. "/workspace/ipc/media/report.md")'),
    caption: z.string().optional().describe('Optional caption text shown below the document'),
  },
  async (args) => {
    writeIpcFile(MESSAGES_DIR, {
      type: 'document',
      chatJid,
      filePath: args.filePath,
      caption: args.caption,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Document queued for send.' }] };
  },
);

/**
 * Create a GitHub gist from a staged file. Returns the gist URL. By default
 * the gist is "secret" (unlisted but accessible to anyone with the URL).
 * Set public: true for a listed/searchable public gist. Promote secret→public
 * later via `gh gist edit <id> --public` or the GitHub web UI.
 */
server.tool(
  'create_gist',
  'Create a GitHub gist from a staged file and return its URL. Use for sharing long-form text/markdown that would be cumbersome inline. Default is "secret" gist (unlisted; anyone with the URL can read, does not show in your gist list). Set public:true for a fully public gist. File must be at /workspace/ipc/media/<name>. After creation, the staged file is removed. Returns JSON: {"url": "https://gist.github.com/..."}. Send the URL to the user via send_message.',
  {
    filePath: z
      .string()
      .describe('Container path under /workspace/ipc/media/ (e.g. "/workspace/ipc/media/notes.md")'),
    public: z.boolean().optional().describe('false (default) = secret/unlisted; true = public/listed'),
    description: z.string().optional().describe('Gist description (shown on the gist page)'),
    filename: z.string().optional().describe('Override filename inside the gist (otherwise basename of filePath)'),
  },
  async (args) => {
    const ACTIONS_DIR = path.join(IPC_DIR, 'actions');
    const RESULTS_DIR = path.join(IPC_DIR, 'action-results');
    const requestId = `gist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(ACTIONS_DIR, {
      action: 'gistCreate',
      requestId,
      params: {
        filePath: args.filePath,
        public: args.public,
        description: args.description,
        filename: args.filename,
      },
    });

    const resultPath = path.join(RESULTS_DIR, `${requestId}.json`);
    const maxWait = 30_000;
    const pollInterval = 500;
    let elapsed = 0;

    while (elapsed < maxWait) {
      if (fs.existsSync(resultPath)) {
        const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
        fs.unlinkSync(resultPath);

        if (!result.ok) {
          return {
            content: [{ type: 'text' as const, text: `Gist create failed: ${result.output}` }],
            isError: true,
          };
        }

        const { url } = JSON.parse(result.output);
        // Remove the staged file so it doesn't accumulate in /workspace/ipc/media/
        try {
          fs.unlinkSync(args.filePath);
        } catch {
          // ignore
        }
        return { content: [{ type: 'text' as const, text: url }] };
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      elapsed += pollInterval;
    }

    return {
      content: [{ type: 'text' as const, text: 'Gist creation timed out after 30 seconds.' }],
      isError: true,
    };
  },
);

/**
 * Call xAI's Grok with live search over X (Twitter) and/or the web.
 * Returns a synthesis text. Expensive (paid live search) and slow.
 */
server.tool(
  'xai_fetch',
  'Call xAI Grok with live search over X (Twitter) and/or the web. Use for synthesis-style questions over X posts and/or the web — returns a synthesis text. For known tweet IDs use xFetch instead (much cheaper, faster); this tool is for open-ended search/aggregation. EXPENSIVE (paid live search) and SLOW (can take up to 2 minutes). Batch your queries; do not retry blindly on transient errors.',
  {
    prompt: z.string().describe('The user prompt / question to send to Grok. Be specific about what synthesis you want.'),
    source: z
      .enum(['x', 'web', 'x+web'])
      .optional()
      .describe(
        'Where Grok should search. "x" = X (Twitter) posts only — use for social/discourse questions. "web" = web search only — use for articles/news/docs. "x+web" (default) = both — use when unsure or you want broad coverage.',
      ),
    model: z
      .string()
      .optional()
      .describe('xAI model id. Defaults to "grok-4-1-fast". Override only if you know a specific model is needed.'),
    systemPrompt: z
      .string()
      .optional()
      .describe('Optional system-role instruction prepended to the input. Use to shape output format/persona.'),
    fromDate: z
      .string()
      .optional()
      .describe('Start of date range, "YYYY-MM-DD". Prepended to the prompt as plain text (xAI has no native date filter).'),
    toDate: z
      .string()
      .optional()
      .describe('End of date range, "YYYY-MM-DD". Prepended to the prompt as plain text.'),
    maxOutputTokens: z
      .number()
      .optional()
      .describe('Optional cap on response tokens.'),
    timeoutMs: z
      .number()
      .optional()
      .describe('Optional timeout in ms. Default 120000 (live search is slow).'),
  },
  async (args) => {
    const ACTIONS_DIR = path.join(IPC_DIR, 'actions');
    const RESULTS_DIR = path.join(IPC_DIR, 'action-results');
    const requestId = `xai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(ACTIONS_DIR, {
      action: 'xAIFetch',
      requestId,
      params: {
        prompt: args.prompt,
        ...(args.source ? { source: args.source } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
        ...(args.fromDate ? { fromDate: args.fromDate } : {}),
        ...(args.toDate ? { toDate: args.toDate } : {}),
        ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      },
    });

    const resultPath = path.join(RESULTS_DIR, `${requestId}.json`);
    const maxWait = 150_000;
    const pollInterval = 1_000;
    let elapsed = 0;

    while (elapsed < maxWait) {
      if (fs.existsSync(resultPath)) {
        const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
        fs.unlinkSync(resultPath);

        if (!result.ok) {
          return {
            content: [{ type: 'text' as const, text: `xai_fetch failed: ${result.output}` }],
            isError: true,
          };
        }

        let text = '';
        try {
          const parsed = JSON.parse(result.output);
          text = typeof parsed.text === 'string' ? parsed.text : '';
        } catch {
          text = result.output;
        }
        return { content: [{ type: 'text' as const, text }] };
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      elapsed += pollInterval;
    }

    return {
      content: [{ type: 'text' as const, text: `xai_fetch timed out after ${maxWait}ms.` }],
      isError: true,
    };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
