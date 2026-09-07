import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { MarkdownViewer } from 'cordisx/ui';
import type { PageParticipant } from './chatroom-timeline-entries.js';
import './chatroom-message-body.css';

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...defaultSchema.tagNames ?? [], 'video'],
  attributes: {
    ...defaultSchema.attributes,
    span: [...defaultSchema.attributes?.span ?? [], 'dataChatroomMention'],
    img: [...defaultSchema.attributes?.img ?? [], 'width', 'height'],
    source: ['media', 'src', 'srcSet', 'type'],
    video: ['src', 'poster', 'controls', 'loop', 'muted', 'playsInline', 'preload', 'width', 'height', 'title'],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: ['http', 'https', 'data'],
    srcSet: ['http', 'https', 'data'],
    poster: ['http', 'https', 'data'],
  },
};

function markdownUrl(value: string, key: string) {
  return ['src', 'srcSet', 'poster'].includes(key) && /^data:(?:image|video)\/[a-z0-9.+-]+(?:;base64)?,/iu.test(value)
    ? value
    : defaultUrlTransform(value);
}

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[]; data?: Record<string, unknown>; };

export function participantMentionAliases(
  participants: readonly (PageParticipant & { readonly mentionAlias?: string; })[],
) {
  const candidates = new Map<string, Set<string>>();
  for (const participant of participants) {
    for (const alias of [participant.id, participant.name, participant.mentionAlias]) {
      if (!alias) continue;
      const ids = candidates.get(alias) ?? new Set<string>();
      ids.add(participant.id);
      candidates.set(alias, ids);
    }
  }
  return [...candidates].flatMap(([alias, ids]) => ids.size === 1 ? [{ alias, participantId: [...ids][0] }] : [])
    .sort((left, right) => right.alias.length - left.alias.length);
}

/** Transform only parsed prose nodes. Code and existing links keep their semantics. */
export function remarkParticipantMentions(participants: readonly PageParticipant[]) {
  const aliases = participantMentionAliases(participants);
  const textNodes = (value: string): MarkdownNode[] => {
    const output: MarkdownNode[] = [];
    let cursor = 0;
    let searchFrom = 0;
    while (searchFrom < value.length) {
      const marker = value.indexOf('@', searchFrom);
      if (marker < 0) break;
      searchFrom = marker + 1;
      if (marker > 0 && /[\p{L}\p{N}._~@-]/u.test(value[marker - 1])) continue;
      const match = aliases.find(({ alias }) => {
        if (!value.startsWith(alias, marker + 1)) return false;
        const next = value[marker + alias.length + 1];
        return next === undefined || !/[\p{L}\p{N}._~-]/u.test(next);
      });
      if (match === undefined) continue;
      if (marker > cursor) output.push({ type: 'text', value: value.slice(cursor, marker) });
      output.push({
        type: 'chatroomMention',
        data: { hName: 'span', hProperties: { 'data-chatroom-mention': match.participantId } },
        children: [{ type: 'text', value: `@${match.alias}` }],
      });
      cursor = marker + match.alias.length + 1;
      searchFrom = cursor;
    }
    if (cursor < value.length) output.push({ type: 'text', value: value.slice(cursor) });
    return output;
  };
  const visit = (node: MarkdownNode): void => {
    if (['code', 'inlineCode', 'link', 'linkReference', 'html'].includes(node.type) || node.children === undefined) {
      return;
    }
    node.children = node.children.flatMap(child => {
      if (child.type === 'text' && child.value !== undefined) return textNodes(child.value);
      visit(child);
      return [child];
    });
  };
  return () => (tree: unknown): void => visit(tree as MarkdownNode);
}

export function ChatroomMessageBody({ source, participants, onParticipantClick, label }: {
  readonly source: string;
  readonly participants: readonly PageParticipant[];
  readonly onParticipantClick?: (participantId: string) => void;
  readonly label: string;
}) {
  const publicBlock = (
    node: { position?: { start: { offset?: number; }; end: { offset?: number; }; }; } | undefined,
  ) => {
    const start = node?.position?.start.offset;
    const end = node?.position?.end.offset;
    return start === undefined || end === undefined ? undefined : <MarkdownViewer source={source.slice(start, end)} />;
  };
  return (
    <div className="cx-chatroom-markdown" aria-label={label}>
      <Markdown
        remarkPlugins={[remarkGfm, remarkParticipantMentions(participants)]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
        urlTransform={markdownUrl}
        components={{
          a: ({ node: _node, href, ...props }) => (
            <a
              {...props}
              href={href}
              {...(/^https?:\/\//i.test(href ?? '') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            />
          ),
          // Delegate complete code/media nodes to the public projection: it owns
          // highlighting and theme-aware pictures. Prose remains one Markdown AST.
          pre: ({ node, ...props }) => publicBlock(node) ?? <pre {...props} />,
          picture: ({ node, ...props }) => publicBlock(node) ?? <picture {...props} />,
          video: ({ node, ...props }) => publicBlock(node) ?? <video {...props} controls preload="metadata" />,
          img: ({ node: _node, ...props }) => <img {...props} loading="lazy" decoding="async" />,
          span: ({ node, children, ...props }) => {
            const participantId = node?.properties.dataChatroomMention ?? node?.properties['data-chatroom-mention'];
            const participant = participants.find(candidate => candidate.id === participantId);
            return participant !== undefined && onParticipantClick !== undefined
              ? (
                <button
                  type="button"
                  className="cx-chatroom-markdown__mention"
                  aria-label={participant.name}
                  onClick={() => onParticipantClick(participant.id)}
                >
                  {children}
                </button>
              )
              : <span {...props}>{children}</span>;
          },
        }}
      >
        {source}
      </Markdown>
    </div>
  );
}
