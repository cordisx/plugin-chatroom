import { useEffect, useRef, useState } from 'cordisx/react';
import { Button } from 'cordisx/ui';
import type { AgentDefinitionIdentity } from '@cordisx/protocol/agents/v1';
import type {
  EntityExecutionBindingSnapshot,
  EntityExecutionContexts,
  HostExecutionProject,
} from '@cordisx/protocol/entity-execution-context/v1';
import './entity-project-binding.css';

type ProjectMessage =
  | 'detail.project'
  | 'detail.projectless'
  | 'detail.project-loading'
  | 'detail.project-unavailable'
  | 'detail.project-missing'
  | 'detail.project-save'
  | 'detail.project-saved'
  | 'detail.project-conflict'
  | 'detail.project-future-only';
type Translate = (key: ProjectMessage) => string;

/** Entity configuration only: selecting a real project never creates or migrates a Session. */
export function EntityProjectBinding({ identity, contexts, t }: {
  readonly identity: AgentDefinitionIdentity;
  readonly contexts?: EntityExecutionContexts;
  readonly t: Translate;
}) {
  const [snapshot, setSnapshot] = useState<EntityExecutionBindingSnapshot>();
  const [projects, setProjects] = useState<readonly HostExecutionProject[]>();
  const [selected, setSelected] = useState('');
  const [feedback, setFeedback] = useState<string>();
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const mutation = useRef<{ key: string; id: string; } | undefined>(undefined);
  const mounted = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    mounted.current = true;
    epoch.current += 1;
    mutation.current = undefined;
    pending.current = false;
    setSaving(false);
    let cancelled = false;
    setSnapshot(undefined);
    setProjects(undefined);
    setFeedback(undefined);
    if (contexts !== undefined) {
      void Promise.all([contexts.get(identity), contexts.projects()]).then(([binding, catalog]) => {
        if (cancelled) return;
        if (binding.status !== 'available' || catalog.status !== 'available') {
          setFeedback(t('detail.project-unavailable'));
          return;
        }
        setSnapshot(binding);
        setProjects(catalog.projects);
        setSelected(binding.binding.kind === 'project' ? binding.binding.projectId : '');
      }).catch(() => {
        if (!cancelled) {
          setFeedback(t('detail.project-unavailable'));
        }
      });
    }
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [contexts, identity.agentId, identity.revision, t]);
  if (contexts === undefined) {
    return <p className="cx-chatroom-entity-project__note">{t('detail.project-unavailable')}</p>;
  }
  if (snapshot === undefined || projects === undefined) {
    return <p className="cx-chatroom-entity-project__note">{feedback ?? t('detail.project-loading')}</p>;
  }
  const current = snapshot.binding.kind === 'project' ? snapshot.binding.projectId : '';
  const unavailableProject = selected !== '' && !projects.some(project => project.id === selected);
  return (
    <div className="cx-chatroom-entity-project">
      <label>
        <span>{t('detail.project')}</span>
        <select value={selected} disabled={saving} onChange={event => setSelected(event.target.value)}>
          <option value="">{t('detail.projectless')}</option>
          {unavailableProject && <option value={selected} disabled>{t('detail.project-missing')}</option>}
          {projects.map(project => (
            <option key={project.id} value={project.id} disabled={project.roots.length === 0}>{project.name}</option>
          ))}
        </select>
      </label>
      <Button
        disabled={saving || selected === current || unavailableProject}
        onClick={async () => {
          if (pending.current) return;
          const currentEpoch = epoch.current;
          const key = JSON.stringify([identity, snapshot.revision, selected]);
          if (mutation.current !== undefined && mutation.current.key !== key) {
            setFeedback(t('detail.project-conflict'));
            return;
          }
          mutation.current ??= { key, id: `entity-project.${crypto.randomUUID()}` };
          pending.current = true;
          setSaving(true);
          setFeedback(undefined);
          try {
            const result = await contexts.set({
              identity,
              expectedRevision: snapshot.revision,
              mutationId: mutation.current.id,
              binding: selected === '' ? { kind: 'projectless' } : { kind: 'project', projectId: selected },
            });
            if (!mounted.current || epoch.current !== currentEpoch) return;
            if (result.status === 'applied') {
              mutation.current = undefined;
              setSnapshot(result);
              setFeedback(t('detail.project-saved'));
            } else {setFeedback(
                t(result.status === 'conflict' ? 'detail.project-conflict' : 'detail.project-unavailable'),
              );}
          } catch {
            if (mounted.current && epoch.current === currentEpoch) setFeedback(t('detail.project-unavailable'));
          } finally {
            if (epoch.current === currentEpoch) {
              pending.current = false;
              if (mounted.current) setSaving(false);
            }
          }
        }}
      >
        {t('detail.project-save')}
      </Button>
      <p className="cx-chatroom-entity-project__note">{t('detail.project-future-only')}</p>
      {feedback && <p role="status">{feedback}</p>}
    </div>
  );
}
