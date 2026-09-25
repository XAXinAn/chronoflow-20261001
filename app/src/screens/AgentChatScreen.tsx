import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { EditorHeader } from '../components/form';
import { Card } from '../components/ui';
import { useAppTheme } from '../context/AppContext';
import {
  AGENT_CAPABILITIES,
  AGENT_NAME,
  AGENT_OFFLINE_NOTICE,
  AGENT_STARTERS,
  agentIsOffline,
} from '../domain/agent';

interface Message {
  id: number;
  role: 'user' | 'agent';
  text: string;
}

/**
 * 智能助手对话（spec §11 阶段三：预留入口）。
 *
 * <p>**目前没有接入任何模型**：输入可用、消息会进来，但助手只会明确回答
 * 「还没有接入模型」。宁可现在看着"简陋"，也不要让界面假装智能——
 * 用户点两次就会发现全是套话，比直说更伤信任。
 */
export function AgentChatScreen() {
  const theme = useAppTheme();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [nextId, setNextId] = useState(1);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const appended: Message[] = [{ id: nextId, role: 'user', text: trimmed }];
    if (agentIsOffline()) {
      appended.push({ id: nextId + 1, role: 'agent', text: AGENT_OFFLINE_NOTICE });
    }
    setMessages((current) => [...current, ...appended]);
    setNextId((current) => current + appended.length);
    setInput('');
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <EditorHeader
        title={AGENT_NAME}
        // 作为底部导航的一级页面：只留标题，不需要返回/保存
        titleOnly
        onCancel={() => undefined}
        onSave={() => undefined}
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={{ padding: theme.spacing.md, gap: 10 }}>
          {messages.length === 0 ? (
            <Card>
              <Text style={{ color: theme.color.textPrimary, fontSize: 16, fontWeight: '600' }}>
                {AGENT_NAME}能做什么
              </Text>
              {AGENT_CAPABILITIES.map((item) => (
                <Text
                  key={item}
                  style={{ color: theme.color.textSecondary, fontSize: 14, marginTop: 8, lineHeight: 20 }}
                >
                  · {item}
                </Text>
              ))}
              <Text style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: 12, lineHeight: 18 }}>
                {AGENT_OFFLINE_NOTICE}
              </Text>
            </Card>
          ) : null}

          {messages.map((message) => (
            <View
              key={message.id}
              style={[styles.bubbleRow, message.role === 'user' ? styles.bubbleRowRight : null]}
            >
              <View
                style={[
                  styles.bubble,
                  {
                    backgroundColor:
                      message.role === 'user' ? theme.color.accent : theme.color.surfaceRaised,
                    borderColor: theme.color.border,
                    borderRadius: theme.radius.card,
                  },
                ]}
              >
                <Text
                  style={{
                    color: message.role === 'user' ? theme.color.accentContrast : theme.color.textPrimary,
                    fontSize: 15,
                    lineHeight: 21,
                  }}
                >
                  {message.text}
                </Text>
              </View>
            </View>
          ))}
        </ScrollView>

        {messages.length === 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            // 横向滚动条的高度必须自己定：不给约束它会吃掉整个剩余高度（踩过）
            style={styles.startersRow}
            contentContainerStyle={styles.starters}
          >
            {AGENT_STARTERS.map((starter) => (
              <Pressable
                key={starter}
                accessibilityRole="button"
                accessibilityLabel={starter}
                onPress={() => send(starter)}
                style={[
                  styles.starter,
                  { borderColor: theme.color.border, borderRadius: theme.radius.tag },
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={{ color: theme.color.textSecondary, fontSize: 13 }}
                >
                  {starter}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        <View
          style={[
            styles.composer,
            {
              borderTopColor: theme.color.border,
              paddingBottom: theme.spacing.md,
              backgroundColor: theme.color.surfaceRaised,
            },
          ]}
        >
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="和我说句话试试"
            placeholderTextColor={theme.color.textTertiary}
            accessibilityLabel="给智能助手发消息"
            onSubmitEditing={() => send(input)}
            returnKeyType="send"
            style={[
              styles.input,
              {
                color: theme.color.textPrimary,
                borderColor: theme.color.border,
                borderRadius: theme.radius.input,
              },
            ]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="发送"
            onPress={() => send(input)}
            style={[styles.send, { backgroundColor: theme.color.accent, borderRadius: theme.radius.button }]}
          >
            <Text style={{ color: theme.color.accentContrast, fontSize: 14, fontWeight: '600' }}>发送</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  bubbleRow: { flexDirection: 'row' },
  bubbleRowRight: { justifyContent: 'flex-end' },
  bubble: {
    maxWidth: '82%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  startersRow: { flexGrow: 0, maxHeight: 48 },
  starters: { paddingHorizontal: 16, paddingBottom: 10, gap: 8, alignItems: 'center' },
  starter: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: { flex: 1, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  send: { paddingHorizontal: 18, paddingVertical: 11 },
});
