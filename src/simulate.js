'use strict';

const { BlockManager } = require('./block-manager');

function applyEvent(mgr, step, event) {
  switch (event.type) {
    case 'add_request':
      mgr.addRequest(step, event.request, event.blocks ?? []);
      break;
    case 'share':
      mgr.sharePrefix(step, event.request, event.from, event.count);
      break;
    case 'append':
      mgr.append(step, event.request, event.block);
      break;
    case 'begin_read':
      mgr.beginRead(step, event.request, event.index);
      break;
    case 'end_read':
      mgr.endRead(step, event.request, event.index);
      break;
    case 'write':
      mgr.write(step, event.request, event.index, event);
      break;
    case 'cancel':
      mgr.cancel(step, event.request);
      break;
    case 'finish':
      mgr.finish(step, event.request);
      break;
    case 'reclaim':
      mgr.reclaim(step, event.block);
      break;
    default:
      mgr._fail(step, 'unknown-event', `未知事件类型: ${event.type}`);
  }
}

/**
 * 运行场景：按顺序应用事件，计算每步的可读块与安全回收范围。
 * 返回 { steps, evidence, reclaimLog, final }。
 */
function runScenario(scenario) {
  const mgr = new BlockManager({ numBlocks: scenario.numBlocks ?? 8 });
  const steps = [];
  const events = scenario.events ?? [];
  events.forEach((event, index) => {
    const evidenceBefore = mgr.evidence.length;
    applyEvent(mgr, index, event);
    mgr.verifyConsistency(index);
    steps.push({
      step: index,
      event,
      evidence: mgr.evidence.slice(evidenceBefore),
      snapshot: mgr.snapshot(),
    });
  });
  return {
    steps,
    evidence: mgr.evidence,
    reclaimLog: mgr.reclaimLog,
    final: mgr.snapshot(),
  };
}

module.exports = { runScenario, applyEvent };
