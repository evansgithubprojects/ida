import { EventEmitter } from 'node:events';

/** A small fake shop: Auth -> Cart -> Payments -> Notifier, with nested sync emits and a few scripted failures. */
export function createShop(label: (e: EventEmitter, name: string) => void, markExternal: (fn: Function) => void = () => {}) {
  const auth = new EventEmitter();
  const cart = new EventEmitter();
  const payments = new EventEmitter();
  const notifier = new EventEmitter();
  label(auth, 'Auth');
  label(cart, 'Cart');
  label(payments, 'Payments');
  label(notifier, 'Notifier');

  const sent: string[] = [];
  let orderSeq = 1000;

  auth.on('login', function loadCart(user: { id: string; name: string }) {
    cart.emit('cart:load', { userId: user.id, items: [] });
  });
  auth.on('login', function welcome(user: { id: string; name: string }) {
    notifier.emit('notify', { to: user.id, text: `welcome ${user.name}` });
  });

  cart.on('cart:load', function restoreItems() {});
  cart.on('checkout', function startPayment(order: { id: string; total: number; items: string[] }) {
    payments.emit('charge', order);
  });

  payments.on('charge', function chargeCard(order: { id: string; total: number; items: string[] }) {
    if (order.items.includes('chargeback')) {
      // Scripted failure 1: emits a half-built result, then throws.
      payments.emit('order:confirmed', { id: order.id, total: undefined, items: order.items });
      throw new Error('gateway timeout');
    }
    if (order.items.includes('rounding-bug')) {
      // Scripted bug 3: no error at all, just a wrong type heading to the ledger API.
      payments.emit('order:confirmed', { id: order.id, total: String(order.total), items: order.items });
      return;
    }
    if (order.items.includes('bad-address')) {
      // Scripted bug 4: no error either; the customer notification loses its recipient.
      notifier.emit('notify', { to: undefined, text: '' });
      return;
    }
    payments.emit('order:confirmed', { id: order.id, total: order.total, items: order.items });
  });
  payments.on('charge', function fraudCheck(order: { id: string; total: number; items: string[] }) {
    // Scripted failure 2: catches its own error, reports it, then carries on with bad data.
    if (order.items.includes('fraud-risk')) {
      payments.emit('error', new Error('fraud service unreachable'));
      payments.emit('order:confirmed', { id: order.id, total: NaN, items: [] });
    }
  });

  // Simulated call to an outside ledger API: corrupt payloads reaching this are high priority.
  const postToLedgerApi = function postToLedgerApi(_order: { id: string; total: number }) {};
  markExternal(postToLedgerApi);
  payments.on('order:confirmed', postToLedgerApi);
  payments.on('order:confirmed', function sendReceipt(order: { id: string }) {
    notifier.emit('notify', { to: 'customer', text: `receipt ${order.id}` });
  });
  payments.on('error', function logError() {});
  notifier.on('notify', function deliver(msg: { text: string }) {
    sent.push(msg.text);
  });

  const nextOrder = (total: number, extra?: string) => ({ id: `ord_${++orderSeq}`, total, items: extra ? ['book', extra] : ['book', 'pen'] });

  return {
    sent,
    login: (n: number) => auth.emit('login', { id: `u${n}`, name: `user${n}` }),
    checkout: (total: number, extra?: string) => {
      try {
        cart.emit('checkout', nextOrder(total, extra));
      } catch {
        /* the app swallows payment failures, which is what lets bad data leak */
      }
    },
  };
}
