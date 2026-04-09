/**
 * 飞书 (Feishu/Lark) Adapter for Claude Code Desktop
 *
 * 基于 @larksuiteoapi/node-sdk 的轻量飞书 Bot，直连服务端 /ws/:sessionId。
 * 使用 WebSocket 长连接接收事件，无需公网地址。
 *
 * 启动：FEISHU_APP_ID=xxx FEISHU_APP_SECRET=xxx bun run feishu/index.ts
 */

import * as Lark from '@larksuiteoapi/node-sdk'
import { WsBridge, type ServerMessage } from '../common/ws-bridge.js'
import { MessageBuffer } from '../common/message-buffer.js'
import { MessageDedup } from '../common/message-dedup.js'
import { enqueue } from '../common/chat-queue.js'
import { loadConfig } from '../common/config.js'
import { splitMessage, formatToolUse, formatPermissionRequest, truncateInput } from '../common/format.js'
import { SessionStore } from '../common/session-store.js'
import { AdapterHttpClient } from '../common/http-client.js'
import { isAllowedUser, tryPair } from '../common/pairing.js'

// ---------- init ----------

const config = loadConfig()
if (!config.feishu.appId || !config.feishu.appSecret) {
  console.error('[Feishu] Missing FEISHU_APP_ID / FEISHU_APP_SECRET. Set env or ~/.claude/adapters.json')
  process.exit(1)
}

const larkClient = new Lark.Client({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
  appType: Lark.AppType.SelfBuild,
  domain: Lark.Domain.Feishu,
})

const bridge = new WsBridge(config.serverUrl, 'feishu')
const dedup = new MessageDedup()
const sessionStore = new SessionStore()
const httpClient = new AdapterHttpClient(config.serverUrl)

// Track state per chat
type ChatState = {
  cardId?: string
  sequence: number
  replyMessageId?: string
}
const chatStates = new Map<string, ChatState>()
const buffers = new Map<string, MessageBuffer>()
const accumulatedText = new Map<string, string>()
const pendingProjectSelection = new Map<string, boolean>()

// Bot's own open_id (resolved on first message)
let botOpenId: string | null = null
// WSClient reference for graceful shutdown
let wsClient: InstanceType<typeof Lark.WSClient> | null = null

// ---------- helpers ----------

function getChatState(chatId: string): ChatState {
  let state = chatStates.get(chatId)
  if (!state) {
    state = { sequence: 0 }
    chatStates.set(chatId, state)
  }
  return state
}

function getBuffer(chatId: string): MessageBuffer {
  let buf = buffers.get(chatId)
  if (!buf) {
    buf = new MessageBuffer(async (text, isComplete) => {
      await flushToFeishu(chatId, text, isComplete)
    })
    buffers.set(chatId, buf)
  }
  return buf
}

/** Send a text message (post format). */
async function sendText(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
  const content = JSON.stringify({
    zh_cn: { content: [[{ tag: 'md', text }]] },
  })

  try {
    if (replyToMessageId) {
      const resp = await larkClient.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { content, msg_type: 'post' },
      })
      return resp.data?.message_id
    }
    const resp = await larkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'post' as const,
        content,
      },
    })
    return resp.data?.message_id
  } catch (err) {
    console.error('[Feishu] Send text error:', err)
    return undefined
  }
}

/** Send an interactive card (for permission requests). */
async function sendCard(chatId: string, card: Record<string, unknown>): Promise<string | undefined> {
  try {
    const resp = await larkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    })
    return resp.data?.message_id
  } catch (err) {
    console.error('[Feishu] Send card error:', err)
    return undefined
  }
}

/** Update a message's content (patch). */
async function patchMessage(messageId: string, text: string): Promise<void> {
  try {
    await larkClient.im.message.patch({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({
          zh_cn: { content: [[{ tag: 'md', text }]] },
        }),
      },
    })
  } catch {
    // patch may fail if message format changed — ignore
  }
}

