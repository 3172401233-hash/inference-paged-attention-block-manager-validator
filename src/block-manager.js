'use strict';

/**
 * 分页注意力块管理器（纯 CPU 侧元数据模拟，不访问 GPU）。
 *
 * 不变量：
 *  - 活动请求依赖的物理块不能被回收；
 *  - 引用计数 > 1 的共享块，写入前必须完成写时复制（COW）；
 *  - 引用计数释放后，仍存在进行中读取的块不能回收（取消竞争）。
 */
class BlockManager {
  constructor({ numBlocks = 8 } = {}) {
    this.blocks = [];
    for (let i = 0; i < numBlocks; i += 1) {
      this.blocks.push({ id: i, state: 'free', refcount: 0, readers: 0, content: null });
    }
    this.requests = new Map();
    this.evidence = [];
    this.reclaimLog = [];
    this._mismatchReported = new Set();
  }

  _fail(step, code, message, details = {}) {
    this.evidence.push({ step, code, message, ...details });
  }

  _activeRequest(step, reqId) {
    const req = this.requests.get(reqId);
    if (!req) {
      this._fail(step, 'unknown-request', `请求 ${reqId} 不存在`, { request: reqId });
      return null;
    }
    if (req.state !== 'active') {
      this._fail(step, 'request-not-active', `请求 ${reqId} 已处于 ${req.state} 状态`, { request: reqId });
      return null;
    }
    return req;
  }

  _mapBlock(step, req, index, physId) {
    const block = this.blocks[physId];
    if (!block) {
      this._fail(step, 'unknown-block', `物理块 ${physId} 不存在`, { request: req.id, block: physId });
      return;
    }
    if (block.state === 'reclaimed') {
      this._fail(step, 'map-reclaimed-block', `物理块 ${physId} 已被回收，不能映射到请求 ${req.id}`, { request: req.id, block: physId });
      return;
    }
    if (block.state === 'free') {
      block.state = 'allocated';
      block.refcount = 0;
    }
    block.refcount += 1;
    req.table[index] = physId;
  }

  addRequest(step, reqId, blocks = []) {
    if (this.requests.has(reqId)) {
      this._fail(step, 'duplicate-request', `请求 ${reqId} 已存在`, { request: reqId });
      return;
    }
    const req = { id: reqId, state: 'active', table: new Array(blocks.length).fill(null), released: [], inFlight: new Map() };
    this.requests.set(reqId, req);
    blocks.forEach((physId, index) => this._mapBlock(step, req, index, physId));
  }

  sharePrefix(step, reqId, fromReqId, count) {
    const from = this.requests.get(fromReqId);
    if (!from) {
      this._fail(step, 'unknown-request', `共享来源请求 ${fromReqId} 不存在`, { request: fromReqId });
      return;
    }
    let req = this.requests.get(reqId);
    if (!req) {
      req = { id: reqId, state: 'active', table: [], released: [], inFlight: new Map() };
      this.requests.set(reqId, req);
    }
    if (req.state !== 'active') {
      this._fail(step, 'request-not-active', `请求 ${reqId} 已处于 ${req.state} 状态，不能共享前缀`, { request: reqId });
      return;
    }
    for (let index = 0; index < count; index += 1) {
      const physId = from.table[index];
      if (physId == null) {
        this._fail(step, 'share-unmapped-prefix', `请求 ${fromReqId} 的逻辑块 ${index} 未映射，无法共享`, { request: reqId, from: fromReqId });
        continue;
      }
      this._mapBlock(step, req, index, physId);
    }
  }

  append(step, reqId, physId) {
    const req = this._activeRequest(step, reqId);
    if (!req) return;
    let target = physId;
    if (target == null) {
      target = this._allocateFree(step);
      if (target == null) return;
    }
    this._mapBlock(step, req, req.table.length, target);
  }

  _allocateFree(step) {
    const block = this.blocks.find((b) => b.state === 'free');
    if (!block) {
      this._fail(step, 'out-of-blocks', '没有可分配的空闲物理块');
      return null;
    }
    return block.id;
  }

