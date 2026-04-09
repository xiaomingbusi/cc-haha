/**
 * Telegram Adapter for Claude Code Desktop
 *
 * 基于 grammY 的轻量 Telegram Bot，直连服务端 /ws/:sessionId。
 * 启动：TELEGRAM_BOT_TOKEN=xxx bun run telegram/index.ts
 */

import { Bot, InlineKeyboard, type Context } from 'grammy'
import { WsBridge, type ServerMessage } from '../common/ws-bridge.js'
import { MessageBuffer } from '../common/message-buffer.js'
import { MessageDedup } from '../common/message-dedup.js'
import { enqueue } from '../common/chat-queue.js'
import { loadConfig } from '../common/config.js'
import { splitMessage, formatToolUse, formatPermissionRequest } from '../common/format.js'
import { SessionStore } from '../common/session-store.js'
import { AdapterHttpClient } from '../common/http-client.js'
import { isAllowedUser, tryPair } from '../common/pairing.js'

const TELEGRAM_TEXT_LIMIT = 4000 // leave margin below 4096

// ---------- init ----------

const config = loadConfig()
if (!config.telegram.botToken) {
  console.error('[Telegram] Missing TELEGRAM_BOT_TOKEN. Set env or ~/.claude/adapters.json')
  process.exit(1)
}

const bot = new Bot(config.telegram.botToken)
const bridge = new WsBridge(config.serverUrl, 'tg')
const dedup = new MessageDedup()
const sessionStore = new SessionStore()
const httpClient = new AdapterHttpClient(config.serverUrl)

// Track placeholder messages for streaming updates
const placeholders = new Map<string, { chatId: string; messageId: number }>()
// Track accumulated text per chat for streaming
const accumulatedText = new Map<string, string>()
// Message buffers per chat
const buffers = new Map<string, MessageBuffer>()
// Track chats waiting for project selection
const pendingProjectSelection = new Map<string, boolean>()

// ---------- helpers ----------

function getBuffer(chatId: string): MessageBuffer {
  let buf = buffers.get(chatId)
  if (!buf) {
    buf = new MessageBuffer(async (text, isComplete) => {
      await flushToTelegram(chatId, text, isComplete)
    })
    buffers.set(chatId, buf)
  }
  return buf
}