/** Build a permission request card. */
function buildPermissionCard(toolName: string, input: unknown, requestId: string): Record<string, unknown> {
  const truncated = truncateInput(input, 300)

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🔐 需要权限确认' },
      template: 'orange',
    },
    elements: [
      {
        tag: 'markdown',
        content: `**工具**: ${toolName}\n**内容**:\n\`\`\`\n${truncated}\n\`\`\``,
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 允许' },
            type: 'primary',
            value: { action: 'permit', requestId, allowed: true },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 拒绝' },
            type: 'danger',
            value: { action: 'permit', requestId, allowed: false },
          },
        ],
      },
    ],
  }
}

async function flushToFeishu(chatId: string, newText: string, isComplete: boolean): Promise<void> {
  const prev = accumulatedText.get(chatId) ?? ''
  const fullText = prev + newText
  accumulatedText.set(chatId, fullText)

  const state = getChatState(chatId)

  if (state.replyMessageId) {
    const displayText = fullText + (isComplete ? '' : ' ▍')
    await patchMessage(state.replyMessageId, displayText)
  }

  if (isComplete) {
    if (!state.replyMessageId && fullText.trim()) {
      const chunks = splitMessage(fullText, 30000)
      for (const chunk of chunks) {
        await sendText(chatId, chunk)
      }
    }
    accumulatedText.delete(chatId)
    chatStates.delete(chatId)
    buffers.get(chatId)?.reset()
  }
}

// ---------- session management ----------

async function ensureSession(chatId: string): Promise<boolean> {
  if (bridge.hasSession(chatId)) return true

  const stored = sessionStore.get(chatId)
  if (stored) {
    bridge.connectSession(chatId, stored.sessionId)
    bridge.onServerMessage(chatId, (msg) => handleServerMessage(chatId, msg))
    return await bridge.waitForOpen(chatId)
  }

  const workDir = config.defaultProjectDir
  if (workDir) {
    return await createSessionForChat(chatId, workDir)
  }

  await showProjectPicker(chatId)
  return false
}

