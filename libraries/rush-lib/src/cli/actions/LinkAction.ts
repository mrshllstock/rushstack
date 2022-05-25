// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { Import } from '@rushstack/node-core-library';
import { CommandLineFlagParameter } from '@rushstack/ts-command-line';

import { RushCommandLineParser } from '../RushCommandLineParser';

import { BaseLinkManager } from '../../logic/base/BaseLinkManager';
import { BaseRushAction } from './BaseRushAction';

import type * as LinkManagerFactoryTypes from '../../logic/LinkManagerFactory';
const linkManagerFactoryModule: typeof LinkManagerFactoryTypes = Import.lazy(
  '../../logic/LinkManagerFactory',
  require
);

export class LinkAction extends BaseRushAction {
  private _force!: CommandLineFlagParameter;

  public constructor(parser: RushCommandLineParser) {
    super({
      actionName: 'link',
      summary: 'Create node_modules symlinks for all projects',
      documentation:
        'Create node_modules symlinks for all projects.  This operation is normally performed' +
        ' automatically as part of "rush install" or "rush update".  You should only need to use "rush link"' +
        ' if you performed "rush unlink" for some reason, or if you specified the "--no-link" option' +
        ' for "rush install" or "rush update".',
      parser
    });
  }

  protected onDefineParameters(): void {
    this._force = this.defineFlagParameter({
      parameterLongName: '--force',
      parameterShortName: '-f',
      description:
        'Deletes and recreates all links, even if the filesystem state seems to indicate that this is ' +
        'unnecessary.'
    });
  }

  protected async runAsync(): Promise<void> {
    const linkManager: BaseLinkManager = linkManagerFactoryModule.LinkManagerFactory.getLinkManager(
      this.rushConfiguration
    );
    await linkManager.createSymlinksForProjects(this._force.value);
  }
}
