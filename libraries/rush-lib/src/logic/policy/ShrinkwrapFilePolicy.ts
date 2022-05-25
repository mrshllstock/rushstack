// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as os from 'os';

import { RushConfiguration } from '../../api/RushConfiguration';
import { IPolicyValidatorOptions } from './PolicyValidator';
import { BaseShrinkwrapFile } from '../base/BaseShrinkwrapFile';
import { ShrinkwrapFileFactory } from '../ShrinkwrapFileFactory';
import { RepoStateFile } from '../RepoStateFile';

export interface IShrinkwrapFilePolicyValidatorOptions extends IPolicyValidatorOptions {
  repoState: RepoStateFile;
}

/**
 *  A policy that validates shrinkwrap files used by package managers.
 */
export class ShrinkwrapFilePolicy {
  public static validate(rushConfiguration: RushConfiguration, options: IPolicyValidatorOptions): void {
    console.log('Validating package manager shrinkwrap file.' + os.EOL);
    const shrinkwrapFile: BaseShrinkwrapFile | undefined = ShrinkwrapFileFactory.getShrinkwrapFile(
      rushConfiguration.packageManager,
      rushConfiguration.packageManagerOptions,
      rushConfiguration.getCommittedShrinkwrapFilename(options.shrinkwrapVariant)
    );

    if (!shrinkwrapFile) {
      console.log('Shrinkwrap file could not be found, skipping validation.' + os.EOL);
      return;
    }

    // Run shrinkwrap-specific validation
    shrinkwrapFile.validate(
      rushConfiguration.packageManagerOptions,
      {
        ...options,
        repoState: rushConfiguration.getRepoState(options.shrinkwrapVariant)
      },
      rushConfiguration.experimentsConfiguration.configuration
    );
  }
}