async function createSessionForChat(chatId: string, workDir: string): Promise<boolean> {
  try {
    const sessionId = await httpClient.createSession(workDir)
    sessionStore.set(chatId, sessionId, workDir)
    bridge.connectSession(chatId, sessionId)
    bridge.onServerMessage(chatId, (msg) => handleServerMessage(chatId, msg))
    const opened = await bridge.waitForOpen(chatId)
    if (!opened) {
      await sendText(chatId, '⚠️ 连接服务器超时，请重试。')
      return false
    }
    return true
  } catch (err) {
    await sendText(chatId, `❌ 无法创建会话: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

async function showProjectPicker(chatId: string): Promise<void> {
  try {
    const projects = await httpClient.listRecentProjects()
    if (projects.length === 0) {
      await sendText(chatId,
        '没有找到最近的项目。请先在 Desktop App 中打开一个项目，或在设置中配置默认项目。')
      return
    }
    const lines = projects.slice(0, 10).map((p, i) =>
      `${i + 1}. **${p.projectName}**${p.branch ? ` (${p.branch})` : ''}\n   ${p.realPath}`
    )
    pendingProjectSelection.set(chatId, true)
    await sendText(chatId, `选择项目（回复编号）：\n\n${lines.join('\n\n')}`)
  } catch (err) {
    await sendText(chatId, `❌ 无法获取项目列表: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---------- server message handler ----------

async function handleServerMessage(chatId: string, msg: ServerMessage): Promise<void> {
  const buf = getBuffer(chatId)
  const state = getChatState(chatId)

  switch (msg.type) {
    case 'connected':
      break

    case 'status':
      if (msg.state === 'thinking' && !state.replyMessageId) {
        const mid = await sendText(chatId, '💭 思考中...')
        if (mid) {
          state.replyMessageId = mid
          accumulatedText.set(chatId, '')
        }
      }
      break

    case 'content_start':
      if (msg.blockType === 'text') {
        if (!state.replyMessageId) {
          const mid = await sendText(chatId, '▍')
          if (mid) {
            state.replyMessageId = mid
            accumulatedText.set(chatId, '')
          }
        }
      } else if (msg.blockType === 'tool_use') {
        // Finalize current text before tool calls,
        // so text after tools gets a fresh message
        await buf.complete()
        // If reply still exists (buffer was already empty), clean up directly
        if (state.replyMessageId) {
          const text = accumulatedText.get(chatId)
          if (text?.trim()) {
            await patchMessage(state.replyMessageId, text)
          }
          accumulatedText.delete(chatId)
          chatStates.delete(chatId)
          buffers.get(chatId)?.reset()
        }
      }
      break

    case 'content_delta':
      if (msg.text) {
        buf.append(msg.text)
      }
      break

    case 'thinking':
      if (state.replyMessageId) {
        await patchMessage(state.replyMessageId, `💭 ${msg.text.slice(0, 500)}...`)
      }
      break

    case 'tool_use_complete':
      // Tool details are noise for IM users; visible in Desktop if needed.
      break

    case 'tool_result':
      // Tool errors are handled internally by the AI (retries etc.)
      // No need to notify the user for every failed attempt.
      break

    case 'permission_request': {
      const card = buildPermissionCard(msg.toolName, msg.input, msg.requestId)
      await sendCard(chatId, card)
      break
    }

    case 'message_complete':
      await buf.complete()
      // Ensure state is always cleaned up even if buffer was already empty
      if (state.replyMessageId) {
        const text = accumulatedText.get(chatId)
        if (text?.trim()) {
          await patchMessage(state.replyMessageId, text)
        }
        accumulatedText.delete(chatId)
        chatStates.delete(chatId)
        buffers.get(chatId)?.reset()
      }
      break

    case 'error':
      await sendText(chatId, `❌ ${msg.message}`)
      break
  }
}

// ---------- extract message text ----------

function extractText(content: string, msgType: string): string | null {
  try {
    const parsed = JSON.parse(content)
    if (msgType === 'text') {
      return parsed.text ?? null
    }
    if (msgType === 'post') {
      const zhContent = parsed.zh_cn?.content ?? parsed.en_us?.content ?? []
      return zhContent
        .flat()
        .filter((n: any) => n.tag === 'text' || n.tag === 'md')
        .map((n: any) => n.text ?? n.content ?? '')
        .join('')
        .trim() || null
    }
    return null
  } catch {
    return null
  }
}

function isBotMentioned(mentions?: Array<{ id?: { open_id?: string } }>): boolean {
  if (!mentions || !botOpenId) return false
  return mentions.some((m) => m.id?.open_id === botOpenId)
}

function stripMentions(text: string): string {
  return text.replace(/@_user_\d+/g, '').trim()
}

// ---------- event handlers ----------

async function handleMessage(data: any): Promise<void> {
  const event = data as {
    sender?: { sender_id?: { open_id?: string } }
    message?: {
      message_id?: string
      chat_id?: string
      chat_type?: string
      content?: string
      message_type?: string
      mentions?: Array<{ id?: { open_id?: string }; name?: string }>
    }
  }

  const messageId = event.message?.message_id
  const chatId = event.message?.chat_id
  const senderOpenId = event.sender?.sender_id?.open_id
  const chatType = event.message?.chat_type
  const content = event.message?.content
  const msgType = event.message?.message_type

  if (!messageId || !chatId || !senderOpenId || !content || !msgType) return

  if (!dedup.tryRecord(messageId)) return

  // 只处理私聊
  if (chatType === 'p2p') {
    if (!isAllowedUser('feishu', senderOpenId)) {
      // 尝试配对
      const pairText = extractText(content, msgType)
      if (pairText) {
        const success = tryPair(pairText.trim(), { userId: senderOpenId, displayName: 'Feishu User' }, 'feishu')
        if (success) {
          await sendText(chatId, '✅ 配对成功！现在可以开始聊天了。\n\n发送消息即可与 Claude 对话。')
        } else {
          await sendText(chatId, '🔒 未授权。请在 Claude Code 桌面端生成配对码后发送给我。')
        }
      }
      return
    }
  } else {
    // 群聊不处理
    return
  }

  let text = extractText(content, msgType)
  if (!text) return

  text = stripMentions(text)
  if (!text) return

  // Handle commands
  if (text === '/new' || text === '新会话') {
    bridge.resetSession(chatId)
    sessionStore.delete(chatId)
    chatStates.delete(chatId)
    accumulatedText.delete(chatId)
    buffers.get(chatId)?.reset()
    buffers.delete(chatId)
    pendingProjectSelection.delete(chatId)

    const workDir = config.defaultProjectDir
    if (workDir) {
      const ok = await createSessionForChat(chatId, workDir)
      if (ok) {
        await sendText(chatId, '✅ 已新建会话，可以开始对话了。')
      }
    } else {
      await showProjectPicker(chatId)
    }
    return
  }
  if (text === '/stop' || text === '停止') {
    bridge.sendStopGeneration(chatId)
    await sendText(chatId, '⏹ 已发送停止信号。')
    return
  }
  if (text === '/projects' || text === '项目列表') {
    await showProjectPicker(chatId)
    return
  }

  // Check if user is responding to project selection
  if (pendingProjectSelection.has(chatId)) {
    const num = parseInt(text, 10)
    if (num >= 1) {
      try {
        const projects = await httpClient.listRecentProjects()
        const selected = projects[num - 1]
        if (selected) {
          pendingProjectSelection.delete(chatId)
          await createSessionForChat(chatId, selected.realPath)
          await sendText(chatId, `✅ 已选择 **${selected.projectName}**。现在可以开始对话了。`)
          return
        }
      } catch { /* fall through */ }
    }
    await sendText(chatId, '请输入有效的编号。')
    return
  }

  // Normal message flow
  enqueue(chatId, async () => {
    const ready = await ensureSession(chatId)
    if (ready) {
      const sent = bridge.sendUserMessage(chatId, text!)
      if (!sent) {
        await sendText(chatId, '⚠️ 消息发送失败，连接可能已断开。请发送 /new 重新开始。')
      }
    }
  })
}

async function handleCardAction(data: any): Promise<any> {
  const event = data as {
    operator?: { open_id?: string }
    action?: { value?: { action?: string; requestId?: string; allowed?: boolean } }
    context?: { open_chat_id?: string }
  }

  const action = event.action?.value?.action
  if (action !== 'permit') return

  const requestId = event.action?.value?.requestId
  const allowed = event.action?.value?.allowed ?? false
  const chatId = event.context?.open_chat_id

  if (!requestId || !chatId) return

  bridge.sendPermissionResponse(chatId, requestId, allowed)

  const statusText = allowed ? '✅ 已允许' : '❌ 已拒绝'
  await sendText(chatId, statusText)

  return {
    toast: { type: 'info', content: statusText },
  }
}

// ---------- resolve bot identity ----------

async function resolveBotOpenId(retries = 3): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await larkClient.contact.user.get({
        path: { user_id: 'me' },
        params: { user_id_type: 'open_id' },
      })
      botOpenId = (resp.data?.user as any)?.open_id ?? null
      if (botOpenId) {
        console.log(`[Feishu] Bot open_id: ${botOpenId}`)
        return
      }
    } catch {
      if (i < retries - 1) {
        console.warn(`[Feishu] Could not resolve bot open_id, retrying (${i + 1}/${retries})...`)
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)))
      }
    }
  }
  console.warn('[Feishu] Could not resolve bot open_id (group @mention check may not work)')
}

