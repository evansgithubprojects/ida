import type { Process } from '@ida-dev/core';

export type BrokerType = NonNullable<Process['broker']>['type'];

export const BROKER_NAMES: Record<BrokerType, string> = { kafka: 'Kafka', rabbitmq: 'RabbitMQ' };

/** What a broker card is, in words: "Kafka topic", "RabbitMQ exchange". */
export const brokerTitle = (type: BrokerType | undefined, kind: string) => (type ? `${BROKER_NAMES[type]} ${kind}` : kind);

/**
 * The broker's mark and the card's kind, drawn small on its cards. The tooltip names both ("Kafka topic"). Without a
 * known broker, only the kind is shown.
 */
export function BrokerLogo({ type, kind }: { type?: BrokerType; kind: string }) {
  const title = brokerTitle(type, kind);
  return (
    <span className="broker-badge" title={title}>
      {type && (
        <span className={`broker-logo broker-logo-${type}`} role="img" aria-label={BROKER_NAMES[type]}>
          {type === 'kafka' ? <KafkaMark /> : <RabbitMark />}
        </span>
      )}
      <span className="broker-kind">{kind}</span>
    </span>
  );
}

/** Kafka's mark: a node linked up, down and out to two more. */
function KafkaMark() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M8 6.5v11M9.8 10.7l6.4-3.4M9.8 13.3l6.4 3.4" strokeLinecap="round" />
      <circle cx="8" cy="4" r="2.4" />
      <circle cx="8" cy="12" r="3" />
      <circle cx="8" cy="20" r="2.4" />
      <circle cx="18.2" cy="6.3" r="2.4" />
      <circle cx="18.2" cy="17.7" r="2.4" />
    </svg>
  );
}

/** RabbitMQ's mark: two ears over a block, with a square eye cut out. */
function RabbitMark() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M3.5 2h3.6c.6 0 1 .4 1 1v7h3V3c0-.6.4-1 1-1h3.6c.6 0 1 .4 1 1v7h3.8c.8 0 1.5.7 1.5 1.5V20.5c0 .8-.7 1.5-1.5 1.5H3.5c-.8 0-1.5-.7-1.5-1.5v-17C2 2.7 2.7 2 3.5 2Zm11.5 12v3.5h3.5V14Z" />
    </svg>
  );
}

/**
 * The label on a recorder's card (a service, or a stub standing for one), drawn like a broker's: a record mark and the
 * word "recorder". The tooltip names the recorder key.
 */
export function RecorderBadge({ recorderKey }: { recorderKey: string }) {
  return (
    <span className="broker-badge recorder-badge" title={`Recorder "${recorderKey}"`}>
      <span className="broker-logo recorder-logo" role="img" aria-label="Recorder">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
        </svg>
      </span>
      <span className="broker-kind">recorder</span>
    </span>
  );
}
