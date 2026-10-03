// Structured handoff to the model workflow, then an independently controlled host delivery.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { assertDeliveryConfiguration } from '../../check-runner/src/codex-delivery.js';

// Host-only preflight. Run before locks, queue reads or model calls; never create
// a missing vault root or resolve away a user-controlled directory symlink.
export function assertResearchStartup(config,repoRoot,{env=process.env,which=value=>Bun.which(value)}={}) {
  assertDeliveryConfiguration(config,repoRoot);
  for(const [key,fallback] of [['SEARCHX_CODEX_BIN','codex'],['SEARCHX_PYTHON_BIN','python3'],['SEARCHX_BUN_BIN','bun']]) {
    if(!which(env[key] || fallback))throw new Error(`执行器不可用：${key}`);
  }
  if(!existsSync(join(config.stocksRoot,'venv/bin/python')) || !existsSync(join(config.stocksRoot,'scripts/query_for_agent.py'))) {
    throw new Error('SEARCHX_STOCKS_ROOT 白名单查询器不完整');
  }
}

const errorCode=error=>typeof error?.code==='string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(error.code) ? error.code : 'DELIVERY_ERROR';

export async function runCodexResearch(context,config,deps={}) {
  const {repoRoot=process.cwd(),env=process.env,onChild=()=>{},isCancelled=()=>false,log=()=>{}}=deps;
  let workflowStatus=null;
  try {
    if (isCancelled()) return false;
    if (!context || !Number.isSafeInteger(context.issue?.number) || context.issue.number<1) {
      throw new Error('缺少可信 Issue 编号');
    }
    const runWorkflow=deps.runWorkflow || (await import('../../codex-runtime/adapter.js')).runWorkflow;
    const deliverResearch=deps.deliverResearch || (await import('./codex-delivery.js')).deliverResearch;
    const run=await runWorkflow({taskId:`issue-${context.issue.number}`,kind:'auto',
      request:{topic:context.topic,focus:context.focus},inputs:[],repoRoot,
      stateRoot:config.codexStateRoot,timeoutMs:config.claudeTimeoutMs,
      env:{...env,SEARCHX_CODEX_MODEL:config.model,SEARCHX_CODEX_EFFORT:config.reasoningEffort,
        SEARCHX_STOCKS_ROOT:config.stocksRoot},onChild,log});
    if (isCancelled()) return false;
    if (!run || !['isolated_reviewed','parked'].includes(run.status)) throw new Error('Codex 未完成独立核验');
    workflowStatus=run.status;
    const delivery=await deliverResearch({repoRoot,run,vaultRoot:config.obsidianVault,
      topic:context.topic,issueNumber:context.issue.number,env,onChild,isCancelled,log});
    // A parked result has a separate signal consumed by runOnce before its success branch.
    if(delivery?.published===true || delivery?.parked===true)return true;
    throw Object.assign(new Error('宿主交付未完成'),{code:'DELIVERY_INCOMPLETE'});
  } catch (error) {
    if(workflowStatus!==null) {
      const code=errorCode(error);
      log(`Codex 交付延期（${code}），已核验检查点保留，后续只重试交付，未报完成`);
      return {status:'delivery_deferred',workflow_status:workflowStatus,error_code:code};
    }
    log(`Codex 研究或交付失败（${error?.code || error?.name || 'Error'}），保留本任务检查点，未报完成`);
    return false;
  }
}