  beginRead(step, reqId, index) {
    const req = this._activeRequest(step, reqId);
    if (!req) return;
    const physId = req.table[index];
    if (physId == null) {
      this._fail(step, 'read-unmapped', `请求 ${reqId} 的逻辑块 ${index} 未映射`, { request: reqId });
      return;
    }
    const block = this.blocks[physId];
    if (block.state === 'reclaimed') {
      this._fail(step, 'read-reclaimed-block', `请求 ${reqId} 读取了已回收的物理块 ${physId}（释放后使用）`, { request: reqId, block: physId });
      return;
    }
    block.readers += 1;
    req.inFlight.set(index, physId);
  }

  endRead(step, reqId, index) {
    const req = this.requests.get(reqId);
    if (!req) {
      this._fail(step, 'unknown-request', `请求 ${reqId} 不存在`, { request: reqId });
      return;
    }
    const physId = req.inFlight.get(index);
    if (physId == null) {
      this._fail(step, 'read-not-in-flight', `请求 ${reqId} 的逻辑块 ${index} 没有进行中的读取`, { request: reqId });
      return;
    }
    req.inFlight.delete(index);
    const block = this.blocks[physId];
    block.readers -= 1;
    if (block.readers < 0) {
      this._fail(step, 'readers-underflow', `物理块 ${physId} 的进行中读取计数出现下溢`, { block: physId });
      block.readers = 0;
    }
  }

  write(step, reqId, index, opts = {}) {
    const req = this._activeRequest(step, reqId);
    if (!req) return;
    const physId = req.table[index];
    if (physId == null) {
      this._fail(step, 'write-unmapped', `请求 ${reqId} 的逻辑块 ${index} 未映射`, { request: reqId });
      return;
    }
    const block = this.blocks[physId];
    if (block.state === 'reclaimed') {
      this._fail(step, 'write-reclaimed-block', `请求 ${reqId} 写入了已回收的物理块 ${physId}`, { request: reqId, block: physId });
      return;
    }
    if (block.refcount > 1) {
      if (!opts.cow) {
        this._fail(
          step,
          'shared-write-without-cow',
          `物理块 ${physId} 被 ${block.refcount} 个引用共享，请求 ${reqId} 写入前必须完成 COW`,
          { request: reqId, block: physId },
        );
        return;
      }
      this._copyOnWrite(step, req, index, block, opts);
      return;
    }
    if (opts.content !== undefined) block.content = opts.content;
  }

  _copyOnWrite(step, req, index, block, opts) {
    const sourceId = opts.copyFrom ?? block.id;
    const source = this.blocks[sourceId];
    if (sourceId !== block.id) {
      this._fail(
        step,
        'cow-wrong-source',
        `COW 从物理块 ${sourceId} 复制旧内容，但请求 ${req.id} 的逻辑块 ${index} 实际映射的是物理块 ${block.id}`,
        { request: req.id, block: block.id, copyFrom: sourceId },
      );
    }
    const newId = this._allocateFree(step);
    if (newId == null) return;
    const fresh = this.blocks[newId];
    fresh.state = 'allocated';
    fresh.refcount = 1;
    fresh.content = source ? source.content : null;
    block.refcount -= 1;
    const targetReqId = opts.into ?? req.id;
    if (targetReqId !== req.id) {
      this._fail(
        step,
        'cow-wrong-block-table',
        `COW 新块 ${newId} 被装入请求 ${targetReqId} 的块表，而不是发起写入的请求 ${req.id}（旧内容复制到错误块表）`,
        { request: req.id, into: targetReqId, block: block.id, newBlock: newId },
      );
    }
    const target = this.requests.get(targetReqId);
    if (!target || target.state !== 'active') {
      this._fail(step, 'cow-target-not-active', `COW 目标请求 ${targetReqId} 不存在或已结束`, { request: targetReqId });
      return;
    }
    target.table[index] = newId;
    if (opts.content !== undefined) fresh.content = opts.content;
  }

  cancel(step, reqId) {
    this._release(step, reqId, 'cancelled');
  }

  finish(step, reqId) {
    this._release(step, reqId, 'finished');
  }

