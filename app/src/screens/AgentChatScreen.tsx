import { useCallback, useMemo, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { streamAgentChat, type AgentChatTurn } from '../api/agent';
import { AgentMarkdown } from '../components/AgentMarkdown';
import { EditorHeader } from '../components/form';
import { useAppSessionState, useAppTheme, useRuntime } from '../context/AppContext';
import { localDateKey } from '../domain/agenda';
import {
  describeAgentError,
  AGENT_NAME,
  AGENT_STARTERS,
  AGENT_TAGLINE,
} from '../domain/agent';
import { SERVER_ERROR_NOTICE, userFacingError } from '../domain/errors';
import {
  describeActionPreview,
  dropSupersededCards,
  cardInMessage,
  headPendingCard,
  isCreateAction,
  isDestructiveAction,
  isUpdateAction,
  mergeActionCards,
  resolveCard,
  skipPendingCards,
  type AgentActionCard,
} from '../domain/agentActions';
import { agentMarkdownToPlainText } from '../domain/agentMarkdown';
import type { AgentAction, AgentToolRow } from '../domain/agentStream';
import { APP_TIMEZONE } from '../domain/calendar';
import { MicRecorder, type MicRecordingHint } from './agentMic';

type ChatMessage =
  | { id: number; role: 'user'; text: string }
  | {
      id: number;
      role: 'agent';
      text: string;
      /** 这一轮调用过哪些工具（给用户看的记录行） */
      tools: AgentToolRow[];
      /** 待用户授权的写操作（一次只摆一条） */
      actions: AgentActionCard[];
    };

/**
 * 只留助手的消息：授权卡片都挂在助手消息上。
 */
function agentMessages(messages: ChatMessage[]): Extract<ChatMessage, { role: 'agent' }>[] {
  return messages.filter(
    (message): message is Extract<ChatMessage, { role: 'agent' }> => message.role === 'agent',
  );
}

/**
 * 智能助手「小安」（spec §11 阶段三）。
 *
 * <p>交互按「豆包」那套路子来（骨架，不是配色）：空态给推荐问法、用户消息是右侧深色气泡、
 * 助手回复是左对齐正文（不进气泡，长回答才有呼吸感）、生成中末尾一个光标、
 * 底部大圆角输入框 + 长按说话。
 *
 * <p>三条不能省的规则：
 * <ol>
 *   <li>**写操作必须用户点确认**：模型只能生成卡片，真正的写入由本页调既有 REST 接口；</li>
 *   <li>**看不清状态要说出来**：查询期间显示「正在查日程…」，生成中显示光标与「停止」；</li>
 *   <li>**没接入就说没接入**：能力取自服务端 `/system/info`，而不是写死。</li>
 * </ol>
 */
export function AgentChatScreen({
  onOpenEvent,
}: {
  /** 确认卡片创建成功后，「查看日程」跳到编辑页 */
  onOpenEvent?: (eventId: number, dateKey: string) => void;
}) {
  const theme = useAppTheme();
  const { api, baseUrl, session } = useRuntime();
  const { activeOrgIdentityId } = useAppSessionState();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [recordingHint, setRecordingHint] = useState<MicRecordingHint | null>(null);

  const nextIdRef = useRef(1);
  const abortRef = useRef<AbortController | null>(null);
  /** 本条用户消息之后连续自动继续了几次（授权允许后自动回传），上限见 AUTO_CONTINUE_LIMIT。 */
  const scrollRef = useRef<ScrollView | null>(null);

  /** 卡片上的「今天 / 明天」相对说法要用它；一天之内不会变，所以只算一次。 */
  const todayKey = useMemo(() => localDateKey(new Date().toISOString(), APP_TIMEZONE), []);

  /** 当前待处理的授权（一次只有一条）：它会在底部顶掉输入框。 */
  const pendingAuth = useMemo(() => {
    for (const message of messages) {
      if (message.role !== 'agent') {
        continue;
      }
      const card = headPendingCard(message.actions);
      if (card) {
        return { messageId: message.id, card };
      }
    }
    return null;
  }, [messages]);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, []);

  const patchAgentMessage = useCallback(
    (id: number, patch: (message: Extract<ChatMessage, { role: 'agent' }>) => ChatMessage) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === id && message.role === 'agent' ? patch(message) : message,
        ),
      );
    },
    [],
  );

  /**
   * 新卡片挂到最新的助手消息上，同时把**别的消息里**被它取代的那张摘掉。
   *
   * <p>用户接着说「改成下午四点」会是新的一轮、新的助手消息，
   * 旧卡片如果留在上一条消息里，对话区就会同时挂着 15:00 和 16:00 两张 —— 点哪个都可能建错。
   */
  const attachActionCard = useCallback((agentId: number, incoming: AgentAction) => {
    setMessages((current) =>
      current.map((message) => {
        if (message.role !== 'agent') {
          return message;
        }
        if (message.id === agentId) {
          return { ...message, actions: mergeActionCards(message.actions, incoming) };
        }
        return { ...message, actions: dropSupersededCards(message.actions, incoming) };
      }),
    );
  }, []);

  /** 追加一行工具记录（查询类与写入类都记，用户能看到"它做了什么"）。 */
  const attachToolRow = useCallback((agentId: number, row: AgentToolRow) => {
    patchAgentMessage(agentId, (message) => ({ ...message, tools: [...message.tools, row] }));
  }, [patchAgentMessage]);

  /**
   * 跑一轮对话。
   *
   * @param userText 用户说的话
   */
  const runTurn = useCallback(
    async (userText: string | null) => {
      if (streaming) {
        return;
      }
      const userMessage: ChatMessage | null = userText
        ? { id: nextIdRef.current++, role: 'user', text: userText }
        : null;
      const agentId = nextIdRef.current++;
      const agentMessage: ChatMessage = {
        id: agentId,
        role: 'agent',
        text: '',
        tools: [],
        actions: [],
      };
      const history = userMessage ? [...messages, userMessage] : messages;

      setMessages((current) =>
        userMessage ? [...current, userMessage, agentMessage] : [...current, agentMessage],
      );
      setError(null);
      setStatusLabel(null);
      setStreaming(true);
      scrollToEnd();

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const token = await session.getAccessToken();
        await streamAgentChat({
          baseUrl,
          token,
          signal: controller.signal,
          payload: {
            messages: toTurns(history),
            orgIdentityId: activeOrgIdentityId,
          },
          onEvent: (event) => {
            if (event.type === 'status') {
              setStatusLabel(event.label);
            } else if (event.type === 'delta') {
              setStatusLabel(null);
              patchAgentMessage(agentId, (message) => ({
                ...message,
                text: message.text + event.text,
              }));
              scrollToEnd();
            } else if (event.type === 'tool') {
              setStatusLabel(null);
              attachToolRow(agentId, event.tool);
              scrollToEnd();
            } else if (event.type === 'action') {
              setStatusLabel(null);
              attachActionCard(agentId, event.action);
              scrollToEnd();
            } else if (event.type === 'error') {
              setStatusLabel(null);
              // 内部错误码与「未接入模型」这类话一律翻译成用户能行动的一句
              setError(describeAgentError(event.code, event.message));
            }
          },
        });
      } catch (failure) {
        setError(userFacingError(failure, SERVER_ERROR_NOTICE));
      } finally {
        abortRef.current = null;
        setStreaming(false);
        setStatusLabel(null);
      }
    },
    [
      activeOrgIdentityId,
      attachActionCard,
      attachToolRow,
      baseUrl,
      messages,
      patchAgentMessage,
      scrollToEnd,
      session,
      streaming,
    ],
  );

  /** 用户发消息：先把还挂着的授权记为「未处理」，再开一轮。 */
  const send = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      if (!text || streaming) {
        return;
      }
      // 还挂着授权时用户又发了新消息：把那条标成「未处理」。服务端那条流会等超时按拒绝收尾
      // （界面上输入框被授权面板顶掉时本来就发不出消息，这是兜底路径）
      if (messages.some((message) =>
        message.role === 'agent' && headPendingCard(message.actions) !== null)) {
        setMessages((current) =>
          current.map((message) =>
            message.role === 'agent'
              ? { ...message, actions: skipPendingCards(message.actions) }
              : message,
          ),
        );
      }
      setInput('');
      await runTurn(text);
    },
    [messages, runTurn, streaming],
  );

  /** 用户点「停止」：中断流，已生成的内容留在界面上（豆包也是这个行为）。 */
  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setStatusLabel(null);
  }, []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setStreaming(false);
    setStatusLabel(null);
    setError(null);
  }, []);

  /**
   * 用户点「允许 / 拒绝」：把答复交给服务端。
   *
   * <p>写工具正在**对话流里等这个答复**（mewcode 的 PermissionReply）：允许它就真正落库、
   * 拒绝就写一条「什么都没改」的工具结果，两条路都会让同一条流继续跑下去，
   * 所以这里只发一条审批请求，不再由 App 去调 REST、也不再自己续跑。
   */
  const decideAction = useCallback(
    async (messageId: number, actionId: string, allow: boolean) => {
      const target = cardInMessage(agentMessages(messages), messageId, actionId);
      if (!target || target.status !== 'pending') {
        return;
      }
      patchAgentMessage(messageId, (message) => ({
        ...message,
        actions: resolveCard(message.actions, actionId,
          allow ? { status: 'allowed' } : { status: 'denied' }),
      }));
      if (allow) {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      } else {
        void Haptics.selectionAsync().catch(() => undefined);
      }
      try {
        await api.approveAgentAction({ actionId, allow });
      } catch (cause) {
        patchAgentMessage(messageId, (message) => ({
          ...message,
          actions: resolveCard(message.actions, actionId,
            { status: 'failed', error: userFacingError(cause, '授权没送到，请重试') }),
        }));
      }
    },
    [api, messages, patchAgentMessage],
  );

  const allowAction = useCallback(
    async (messageId: number, actionId: string) => decideAction(messageId, actionId, true),
    [decideAction],
  );

  const denyAction = useCallback(
    (messageId: number, actionId: string) => {
      void decideAction(messageId, actionId, false);
    },
    [decideAction],
  );

  const copyMessage = useCallback((text: string) => {
    const plain = agentMarkdownToPlainText(text);
    if (!plain) {
      return;
    }
    void Clipboard.setStringAsync(plain);
    void Haptics.selectionAsync().catch(() => undefined);
  }, []);

  const transcribe = useCallback(
    async (uri: string) => {
      setTranscribing(true);
      try {
        const result = await api.transcribe(uri);
        const text = (result?.text ?? '').trim();
        if (!text) {
          setError('没有听清，再说一次试试');
          return;
        }
        // 不自动发送：识别会出错，让用户看一眼、改一改再发
        setInput((current) => (current ? `${current}${text}` : text));
      } catch (failure) {
        setError(userFacingError(failure, '语音识别失败，请再说一次'));
      } finally {
        setTranscribing(false);
      }
    },
    [api],
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <EditorHeader
        // 就叫「小安」：服务端接没接模型是部署方的事，不该出现在用户的标题栏里
        title={AGENT_NAME}
        titleOnly
        onCancel={() => undefined}
        onSave={() => undefined}
        right={
          // 对话不落库，「新对话」= 清空当前这段：放在标题栏右上角，和豆包的位置一致
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="清空对话"
            disabled={messages.length === 0}
            onPress={clear}
            hitSlop={10}
          >
            <Ionicons
              name="create-outline"
              size={22}
              color={messages.length === 0 ? theme.color.textTertiary : theme.color.textSecondary}
            />
          </Pressable>
        }
      />

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: theme.spacing.md, gap: 18, paddingBottom: 24 }}
        onContentSizeChange={scrollToEnd}
      >
        {messages.length === 0 ? (
          <View style={{ marginTop: theme.spacing.lg }}>
            <Text style={{ color: theme.color.textPrimary, fontSize: 30, fontWeight: '700' }}>
              {AGENT_NAME}
            </Text>
            <Text style={{ color: theme.color.textSecondary, fontSize: 15, marginTop: 8 }}>
              {AGENT_TAGLINE}
            </Text>
            {/* 空态只放「你可以问我什么」。服务端可不可用不该写在这里，出问题会在对话流里如实报 */}
            <View style={styles.starterGrid}>
              {AGENT_STARTERS.map((starter) => (
                <Pressable
                  key={starter}
                  accessibilityRole="button"
                  accessibilityLabel={starter}
                  onPress={() => void send(starter)}
                  style={[
                    styles.starterCard,
                    {
                      borderColor: theme.color.border,
                      borderRadius: theme.radius.card,
                      backgroundColor: theme.color.surface,
                    },
                  ]}
                >
                  <Text style={{ color: theme.color.textSecondary, fontSize: 13, lineHeight: 19 }}>
                    {starter}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        {messages.map((message) =>
          message.role === 'user' ? (
            <Pressable
              key={message.id}
              accessibilityRole="text"
              accessibilityLabel="我发送的消息，长按复制"
              onLongPress={() => copyMessage(message.text)}
              style={styles.userRow}
            >
              <View
                style={{
                  maxWidth: '82%',
                  backgroundColor: theme.color.accent,
                  borderRadius: theme.radius.card,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                }}
              >
                <Text style={{ color: theme.color.accentContrast, fontSize: 15, lineHeight: 22 }}>
                  {message.text}
                </Text>
              </View>
            </Pressable>
          ) : (
            <View key={message.id} style={styles.agentBlock}>
              {/* 工具记录行：它做了什么，看得见 */}
              {message.tools.map((row) => (
                <ToolRowLine key={row.toolCallId + row.summary} row={row} />
              ))}
              <Pressable
                accessibilityRole="text"
                accessibilityLabel="小安的回复，长按复制"
                onLongPress={() => copyMessage(message.text)}
              >
                <AgentMarkdown text={message.text} />
              </Pressable>
              {/* 已经处理过的授权：留一行结果记录（待处理的那条在底部，顶替输入框） */}
              {message.actions
                .filter((card) => card.status !== 'pending')
                .map((card) => (
                  <AuthorizationResultLine
                    key={card.action.actionId}
                    card={card}
                    onOpenEvent={
                      onOpenEvent && card.eventId
                        ? () =>
                            onOpenEvent(
                              card.eventId as number,
                              localDateKey(
                                // 修改类可能没带时间：依次回退到原值，最后才用当前时间
                                card.action.payload.at
                                  ?? card.action.payload.previous?.at
                                  ?? new Date().toISOString(),
                                APP_TIMEZONE,
                              ),
                            )
                        : undefined
                    }
                  />
                ))}
            </View>
          ),
        )}

        {statusLabel ? (
          <Text style={{ color: theme.color.textTertiary, fontSize: 12 }}>{statusLabel}</Text>
        ) : null}
        {streaming && !statusLabel ? (
          <Text style={{ color: theme.color.textTertiary, fontSize: 15 }}>▌</Text>
        ) : null}
        {error ? (
          <View
            style={[
              styles.errorBox,
              { borderColor: theme.color.danger, borderRadius: theme.radius.card },
            ]}
          >
            <Text style={{ color: theme.color.danger, fontSize: 13, lineHeight: 19 }}>{error}</Text>
          </View>
        ) : null}
      </ScrollView>

      {/*
        有待授权的写操作时，**授权块顶掉输入框**（Codex 就是这样）：
        没处理完不许继续打字，避免用户在"到底建没建"之间来回猜。
      */}
      {/*
        有卡片挂着就把输入框让给它 —— **哪怕是 streaming**：新流程里服务端正是在流没结束时
        阻塞等用户点授权，如果这里要求 !streaming，面板就永远不出现，用户只能干等（实测卡死）。
      */}
      {pendingAuth ? (
        <View
          style={[
            styles.composer,
            styles.authPanel,
            {
              borderTopColor: theme.color.border,
              backgroundColor: theme.color.surfaceRaised,
            },
          ]}
        >
          <AuthorizationPanel
            card={pendingAuth.card}
            todayKey={todayKey}
            onAllow={() => void allowAction(pendingAuth.messageId, pendingAuth.card.action.actionId)}
            onDeny={() => denyAction(pendingAuth.messageId, pendingAuth.card.action.actionId)}
          />
        </View>
      ) : (
      <View
        style={[
          styles.composer,
          {
            borderTopColor: theme.color.border,
            backgroundColor: theme.color.surfaceRaised,
          },
        ]}
      >
        <MicRecorder
          disabled={transcribing || streaming}
          onHint={setRecordingHint}
          onRecorded={(uri) => void transcribe(uri)}
          onError={setError}
        />
        <TextInput
          value={input}
          onChangeText={setInput}
          multiline
          placeholder="说点什么…"
          placeholderTextColor={theme.color.textTertiary}
          accessibilityLabel="给小安发消息"
          style={[
            styles.input,
            {
              color: theme.color.textPrimary,
              borderColor: theme.color.border,
              backgroundColor: theme.color.surface,
              borderRadius: theme.radius.input,
            },
          ]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={streaming ? '停止生成' : '发送'}
          disabled={!streaming && !input.trim()}
          onPress={() => (streaming ? stop() : void send(input))}
          style={({ pressed }) => [
            styles.sendButton,
            {
              backgroundColor:
                !streaming && !input.trim() ? theme.color.border : theme.color.accent,
              opacity: pressed ? 0.85 : 1,
            },
          ]}
        >
          <Ionicons
            name={streaming ? 'square' : 'arrow-up'}
            size={18}
            color={theme.color.accentContrast}
          />
        </Pressable>
      </View>
      )}

      {recordingHint ? (
        <View style={styles.recordingOverlay} pointerEvents="none">
          <View
            style={[
              styles.recordingCard,
              { backgroundColor: theme.color.surfaceRaised, borderRadius: theme.radius.card },
            ]}
          >
            <Text style={{ color: theme.color.textPrimary, fontSize: 15 }}>
              {recordingHint.slidingCancel ? '松开手指，取消发送' : '正在录音…'}
            </Text>
            <Text style={{ color: theme.color.textSecondary, fontSize: 13, marginTop: 6 }}>
              {recordingHint.seconds.toFixed(1)}s
            </Text>
            <LevelBars level={recordingHint.level} />
            <Text style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: 8 }}>
              上滑取消
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** 录音浮层上的音量条：让用户知道「确实在收音」。 */
function LevelBars({ level }: { level: number }) {
  const theme = useAppTheme();
  const bars = 12;
  const active = Math.round(Math.max(0, Math.min(1, level)) * bars);
  return (
    <View style={styles.levelRow}>
      {Array.from({ length: bars }, (_, index) => (
        <View
          key={index}
          style={{
            width: 4,
            height: 8 + (index % 4) * 4,
            borderRadius: 2,
            backgroundColor: index < active ? theme.color.accent : theme.color.border,
          }}
        />
      ))}
    </View>
  );
}

/**
 * 一行工具记录：小字 + 可展开的人话明细。
 *
 * <p>没有它就只有一个瞬时的「正在查日程…」，用户看不到它到底做了什么、查到了什么。
 */
function ToolRowLine({ row }: { row: AgentToolRow }) {
  const theme = useAppTheme();
  const [expanded, setExpanded] = useState(false);
  const hasDetail = row.detail.length > 0;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${row.summary}${hasDetail ? '，点开看明细' : ''}`}
        disabled={!hasDetail}
        onPress={() => setExpanded((current) => !current)}
        hitSlop={6}
        style={styles.toolRow}
      >
        <Ionicons
          name={row.readOnly ? 'search-outline' : 'flash-outline'}
          size={13}
          color={theme.color.textTertiary}
        />
        <Text style={{ color: theme.color.textTertiary, fontSize: 12, flexShrink: 1 }}>
          {row.summary}
        </Text>
        {hasDetail ? (
          <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={12}
            color={theme.color.textTertiary}
          />
        ) : null}
      </Pressable>
      {expanded ? (
        <View style={styles.toolDetail}>
          {row.detail.map((line, index) => (
            <Text
              key={`${row.toolCallId}-${index}`}
              style={{ color: theme.color.textTertiary, fontSize: 12, lineHeight: 18 }}
            >
              · {line}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * 底部的授权块（Codex 式）：有它的时候**顶掉输入框**。
 *
 * <p>为什么占着输入框：写操作没处理完，用户最容易做的就是"再打一句话催一下"，
 * 而那会让"到底建没建"变得说不清。先让他把这一条处理掉，再把输入框还回来。
 */
function AuthorizationPanel({
  card,
  todayKey,
  onAllow,
  onDeny,
}: {
  card: AgentActionCard;
  todayKey: string;
  onAllow: () => void;
  onDeny: () => void;
}) {
  const theme = useAppTheme();
  const preview = describeActionPreview(card.action, todayKey);
  const when = [preview.dateText, preview.timeText].filter(Boolean).join(' · ');
  const danger = isDestructiveAction(card.action);
  const title = isCreateAction(card.action)
    ? '创建日程'
    : isUpdateAction(card.action)
      ? '修改日程'
      : '删除日程';
  const busy = card.status === 'running';

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.color.textPrimary, fontSize: 15, lineHeight: 21 }}>
        <Text style={{ fontWeight: '600' }}>{title}</Text>
        {' · '}
        {preview.title}
        {when ? ` · ${when}` : ''}
      </Text>
      {preview.beforeText ? (
        <Text style={{ color: theme.color.textTertiary, fontSize: 12 }}>原：{preview.beforeText}</Text>
      ) : null}
      {preview.locationText ? (
        <Text style={{ color: theme.color.textTertiary, fontSize: 12 }}>地点：{preview.locationText}</Text>
      ) : null}
      {preview.detailText ? (
        <Text style={{ color: theme.color.textTertiary, fontSize: 12 }}>详细地址：{preview.detailText}</Text>
      ) : null}
      <View style={styles.authButtons}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="拒绝"
          disabled={busy}
          onPress={onDeny}
          style={[styles.authGhost, { borderColor: theme.color.border, opacity: busy ? 0.45 : 1 }]}
        >
          <Text style={{ color: theme.color.textSecondary, fontSize: 14 }}>拒绝</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="允许"
          accessibilityState={{ disabled: busy, busy }}
          disabled={busy}
          onPress={onAllow}
          style={[
            styles.authPrimary,
            {
              backgroundColor: danger ? theme.color.danger : theme.color.accent,
              opacity: busy ? 0.45 : 1,
            },
          ]}
        >
          <Text style={{ color: theme.color.accentContrast, fontSize: 14, fontWeight: '600' }}>
            {busy ? '处理中…' : '允许'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * 处理完的授权在对话里留一行结果。
 *
 * <p>待处理的那条在底部顶替输入框；这里只记"后来怎么样了"，
 * 否则界面上会只剩一句「已申请创建」，用户看不出到底做没做。
 */
function AuthorizationResultLine({
  card,
  onOpenEvent,
}: {
  card: AgentActionCard;
  onOpenEvent?: () => void;
}) {
  const theme = useAppTheme();
  const text = isCreateAction(card.action)
    ? '创建'
    : isUpdateAction(card.action)
      ? '修改'
      : '删除';
  const label =
    card.status === 'allowed'
      ? `已允许 · 已${text}`
      : card.status === 'denied'
        ? '已拒绝'
        : card.status === 'skipped'
          ? '未处理'
          : `执行失败：${card.error ?? ''}`;
  const color =
    card.status === 'allowed'
      ? theme.color.success
      : card.status === 'failed'
        ? theme.color.danger
        : theme.color.textTertiary;
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ color, fontSize: 12 }} numberOfLines={2}>
        {label} · {card.action.summary}
      </Text>
      {card.status === 'allowed' && onOpenEvent ? (
        <Pressable accessibilityRole="button" accessibilityLabel="查看日程" onPress={onOpenEvent} hitSlop={8}>
          <Text style={{ color: theme.color.accent, fontSize: 12, fontWeight: '600' }}>查看日程</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** 界面只送纯文本：历史里不掺工具调用，服务端每轮自己决定要不要查数据。 */
/**
 * 把界面上的对话还原成模型眼里的历史。
 *
 * <p>助手那条消息如果调用过工具，就拆成「assistant 带 toolCalls」+「tool 带结果」两条
 * （mewcode `conversation/Message` 的形状）。**必须配对**：少了工具调用，
 * 模型会以为上一轮那件事没落地，把同一个动作再申请一次。
 */
function toTurns(messages: ChatMessage[]): AgentChatTurn[] {
  const turns: AgentChatTurn[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      if (message.text.trim()) {
        turns.push({ role: 'user', content: message.text });
      }
      continue;
    }
    const calls = message.tools.filter((row) => row.toolCallId && row.name);
    if (calls.length === 0) {
      if (message.text.trim()) {
        turns.push({ role: 'assistant', content: message.text });
      }
      continue;
    }
    turns.push({
      role: 'assistant',
      content: message.text,
      toolCalls: calls.map((row) => ({
        id: row.toolCallId,
        name: row.name,
        arguments: row.arguments,
      })),
    });
    for (const row of calls) {
      turns.push({ role: 'tool', toolCallId: row.toolCallId, content: row.result || '{}' });
    }
  }
  return turns;
}

const styles = StyleSheet.create({
  starterGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 20 },
  starterCard: {
    width: '47%',
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 68,
  },
  userRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  agentBlock: { gap: 10 },
  errorBox: { borderWidth: 1, padding: 10 },
  /** 工具记录行：一行小字，点了才展开明细 */
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  toolDetail: { marginTop: 2, marginLeft: 19, gap: 2 },
  /** 授权行：一条一行，右侧「允许 / 拒绝」 */
  authRow: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  authButtons: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  authGhost: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 6 },
  authPrimary: { borderRadius: 8, paddingHorizontal: 18, paddingVertical: 7 },
  /** 授权块顶替输入框时的容器：竖排，左对齐 */
  authPanel: { flexDirection: 'column', alignItems: 'stretch' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: Platform.OS === 'ios' ? 24 : 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    maxHeight: 120,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordingOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  recordingCard: { padding: 20, alignItems: 'center', minWidth: 220, gap: 4 },
  levelRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, marginTop: 10, height: 22 },
});
