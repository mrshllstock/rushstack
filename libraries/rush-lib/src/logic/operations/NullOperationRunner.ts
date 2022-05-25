// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { OperationStatus } from './OperationStatus';
import type { IOperationRunner, IOperationRunnerContext } from './IOperationRunner';

/**
 *
 */
export interface INullOperationRunnerParams {
  /**
   * The name to report in logs.
   */
  name: string;
  /**
   * The result to report from the runner.
   */
  result: OperationStatus;
  /**
   * If true, the operation will not log anything or be tracked in statistics.
   */
  silent: boolean;
}

/**
 * Implementation of `IOperationRunner` for operations that require no work, such as empty scripts,
 * skipped operations, or blocked operations.
 */
export class NullOperationRunner implements IOperationRunner {
  public readonly name: string;
  // This operation does nothing, so timing is meaningless
  public readonly reportTiming: boolean = false;
  public readonly silent: boolean;
  // The operation may be skipped; it doesn't do anything anyway
  public isSkipAllowed: boolean = true;
  // The operation is a no-op, so is cacheable.
  public isCacheWriteAllowed: boolean = true;
  // Nothing will get logged, no point allowing warnings
  public readonly warningsAreAllowed: boolean = false;

  public readonly result: OperationStatus;

  public constructor({ name, result, silent }: INullOperationRunnerParams) {
    this.name = name;
    this.result = result;
    this.silent = silent;
  }

  public async executeAsync(context: IOperationRunnerContext): Promise<OperationStatus> {
    return this.result;
  }
}
