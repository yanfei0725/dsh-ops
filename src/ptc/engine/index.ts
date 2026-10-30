export {
    PtcOutcomeError,
    defaultConfig,
    dbg,
    detectEol,
    esCandidates,
    normalizeEol,
    parseLooseJson,
    pickBin,
    readRange,
    run,
    stripBom,
    toLines,
} from './proc.js';
export type { PtcConfig, PtcErrorCode, Stage } from './proc.js';

export {
    agentBoxApply,
    agentBoxRestore,
    applyEditsInMemory,
    astGrepRewrite,
    difftasticAudit,
    everythingFind,
    langOf,
    saneLocate,
} from './stages.js';
export type { AgentBoxResult, AuditResult, Edit, EverythingQuery, RewriteOpts, SymbolSlice } from './stages.js';

export { resolveTools, runRefactorPipeline } from './pipeline.js';
export type { PtcOutcome, RefactorRequest } from './pipeline.js';

export {
    enumerate,
    inprocLocate,
    inprocRefactor,
    runInprocCli,
} from './inproc.js';
export type {
    EnumerateResult,
    InprocOutcome,
    InprocRequest,
    LocateHit,
    LocateInfo,
    LocateOutcome,
    LocateRequest,
    LocateStrategy,
} from './inproc.js';

export { auditAst, sgCrossCheck, spliceExpect } from './astdiff.js';
export type { AstAudit, AstSpan, SgCrossCheck } from './astdiff.js';

export { opsPtcAddition, opsPtcDiscoveryEntry } from './tools.js';
export type { PtcToolAddition, PtcToolDef } from './tools.js';
export { default } from './tools.js';
