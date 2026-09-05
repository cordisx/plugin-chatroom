import { type AgentAvatarRef, cloneAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1';
import { type AvatarDefinition, createSeededAvatarDefinition, parseAvatarDefinition } from '@oneworks/avatar';
import avatarVendorCss from '@oneworks/avatar-react/style.css';
import React, {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'cordisx/react';

import { resolveOfficialOneWorksAvatarAsset } from './avatar-assets.js';
import { chatroomAvatarFingerprint } from './avatar-fingerprint.js';
import type { ChatroomAvatarRendererHandle } from './avatar-renderer.js';
import { loadModuleOnce } from './lazy-module.js';
import { pngBlobSnapshot } from './sidebar-image-cache.js';
import type { RasterImageSnapshotV1 } from './sidebar-image-cache.js';

const loadChatroomAvatarRenderer = loadModuleOnce(() => import('./avatar-renderer.js'));
const LazyChatroomAvatarRenderer = lazy(async () => ({
  default: (await loadChatroomAvatarRenderer()).ChatroomAvatarRenderer,
}));

export interface ChatroomAvatarParticipant {
  readonly id: string;
  readonly name: string;
  readonly avatar?: AgentAvatarRef;
}

export type ChatroomAvatarResolution =
  | Readonly<
    {
      status: 'resolved';
      avatar: Extract<AgentAvatarRef, { kind: 'generated' | 'asset'; }>;
      definition: AvatarDefinition;
    }
  >
  | Readonly<
    { status: 'unsupported'; avatar: AgentAvatarRef; code: 'unsupported-provider' | 'reference-unavailable'; }
  >;
type ResolvedAvatar = Extract<ChatroomAvatarResolution, { status: 'resolved'; }>;

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

/** Bounded, product-owned definition resolver. No ref is interpreted as a URL or path. */
export class ChatroomAvatarResolver {
  private readonly cache = new Map<string, ResolvedAvatar>();

  constructor(
    readonly maximumEntries = 256,
    private readonly createDefinition: (seed: string) => AvatarDefinition = seed =>
      createSeededAvatarDefinition({ name: 'Chatroom Agent', seed }),
  ) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 4_096) {
      throw new RangeError('Avatar resolver capacity must be between 1 and 4096.');
    }
  }

  resolve(input: AgentAvatarRef): ChatroomAvatarResolution {
    const avatar = cloneAgentAvatarRef(input);
    const key = chatroomAvatarFingerprint(avatar);
    const retained = this.cache.get(key);
    if (retained !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, retained);
      return retained;
    }
    if (avatar.kind === 'platform' || avatar.kind === 'definition') {
      return Object.freeze({
        status: 'unsupported' as const,
        avatar,
        code: avatar.kind === 'platform' ? 'unsupported-provider' as const : 'reference-unavailable' as const,
      });
    }
    const definition = avatar.kind === 'generated'
      ? this.createDefinition(avatar.seed)
      : resolveOfficialOneWorksAvatarAsset(avatar.ref, avatar.revision);
    if (definition === undefined) {
      return Object.freeze({ status: 'unsupported' as const, avatar, code: 'reference-unavailable' as const });
    }
    const result: ResolvedAvatar = Object.freeze({
      status: 'resolved' as const,
      avatar,
      definition: deepFreeze(parseAvatarDefinition(definition)),
    });
    this.cache.set(key, result);
    while (this.cache.size > this.maximumEntries) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }

  get size(): number {
    return this.cache.size;
  }
  clear(): void {
    this.cache.clear();
  }
}

export const defaultChatroomAvatarResolver = new ChatroomAvatarResolver();

export function participantInitials(label: string): string {
  const normalized = label.trim();
  if (normalized === '') return '?';
  const words = normalized.split(/\s+/u);
  return (words.length > 1
    ? words.slice(0, 2).map(word => Array.from(word)[0]).join('')
    : Array.from(normalized).slice(0, 2).join('')).toLocaleUpperCase();
}

const vendorAvatarRules = (avatarVendorCss.match(/\.oneworks-avatar[^{}]*\{[^{}]*\}/gu) ?? [])
  .slice(0, 6)
  .map(rule =>
    rule
      .replace(/^\.oneworks-avatar/u, '.cx-chatroom-avatar .oneworks-avatar')
      .replace(/,\.oneworks-avatar-editor(?: \*)?/gu, '')
  )
  .join('\n');
