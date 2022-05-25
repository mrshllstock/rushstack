// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { Import } from '@rushstack/node-core-library';
import { CommandLineFlagParameter, CommandLineStringParameter } from '@rushstack/ts-command-line';

import { BaseRushAction } from './BaseRushAction';
import { RushCommandLineParser } from '../RushCommandLineParser';

import type * as deployManagerTypes from '../../logic/deploy/DeployManager';
const deployManagerModule: typeof deployManagerTypes = Import.lazy(
  '../../logic/deploy/DeployManager',
  require
);

export class DeployAction extends BaseRushAction {
  private _scenario!: CommandLineStringParameter;
  private _project!: CommandLineStringParameter;
  private _overwrite!: CommandLineFlagParameter;
  private _targetFolder!: CommandLineStringParameter;
  private _createArchivePath!: CommandLineStringParameter;

  public constructor(parser: RushCommandLineParser) {
    super({
      actionName: 'deploy',
      summary:
        'Prepares a deployment by copying a subset of Rush projects and their dependencies' +
        ' to a target folder',
      documentation:
        'After building the repo, "rush deploy" can be used to prepare a deployment by copying' +
        ' a subset of Rush projects and their dependencies to a target folder, which can then be uploaded to' +
        ' a production server.  The "rush deploy" behavior is specified by a scenario config file that must' +
        ' be created first, using the "rush init-deploy" command.',
      parser,

      // It is okay to invoke multiple instances of "rush deploy" simultaneously, if they are writing
      // to different target folders.
      safeForSimultaneousRushProcesses: true
    });
  }

  protected onDefineParameters(): void {
    this._project = this.defineStringParameter({
      parameterLongName: '--project',
      parameterShortName: '-p',
      argumentName: 'PROJECT_NAME',
      description:
        'Specifies the name of the main Rush project to be deployed. It must appear in the' +
        ' "deploymentProjectNames" setting in the deployment config file.'
    });

    this._scenario = this.defineStringParameter({
      parameterLongName: '--scenario',
      parameterShortName: '-s',
      argumentName: 'SCENARIO_NAME',
      description:
        'By default, the deployment configuration is specified in "common/config/rush/deploy.json".' +
        ' You can use "--scenario" to specify an alternate name. The name must be lowercase and separated by dashes.' +
        ' For example, if SCENARIO_NAME is "web", then the config file would be "common/config/rush/deploy-web.json".'
    });

    this._overwrite = this.defineFlagParameter({
      parameterLongName: '--overwrite',
      description:
        'By default, deployment will fail if the target folder is not empty.  SPECIFYING THIS FLAG' +
        ' WILL RECURSIVELY DELETE EXISTING CONTENTS OF THE TARGET FOLDER.'
    });

    this._targetFolder = this.defineStringParameter({
      parameterLongName: '--target-folder',
      parameterShortName: '-t',
      argumentName: 'PATH',
      environmentVariable: 'RUSH_DEPLOY_TARGET_FOLDER',
      description:
        'By default, files are deployed to the "common/deploy" folder inside the Rush repo.' +
        ' Use this parameter to specify a different location. ' +
        ' WARNING: USE CAUTION WHEN COMBINING WITH "--overwrite"'
    });

    this._createArchivePath = this.defineStringParameter({
      parameterLongName: '--create-archive',
      argumentName: 'ARCHIVE_PATH',
      description:
        'If specified, after the deployment has been prepared, "rush deploy"' +
        ' will create an archive containing the contents of the target folder.' +
        ' The newly created archive file will be placed according to the designated path, relative' +
        ' to the target folder. Supported file extensions: .zip'
    });
  }

  protected async runAsync(): Promise<void> {
    const deployManager: deployManagerTypes.DeployManager = new deployManagerModule.DeployManager(
      this.rushConfiguration
    );
    await deployManager.deployAsync(
      this._project.value,
      this._scenario.value,
      !!this._overwrite.value,
      this._targetFolder.value,
      this._createArchivePath.value
    );
  }
}
