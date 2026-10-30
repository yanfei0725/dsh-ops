/**
 * 引擎的根锚点。
 *
 * 引擎内置进宿主后，`src/ptc/engine/*`（编译后 `lib/ptc/engine/*`）距离包根都是三级，
 * 所以 `es.exe`、`vendor/deps` 这类随包分发物的候选链只需要一处 `..` 展开，不再各算各的。
 */
import * as path from 'node:path';

/** 包根：`src/ptc/engine`（或 `lib/ptc/engine`）上三级。 */
export const PACKAGE_ROOT = path.join(import.meta.dirname, '..', '..', '..');