if (
  avatarVendorCss !== ''
  && !vendorAvatarRules.includes('.cx-chatroom-avatar .oneworks-avatar>.interactive-avatar')
) {
  throw new Error('OneWorks Avatar RC.8 style export is incompatible with Chatroom.');
}

export const CHATROOM_AVATAR_VENDOR_STYLES = vendorAvatarRules;

interface FailureBoundaryProps {
  readonly resetKey: string;
  readonly fallback: ReactNode;
  readonly children: ReactNode;
  readonly onFailure: () => void;
}

class AvatarFailureBoundary extends React.Component<FailureBoundaryProps, { failed: boolean; }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean; } {
    return { failed: true };
  }
  componentDidCatch(): void {
    this.props.onFailure();
  }
  componentDidUpdate(previous: FailureBoundaryProps): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }
  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export interface ChatroomAvatarProps {
  readonly participant: ChatroomAvatarParticipant;
  readonly resolver?: ChatroomAvatarResolver;
  readonly fallback?: 'initials' | 'neutral';
  readonly capture?: boolean;
  readonly onSnapshot?: (image: RasterImageSnapshotV1) => void;
}

/** Decorative direct renderer; OneWorks owns the SVG and Chatroom owns every fallback. */
export function ChatroomAvatar({
  participant,
  resolver = defaultChatroomAvatarResolver,
  fallback = 'initials',
  capture = false,
  onSnapshot,
}: ChatroomAvatarProps) {
  const handleRef = useRef<ChatroomAvatarRendererHandle>(null);
  const callbackRef = useRef(onSnapshot);
  callbackRef.current = onSnapshot;
  const [renderFailed, setRenderFailed] = useState(false);
  const [rendererReadyKey, setRendererReadyKey] = useState<string>();
  const resolution = useMemo(() => {
    if (participant.avatar === undefined) return undefined;
    try {
      return resolver.resolve(participant.avatar);
    } catch {
      return undefined;
    }
  }, [participant.avatar, resolver]);
  const key = chatroomAvatarFingerprint(participant.avatar);
  useEffect(() => {
    setRenderFailed(false);
  }, [key]);
  const resolved = resolution?.status === 'resolved' && !renderFailed;
  const markRendererReady = useCallback(() => {
    setRendererReadyKey(key);
  }, [key]);

  useEffect(() => {
    if (!capture || !resolved || rendererReadyKey !== key || callbackRef.current === undefined) return;
    let current = true;
    const frame = globalThis.requestAnimationFrame(() => {
      const handle = handleRef.current;
      if (handle === null) return;
      void handle.capture({ format: 'png', size: 128, frame: 'square', background: 'transparent' })
        .then(blob => pngBlobSnapshot(blob, 128, 128))
        .then(image => {
          if (current) callbackRef.current?.(image);
        })
        // Snapshot failure affects only the optional sidebar image. The direct
        // page avatar remains valid and must not be replaced by a fallback.
        .catch(() => {});
    });
    return () => {
      current = false;
      globalThis.cancelAnimationFrame(frame);
    };
  }, [capture, key, rendererReadyKey, resolved]);

  const fallbackNode = fallback === 'neutral'
    ? <span className="cx-chatroom-avatar__neutral" />
    : <span className="cx-chatroom-avatar__initials">{participantInitials(participant.name)}</span>;
  return (
    <span
      className="cx-chatroom-avatar"
      aria-hidden="true"
      data-avatar-state={resolved ? 'resolved' : 'fallback'}
      {...(resolution?.status === 'unsupported' ? { 'data-avatar-code': resolution.code } : {})}
    >
      {resolved
        ? (
          <AvatarFailureBoundary resetKey={key} fallback={fallbackNode} onFailure={() => setRenderFailed(true)}>
            <Suspense fallback={fallbackNode}>
              <LazyChatroomAvatarRenderer
                ref={handleRef}
                definition={resolution.definition}
                onError={() => setRenderFailed(true)}
                onReady={markRendererReady}
              />
            </Suspense>
          </AvatarFailureBoundary>
        )
        : fallbackNode}
    </span>
  );
}