async function flushToTelegram(chatId: string, newText: string, isComplete: boolean): Promise<void> {
  const numericChatId = Number(chatId)
  const prev = accumulatedText.get(chatId) ?? ''
  const fullText = prev + newText
  accumulatedText.set(chatId, fullText)

  const placeholder = placeholders.get(chatId)

  if (placeholder) {
    if (isComplete) {
      const chunks = splitMessage(fullText, TELEGRAM_TEXT_LIMIT)
      try {
        await bot.api.editMessageText(numericChatId, placeholder.messageId, chunks[0]!)
      } catch { /* ignore */ }
      for (let i = 1; i < chunks.length; i++) {
        await bot.api.sendMessage(numericChatId, chunks[i]!)
      }
    } else {
      const displayText = fullText.slice(0, TELEGRAM_TEXT_LIMIT - 2) + ' ▍'
      try {
        await bot.api.editMessageText(numericChatId, placeholder.messageId, displayText)
      } catch { /* ignore */ }
    }
  } else if (isComplete && fullText.trim()) {
    const chunks = splitMessage(fullText, TELEGRAM_TEXT_LIMIT)
    for (const chunk of chunks) {
      await bot.api.sendMessage(numericChatId, chunk)
    }
  }

  if (isComplete) {
    placeholders.delete(chatId)
    accumulatedText.delete(chatId)
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
  const numericChatId = Number(chatId)
  try {
    const sessionId = await httpClient.createSession(workDir)
    sessionStore.set(chatId, sessionId, workDir)
    bridge.connectSession(chatId, sessionId)
    bridge.onServerMessage(chatId, (msg) => handleServerMessage(chatId, msg))
    const opened = await bridge.waitForOpen(chatId)
    if (!opened) {
      await bot.api.sendMessage(numericChatId, '⚠️ 连接服务器超时，请重试。')
      return false
    }
    return true
  } catch (err) {
    await bot.api.sendMessage(numericChatId,
      `❌ 无法创建会话: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

async function showProjectPicker(chatId: string): Promise<void> {
  const numericChatId = Number(chatId)
  try {
    const projects = await httpClient.listRecentProjects()
    if (projects.length === 0) {
      await bot.api.sendMessage(numericChatId,
        '没有找到最近的项目。请先在 Desktop App 中打开一个项目，或在 Settings → IM 接入中配置默认项目。')
      return
    }

    const lines = projects.slice(0, 10).map((p, i) =>
      `${i + 1}. ${p.projectName}${p.branch ? ` (${p.branch})` : ''}\n   ${p.realPath}`
    )
    pendingProjectSelection.set(chatId, true)
    await bot.api.sendMessage(numericChatId,
      `选择项目（回复编号）：\n\n${lines.join('\n\n')}`)
  } catch (err) {
    await bot.api.sendMessage(numericChatId,
      `❌ 无法获取项目列表: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---------- server message handler ----------

async function handleServerMessage(chatId: string, msg: ServerMessage): Promise<void> {
  const numericChatId = Number(chatId)
  const buf = getBuffer(chatId)

  switch (msg.type) {
    case 'connected':
      break

    case 'status':
      if (msg.state === 'thinking' && !placeholders.has(chatId)) {
        const sent = await bot.api.sendMessage(numericChatId, '💭 思考中...')
        placeholders.set(chatId, { chatId, messageId: sent.message_id })
        accumulatedText.set(chatId, '')
      }
      break

    case 'content_start':
      if (msg.blockType === 'text') {
        if (!placeholders.has(chatId)) {
          const sent = await bot.api.sendMessage(numericChatId, '▍')
          placeholders.set(chatId, { chatId, messageId: sent.message_id })
          accumulatedText.set(chatId, '')
        }
      } else if (msg.blockType === 'tool_use') {
        // Finalize current text placeholder before tool calls,
        // so text after tools gets a fresh message
        await buf.complete()
        // If placeholder still exists (buffer was already empty), clean up directly
        if (placeholders.has(chatId)) {
          const text = accumulatedText.get(chatId)
          if (text?.trim()) {
            try {
              await bot.api.editMessageText(numericChatId, placeholders.get(chatId)!.messageId, text)
            } catch { /* ignore */ }
          }
          placeholders.delete(chatId)
          accumulatedText.delete(chatId)
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
      if (placeholders.has(chatId)) {
        try {
          await bot.api.editMessageText(
            numericChatId,
            placeholders.get(chatId)!.messageId,
            `💭 ${msg.text.slice(0, 200)}...`,
          )
        } catch { /* ignore */ }
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
      const text = formatPermissionRequest(msg.toolName, msg.input, msg.requestId)
      const keyboard = new InlineKeyboard()
        .text('✅ 允许', `permit:${msg.requestId}:yes`)
        .text('❌ 拒绝', `permit:${msg.requestId}:no`)
      await bot.api.sendMessage(numericChatId, text, { reply_markup: keyboard })
      break
    }

    case 'message_complete':
      await buf.complete()
      // Ensure placeholder is always cleaned up even if buffer was already empty
      if (placeholders.has(chatId)) {
        const text = accumulatedText.get(chatId)
        if (text?.trim()) {
          try {
            const chunks = splitMessage(text, TELEGRAM_TEXT_LIMIT)
            await bot.api.editMessageText(numericChatId, placeholders.get(chatId)!.messageId, chunks[0]!)
            for (let i = 1; i < chunks.length; i++) {
              await bot.api.sendMessage(numericChatId, chunks[i]!)
            }
          } catch { /* ignore */ }
        }
        placeholders.delete(chatId)
        accumulatedText.delete(chatId)
        buffers.get(chatId)?.reset()
      }
      break

    case 'error':
      await bot.api.sendMessage(numericChatId, `❌ ${msg.message}`)
      break
  }
}

// ---------- bot handlers ----------

bot.command('start', (ctx) => {
  ctx.reply(
    '👋 Claude Code Bot 已就绪。\n\n' +
    '命令:\n' +
    '/projects — 选择/切换项目\n' +
    '/new — 新建会话\n' +
    '/stop — 停止生成'
  )
})

bot.command('new', async (ctx) => {
  const chatId = String(ctx.chat.id)
  bridge.resetSession(chatId)
  sessionStore.delete(chatId)
  placeholders.delete(chatId)
  accumulatedText.delete(chatId)
  buffers.get(chatId)?.reset()
  buffers.delete(chatId)
  pendingProjectSelection.delete(chatId)

  const workDir = config.defaultProjectDir
  if (workDir) {
    const ok = await createSessionForChat(chatId, workDir)
    if (ok) {
      await bot.api.sendMessage(Number(chatId), '✅ 已新建会话，可以开始对话了。')
    }
  } else {
    await showProjectPicker(chatId)
  }
})

bot.command('projects', async (ctx) => {
  const chatId = String(ctx.chat.id)
  await showProjectPicker(chatId)
})

bot.command('stop', (ctx) => {
  const chatId = String(ctx.chat.id)
  bridge.sendStopGeneration(chatId)
  ctx.reply('⏹ 已发送停止信号。')
})

bot.on('message:text', (ctx) => {
  if (!ctx.from) return

  // 只处理私聊
  if (ctx.chat.type !== 'private') return

  if (!dedup.tryRecord(String(ctx.message.message_id))) return

  const chatId = String(ctx.chat.id)
  const userId = ctx.from.id
  const text = ctx.message.text

  // 检查配对状态
  if (!isAllowedUser('telegram', userId)) {
    // 尝试配对
    const displayName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ')
    const success = tryPair(text.trim(), { userId, displayName }, 'telegram')
    if (success) {
      ctx.reply('✅ 配对成功！现在可以开始聊天了。\n\n发送消息即可与 Claude 对话。')
    } else {
      ctx.reply('🔒 未授权。请在 Claude Code 桌面端生成配对码后发送给我。')
    }
    return
  }

  enqueue(chatId, async () => {
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
            await bot.api.sendMessage(Number(chatId),
              `✅ 已选择 ${selected.projectName}。现在可以开始对话了。`)
            return
          }
        } catch { /* fall through */ }
      }
      await bot.api.sendMessage(Number(chatId), '请输入有效的编号。')
      return
    }

    // Normal message flow
    const ready = await ensureSession(chatId)
    if (ready) {
      const sent = bridge.sendUserMessage(chatId, text)
      if (!sent) {
        await bot.api.sendMessage(Number(chatId), '⚠️ 消息发送失败，连接可能已断开。请发送 /new 重新开始。')
      }
    }
  })
})

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data
  if (!data.startsWith('permit:')) return

  const parts = data.split(':')
  if (parts.length !== 3) return

  const requestId = parts[1]!
  const allowed = parts[2] === 'yes'
  const chatId = String(ctx.callbackQuery.message?.chat.id)

  bridge.sendPermissionResponse(chatId, requestId, allowed)

  const statusText = allowed ? '✅ 已允许' : '❌ 已拒绝'
  try {
    await ctx.editMessageText(
      ctx.callbackQuery.message?.text + `\n\n${statusText}`,
    )
  } catch { /* ignore */ }

  await ctx.answerCallbackQuery(statusText)
})

// ---------- start ----------

console.log('[Telegram] Starting bot...')
console.log(`[Telegram] Server: ${config.serverUrl}`)
console.log(`[Telegram] Allowed users: ${config.telegram.allowedUsers.length === 0 ? 'all' : config.telegram.allowedUsers.join(', ')}`)

bot.start({
  onStart: () => console.log('[Telegram] Bot is running!'),
})

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[Telegram] Shutting down...')
  bot.stop()
  bridge.destroy()
  dedup.destroy()
  process.exit(0)
})