  _release(step, reqId, state) {
    const req = this.requests.get(reqId);
    if (!req) {
      this._fail(step, 'unknown-request', `请求 ${reqId} 不存在`, { request: reqId });
      return;
    }
    if (req.state !== 'active') {
      this._fail(step, 'request-not-active', `请求 ${reqId} 已处于 ${req.state} 状态，不能重复释放`, { request: reqId });
      return;
    }
    req.state = state;
    req.table.forEach((physId) => {
      if (physId == null) return;
      const block = this.blocks[physId];
      block.refcount -= 1;
      req.released.push(physId);
      if (block.refcount < 0) {
        this._fail(step, 'refcount-underflow', `物理块 ${physId} 的引用计数出现下溢`, { block: physId });
        block.refcount = 0;
      }
    });
    req.table = [];
  }

  reclaim(step, physId) {
    const block = this.blocks[physId];
    if (!block) {
      this._fail(step, 'unknown-block', `物理块 ${physId} 不存在`, { block: physId });
      return false;
    }
    if (block.state === 'reclaimed') {
      this._fail(step, 'duplicate-reclaim', `物理块 ${physId} 已被回收，重复回收`, { block: physId });
      return false;
    }
    if (block.state === 'free') {
      this._fail(step, 'reclaim-unallocated-block', `物理块 ${physId} 尚未分配，不能回收`, { block: physId });
      return false;
    }
    if (block.refcount > 0) {
      this._fail(step, 'reclaim-referenced-block', `物理块 ${physId} 仍被 ${block.refcount} 个引用持有，活动请求依赖的块不能回收`, { block: physId });
      return false;
    }
    if (block.readers > 0) {
      this._fail(step, 'reclaim-while-reading', `物理块 ${physId} 仍有 ${block.readers} 个进行中的读取（取消竞争），不能回收`, { block: physId });
      return false;
    }
    block.state = 'reclaimed';
    block.content = null;
    this.reclaimLog.push({ step, block: physId });
    return true;
  }

  /** 安全回收范围：已分配、无引用、无进行中读取的物理块。 */
  safeReclaimSet() {
    return this.blocks
      .filter((b) => b.state === 'allocated' && b.refcount === 0 && b.readers === 0)
      .map((b) => b.id);
  }

  /** 交叉校验：活动请求实际映射数必须与引用计数一致。 */
  verifyConsistency(step) {
    const counted = new Map();
    for (const req of this.requests.values()) {
      if (req.state !== 'active') continue;
      for (const physId of req.table) {
        if (physId == null) continue;
        counted.set(physId, (counted.get(physId) ?? 0) + 1);
      }
    }
    for (const block of this.blocks) {
      if (block.state !== 'allocated') continue;
      const actual = counted.get(block.id) ?? 0;
      if (actual !== block.refcount && !this._mismatchReported.has(block.id)) {
        this._mismatchReported.add(block.id);
        this._fail(
          step,
          'refcount-mismatch',
          `物理块 ${block.id} 的引用计数为 ${block.refcount}，但活动请求实际映射数为 ${actual}`,
          { block: block.id, refcount: block.refcount, actual },
        );
      }
    }
  }

  readableBlocks(reqId) {
    const req = this.requests.get(reqId);
    if (!req || req.state !== 'active') return [];
    return req.table.map((physId, index) => ({
      index,
      block: physId,
      readable: physId != null && this.blocks[physId].state === 'allocated',
    }));
  }

  snapshot() {
    const requests = [...this.requests.values()].map((req) => ({
      id: req.id,
      state: req.state,
      table: [...req.table],
      released: [...req.released],
      inFlightReads: [...req.inFlight.entries()].map(([index, block]) => ({ index, block })),
    }));
    const readable = {};
    for (const req of this.requests.values()) {
      if (req.state === 'active') readable[req.id] = this.readableBlocks(req.id);
    }
    return {
      requests,
      blocks: this.blocks.map((b) => ({ ...b })),
      readable,
      safeReclaim: this.safeReclaimSet(),
    };
  }
}

module.exports = { BlockManager };
