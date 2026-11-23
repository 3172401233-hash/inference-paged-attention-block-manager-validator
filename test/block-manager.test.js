'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BlockManager } = require('../src/block-manager');
const { runScenario } = require('../src/simulate');

function codes(mgr) {
  return mgr.evidence.map((e) => e.code);
}

test('共享前缀：引用计数与可读块正确，活动请求的块不可回收', () => {
  const mgr = new BlockManager({ numBlocks: 4 });
  mgr.addRequest(0, 'r1', [0, 1]);
  mgr.sharePrefix(1, 'r2', 'r1', 2);

  assert.equal(mgr.blocks[0].refcount, 2);
  assert.equal(mgr.blocks[1].refcount, 2);
  assert.deepEqual(mgr.requests.get('r2').table, [0, 1]);

  const readable = mgr.readableBlocks('r2');
  assert.deepEqual(readable.map((e) => e.block), [0, 1]);
  assert.ok(readable.every((e) => e.readable));

  assert.deepEqual(mgr.safeReclaimSet(), []);
  mgr.reclaim(2, 0);
  assert.ok(codes(mgr).includes('reclaim-referenced-block'));
  assert.equal(mgr.blocks[0].state, 'allocated');
});

test('取消竞争：引用计数释放后仍有进行中读取的块不能回收', () => {
  const mgr = new BlockManager({ numBlocks: 2 });
  mgr.addRequest(0, 'r1', [0]);
  mgr.sharePrefix(1, 'r2', 'r1', 1);
  mgr.beginRead(2, 'r2', 0);

  mgr.cancel(3, 'r1');
  assert.equal(mgr.blocks[0].refcount, 1);
  mgr.cancel(4, 'r2');
  assert.equal(mgr.blocks[0].refcount, 0);

  assert.deepEqual(mgr.safeReclaimSet(), []);
  assert.equal(mgr.reclaim(5, 0), false);
  assert.ok(codes(mgr).includes('reclaim-while-reading'));
  assert.equal(mgr.blocks[0].state, 'allocated');

  mgr.endRead(6, 'r2', 0);
  assert.deepEqual(mgr.safeReclaimSet(), [0]);
  assert.equal(mgr.reclaim(7, 0), true);
  assert.equal(mgr.blocks[0].state, 'reclaimed');
});

test('COW：共享块写入前必须复制，复制到错误块表会被记录', () => {
  const mgr = new BlockManager({ numBlocks: 4 });
  mgr.addRequest(0, 'r1', [0]);
  mgr.sharePrefix(1, 'r2', 'r1', 1);

  mgr.write(2, 'r1', 0, { content: 'x' });
  assert.ok(codes(mgr).includes('shared-write-without-cow'));
  assert.equal(mgr.blocks[0].content, null);

  mgr.write(3, 'r1', 0, { cow: true, content: 'x' });
  const privateBlock = mgr.requests.get('r1').table[0];
  assert.notEqual(privateBlock, 0);
  assert.equal(mgr.blocks[0].refcount, 1);
  assert.equal(mgr.blocks[privateBlock].refcount, 1);
  assert.equal(mgr.blocks[privateBlock].content, 'x');
  assert.equal(mgr.requests.get('r2').table[0], 0);

  mgr.sharePrefix(4, 'r3', 'r2', 1);
  mgr.write(5, 'r3', 0, { cow: true, into: 'r2', content: 'y' });
  assert.ok(codes(mgr).includes('cow-wrong-block-table'));

  mgr.sharePrefix(6, 'r4', 'r2', 1);
  mgr.write(7, 'r2', 0, { cow: true, copyFrom: 3, content: 'z' });
  assert.ok(codes(mgr).includes('cow-wrong-source'));
});

test('重复回收：第二次回收同一物理块会被拒绝并记录证据', () => {
  const mgr = new BlockManager({ numBlocks: 2 });
  mgr.addRequest(0, 'r1', [0]);
  mgr.finish(1, 'r1');
  assert.deepEqual(mgr.safeReclaimSet(), [0]);

  assert.equal(mgr.reclaim(2, 0), true);
  assert.equal(mgr.reclaim(3, 0), false);
  assert.ok(codes(mgr).includes('duplicate-reclaim'));

  assert.equal(mgr.reclaim(4, 1), false);
  assert.ok(codes(mgr).includes('reclaim-unallocated-block'));
});

test('场景模拟：每步输出可读块与安全回收范围，并汇总不一致证据', () => {
  const report = runScenario({
    numBlocks: 3,
    events: [
      { type: 'add_request', request: 'r1', blocks: [0] },
      { type: 'share', request: 'r2', from: 'r1', count: 1 },
      { type: 'begin_read', request: 'r2', index: 0 },
      { type: 'cancel', request: 'r1' },
      { type: 'cancel', request: 'r2' },
      { type: 'reclaim', block: 0 },
      { type: 'end_read', request: 'r2', index: 0 },
      { type: 'reclaim', block: 0 },
      { type: 'reclaim', block: 0 },
    ],
  });

  assert.equal(report.steps.length, 9);

  const step1 = report.steps[1];
  assert.deepEqual(step1.snapshot.readable.r2.map((e) => e.block), [0]);
  assert.deepEqual(step1.snapshot.safeReclaim, []);

  const step5 = report.steps[5];
  assert.deepEqual(step5.snapshot.safeReclaim, []);
  assert.ok(step5.evidence.some((e) => e.code === 'reclaim-while-reading'));

  const step7 = report.steps[7];
  assert.deepEqual(step7.snapshot.safeReclaim, []);
  assert.deepEqual(report.reclaimLog, [{ step: 7, block: 0 }]);

  const step8 = report.steps[8];
  assert.ok(step8.evidence.some((e) => e.code === 'duplicate-reclaim'));

  const allCodes = report.evidence.map((e) => e.code);
  assert.ok(allCodes.includes('reclaim-while-reading'));
  assert.ok(allCodes.includes('duplicate-reclaim'));
  assert.equal(report.final.blocks[0].state, 'reclaimed');
});

test('重复释放与引用计数交叉校验', () => {
  const mgr = new BlockManager({ numBlocks: 2 });
  mgr.addRequest(0, 'r1', [0]);
  mgr.cancel(1, 'r1');
  mgr.cancel(2, 'r1');
  assert.ok(codes(mgr).includes('request-not-active'));
  assert.equal(mgr.blocks[0].refcount, 0);

  mgr.verifyConsistency(3);
  assert.ok(!codes(mgr).includes('refcount-mismatch'));
});
