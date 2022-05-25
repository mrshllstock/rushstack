// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { Import } from '@rushstack/node-core-library';
import { BaseInstallManager, IInstallManagerOptions } from './base/BaseInstallManager';
import { WorkspaceInstallManager } from './installManager/WorkspaceInstallManager';
import { PurgeManager } from './PurgeManager';
import { RushConfiguration } from '../api/RushConfiguration';
import { RushGlobalFolder } from '../api/RushGlobalFolder';

const rushInstallManagerModule: typeof import('./installManager/RushInstallManager') = Import.lazy(
  './installManager/RushInstallManager',
  require
);

export class InstallManagerFactory {
  public static getInstallManager(
    rushConfiguration: RushConfiguration,
    rushGlobalFolder: RushGlobalFolder,
    purgeManager: PurgeManager,
    options: IInstallManagerOptions
  ): BaseInstallManager {
    if (
      rushConfiguration.packageManager === 'pnpm' &&
      rushConfiguration.pnpmOptions &&
      rushConfiguration.pnpmOptions.useWorkspaces
    ) {
      return new WorkspaceInstallManager(rushConfiguration, rushGlobalFolder, purgeManager, options);
    }

    return new rushInstallManagerModule.RushInstallManager(
      rushConfiguration,
      rushGlobalFolder,
      purgeManager,
      options
    );
  }
}
