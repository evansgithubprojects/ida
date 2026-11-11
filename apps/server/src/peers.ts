import type { Process } from '@ida-dev/core';
import type { Db } from './db';

/** The broker a message was on at the far end: a topic, an exchange, or the queue an exchange routed it to. */
export interface PeerBroker {
  id: string;
  label: string;
  kind: Process['kind'];
  broker?: Process['broker'];
}

/**
 * One message that crossed between this session and another service. `occurrenceId` is this session's side: a
 * publish (`consumedBy`) or a consume (`publishedBy`). `broker` is the far side's broker process when it differs from
 * this side's (RabbitMQ: published to an exchange, consumed from a queue).
 */
export interface PeerLink {
  occurrenceId: string;
  service: string;
  broker?: PeerBroker;
}

/** What a single session's view needs to draw the other side of its Kafka and RabbitMQ messages. */
export interface SessionPeers {
  consumedBy: PeerLink[];
  publishedBy: PeerLink[];
}

/** The most links of each kind one answer holds, newest first. */
export const MAX_PEER_LINKS = 5000;

interface Row { occurrence_id: string; service: string; process: Process | null }

const link = (r: Row): PeerLink => ({
  occurrenceId: r.occurrence_id,
  service: r.service,
  ...(r.process?.kind && r.process.kind !== 'emitter' && {
    broker: { id: r.process.id, label: r.process.label, kind: r.process.kind, ...(r.process.broker && { broker: r.process.broker }) },
  }),
});

/**
 * Who consumed the messages `sessionId` published, and who published the ones it consumed: the other ends of its
 * links, by the other service's recorder key. Only sessions in `projectId` count, as in the system view.
 */
export async function sessionPeers(db: Pick<Db, 'query'>, projectId: string, sessionId: string): Promise<SessionPeers> {
  // The far side's occurrence -> its template -> the template's emitter -> that node's process.
  const farProcess = (side: 'child' | 'parent') => `
    (select p.data from occurrences o
       join session_templates t on t.session_id = o.session_id and t.id = o.data->>'templateId'
       join session_nodes n on n.session_id = t.session_id and n.id = t.data->>'emitterId'
       join session_processes p on p.session_id = n.session_id and p.id = n.data->>'processId'
     where o.session_id = l.${side}_session and o.id = l.${side}_id)`;
  const consumedBy = await db.query<Row>(
    `select l.parent_id as occurrence_id, r.key as service, ${farProcess('child')} as process
       from occurrence_links l
       join sessions s on s.id = l.child_session
       join recorders r on r.id = s.recorder_id
       join occurrences mine on mine.session_id = l.parent_session and mine.id = l.parent_id
      where l.project_id = $1 and l.parent_session = $2
      order by mine.ts desc limit ${MAX_PEER_LINKS}`,
    [projectId, sessionId],
  );
  const publishedBy = await db.query<Row>(
    `select l.child_id as occurrence_id, r.key as service, ${farProcess('parent')} as process
       from occurrence_links l
       join sessions s on s.id = l.parent_session
       join recorders r on r.id = s.recorder_id and r.project_id = $1
       join occurrences mine on mine.session_id = l.child_session and mine.id = l.child_id
      where l.child_session = $2
      order by mine.ts desc limit ${MAX_PEER_LINKS}`,
    [projectId, sessionId],
  );
  return { consumedBy: consumedBy.map(link), publishedBy: publishedBy.map(link) };
}
