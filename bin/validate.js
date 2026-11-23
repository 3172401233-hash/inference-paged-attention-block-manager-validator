#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runScenario } = require('../src/simulate');

function formatEvent(event) {
  const { type, ...rest } = event;
  const args = Object.entries(rest)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');
  return args ? `${type} ${args}` : type;
}

function printReport(report) {
  for (const step of report.steps) {
    console.log(`\n[step ${step.step}] ${formatEvent(step.event)}`);
    const { snapshot } = step;
    for (const req of snapshot.requests) {
      const table = req.table.length ? req.table.join(' -> ') : '(空)';
      console.log(`  请求 ${req.id} [${req.state}] 逻辑块表: ${table}`);
    }
    for (const [reqId, entries] of Object.entries(snapshot.readable)) {
      const desc = entries.map((e) => `L${e.index}->P${e.block}${e.readable ? '' : '(不可读!)'}`).join(' ');
      console.log(`  可读块 ${reqId}: ${desc || '(无)'}`);
    }
    console.log(`  安全回收范围: [${snapshot.safeReclaim.join(', ')}]`);
    for (const ev of step.evidence) {
      console.log(`  !! 不一致 [${ev.code}] ${ev.message}`);
    }
  }

  console.log('\n===== 最终物理块状态 =====');
  for (const block of report.final.blocks) {
    console.log(
      `  P${block.id}: state=${block.state} refcount=${block.refcount} readers=${block.readers} content=${JSON.stringify(block.content)}`,
    );
  }
  console.log('\n===== 回收计划（已执行的安全回收） =====');
  console.log(report.reclaimLog.length ? report.reclaimLog.map((r) => `step ${r.step}: P${r.block}`).join('\n') : '  (无)');
  console.log('\n===== 不一致证据汇总 =====');
  if (!report.evidence.length) {
    console.log('  未发现不一致。');
  } else {
    for (const ev of report.evidence) {
      console.log(`  step ${ev.step} [${ev.code}] ${ev.message}`);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const fileArg = args.find((a) => !a.startsWith('--'));
  const file = fileArg ?? path.join(__dirname, '..', 'examples', 'scenario.json');
  const scenario = JSON.parse(fs.readFileSync(file, 'utf8'));
  const report = runScenario(scenario);
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`场景文件: ${file}`);
    printReport(report);
  }
  process.exitCode = report.evidence.length ? 1 : 0;
}

main();
