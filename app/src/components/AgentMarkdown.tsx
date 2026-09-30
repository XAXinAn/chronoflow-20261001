import { useMemo } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../context/AppContext';
import { parseAgentMarkdown, type AgentInline } from '../domain/agentMarkdown';

/**
 * 助手回复的轻量 Markdown 渲染（spec §11 阶段三）。
 *
 * <p>只渲染 `domain/agentMarkdown.ts` 认识的那几种块与行内样式；不认识的东西
 * （表格、链接、HTML）一律按纯文本显示——模型偶尔多写一个 `|` 或 `<b>`，
 * 界面上不该因此出现任何意外。
 *
 * <p>用 Text 嵌套实现粗体与行内代码，而不是 WebView / 富文本库：
 * 助手回复是要能被选中复制的普通文本，套一层 WebView 反而更难用。
 */
export function AgentMarkdown({ text }: { text: string }) {
  const theme = useAppTheme();
  const blocks = useMemo(() => parseAgentMarkdown(text), [text]);
  const body = { color: theme.color.textPrimary, fontSize: 15, lineHeight: 24 };

  return (
    <View style={styles.root}>
      {blocks.map((block, blockIndex) => {
        if (block.type === 'bullet' || block.type === 'ordered') {
          return (
            <View key={`block-${blockIndex}`} style={styles.list}>
              {block.items.map((item, itemIndex) => (
                <View key={`item-${itemIndex}`} style={styles.listRow}>
                  <Text style={[body, styles.marker]}>
                    {block.type === 'bullet' ? '·' : `${itemIndex + 1}.`}
                  </Text>
                  <Text style={[body, styles.listBody]}>
                    <Inline parts={item} />
                  </Text>
                </View>
              ))}
            </View>
          );
        }
        if (block.type === 'quote') {
          return (
            <View
              key={`block-${blockIndex}`}
              style={[styles.quote, { borderLeftColor: theme.color.border }]}
            >
              {block.lines.map((line, lineIndex) => (
                <Text key={`line-${lineIndex}`} style={[body, { color: theme.color.textSecondary }]}>
                  <Inline parts={line} />
                </Text>
              ))}
            </View>
          );
        }
        return (
          <Text key={`block-${blockIndex}`} style={body}>
            {block.lines.map((line, lineIndex) => (
              <Text key={`line-${lineIndex}`}>
                {lineIndex > 0 ? '\n' : ''}
                <Inline parts={line} />
              </Text>
            ))}
          </Text>
        );
      })}
    </View>
  );
}

function Inline({ parts }: { parts: AgentInline[] }) {
  const theme = useAppTheme();
  return (
    <>
      {parts.map((part, index) => {
        if (part.type === 'bold') {
          return (
            <Text key={index} style={{ fontWeight: '700' }}>
              {part.text}
            </Text>
          );
        }
        if (part.type === 'code') {
          return (
            <Text
              key={index}
              style={{
                color: theme.color.textSecondary,
                fontFamily: PlatformMono,
              }}
            >
              {part.text}
            </Text>
          );
        }
        return <Text key={index}>{part.text}</Text>;
      })}
    </>
  );
}

/** 行内代码用等宽字体；不同平台的名字不一样，取不到就退回系统默认。 */
const PlatformMono = Platform.select({ ios: 'Menlo', default: 'monospace' });

const styles = StyleSheet.create({
  root: { gap: 8 },
  list: { gap: 4 },
  listRow: { flexDirection: 'row', alignItems: 'flex-start' },
  marker: { width: 20 },
  listBody: { flex: 1 },
  quote: { borderLeftWidth: 3, paddingLeft: 10 },
});