// ---------- start ----------

async function start(): Promise<void> {
  console.log('[Feishu] Starting bot...')
  console.log(`[Feishu] Server: ${config.serverUrl}`)
  console.log(`[Feishu] App ID: ${config.feishu.appId}`)

  await resolveBotOpenId()

  const dispatcher = new Lark.EventDispatcher({
    encryptKey: config.feishu.encryptKey,
    verificationToken: config.feishu.verificationToken,
  })

  dispatcher.register({
    'im.message.receive_v1': async (data: any) => {
      try {
        await handleMessage(data)
      } catch (err) {
        console.error('[Feishu] Message handler error:', err)
      }
    },
    'card.action.trigger': async (data: any) => {
      try {
        return await handleCardAction(data)
      } catch (err) {
        console.error('[Feishu] Card action error:', err)
      }
    },
  } as any)

  wsClient = new Lark.WSClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.info,
  })

  await wsClient.start({ eventDispatcher: dispatcher })
  console.log('[Feishu] Bot is running! (WebSocket connected)')
}

start().catch((err) => {
  console.error('[Feishu] Failed to start:', err)
  process.exit(1)
})

process.on('SIGINT', () => {
  console.log('[Feishu] Shutting down...')
  bridge.destroy()
  dedup.destroy()
  process.exit(0)
})
