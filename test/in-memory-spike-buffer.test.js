'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createInMemorySpikeBuffer } = require('../src/queue/in-memory-spike-buffer');

test('enqueue stores the event and reports size', async () => {
  const buffer = createInMemorySpikeBuffer({ concurrency: 1 });
  const id = buffer.enqueue({ hello: 'world' });
  assert.ok(id);
  assert.strictEqual(buffer.size(), 1);
});

test('processes items serially with concurrency 1 (no overlap)', async () => {
  const order = [];
  let active = 0;
  let maxActive = 0;
  let resolved = 0;

  const processor = (item) =>
    new Promise((resolve) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(item.payload.n);
      setTimeout(() => {
        active -= 1;
        resolved += 1;
        resolve();
      }, 5);
    });

  const buffer = createInMemorySpikeBuffer({ concurrency: 1, processor });
  for (let n = 0; n < 10; n += 1) buffer.enqueue({ n });

  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(maxActive, 1, 'should never process more than one item at a time');
  assert.strictEqual(resolved, 10);
  assert.deepStrictEqual(order, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.strictEqual(buffer.size(), 0);
});

test('drains to zero after processing', async () => {
  const processor = () => new Promise((resolve) => setTimeout(resolve, 2));
  const buffer = createInMemorySpikeBuffer({ concurrency: 1, processor });
  buffer.enqueue({ a: 1 });
  buffer.enqueue({ a: 2 });
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(buffer.size(), 0);
});
