# Naming processes and handlers

The viewer draws **processes** (groups of emitters) and **handlers** (the listeners in them). Good names make the graph read like your architecture. This page shows how Ida names things and how to choose names yourself.

## Default names

| Thing | Default name |
| --- | --- |
| Handler | The function's `name` (`function chargeCard() {}` → `chargeCard`). Anonymous functions are `anonymous#1`, `anonymous#2`… |
| Emitter (process) | The emitter's class name (`class OrderBus extends EventEmitter` → `OrderBus`). A plain `EventEmitter`, `EventTarget` or `Object` gets a number: `EventEmitter#3`. |
| DOM target | `window`, `document`, `tag#id`, `tag.firstClass`, or the tag name (`button#checkout`, `div.cart`). |
| Kafka topic, RabbitMQ exchange or queue | Its name. An empty RabbitMQ exchange is `(default exchange)`. |
| Kafka consumer handler (Python, own `poll()` loop) | `<group.id> consumer` |
| RabbitMQ generator consumer (Python, `channel.consume()`) | `<queue> consumer` |
| Python handler | The function's qualified name without `<locals>.`; lambdas are `anonymous#n`. |

Emitters with the same label share one process. That is usually what you want (every instance of `OrderBus` is one process), but two unrelated plain `EventEmitter`s each get their own number.

## Naming handlers

Name your functions, and the graph names itself:

:::lang node,browser
```js
// Shows as "anonymous#4"
orders.on('order:placed', (order) => charge(order));

// Shows as "chargeCard"
orders.on('order:placed', function chargeCard(order) { charge(order); });

// Arrow functions assigned to a const are named too
const chargeCard = (order) => charge(order);
orders.on('order:placed', chargeCard);
```

Or give a label explicitly, which also works for functions you don't control:

```js
recorder.labelHandler(chargeCard, 'charge card');
```
:::

:::lang python
```python
recorder.label_handler(charge_card, "charge card")
```
:::

## Naming emitters

:::lang node,browser
```js
const payments = new EventEmitter();
recorder.labelEmitter(payments, 'Payments');
```
:::

:::lang python
```python
payments = ida.Emitter("Payments")          # Python emitters take their label directly
recorder.label_emitter(some_object, "Payments")
```
:::

For DOM targets, name many at once with the adapter's `label` option:

```js
enableEventTargetRecording(recorder, {
  label: (t) => (t instanceof HTMLFormElement ? `form ${t.name}` : undefined), // undefined: use the default
});
```

> **Label before the first event.** A process gets its name the first time one of its emitters is recorded, and keeps it. Call `labelEmitter` right after creating the emitter.

## Labels with several recorders

Labels belong to a recorder. If an emitter is tracked by two recorders, label it in each (or in the one you look at). `connectRecorder(key)` returns the same recorder anywhere, so you can label from the module that owns the emitter:

```js
connectRecorder('payments').labelEmitter(paymentsBus, 'Payments');
```

## Naming services

In the viewer's [services level](../viewer/traces-and-system.md#services), each **service** is a recorder key. Give each service its own key (`connectRecorder('checkout')`, `ida.connect_recorder("payments")`) rather than leaving everything in `default`, so services are told apart.
