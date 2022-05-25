// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import colors from 'colors/safe';
import * as semver from 'semver';

import { RushConfiguration } from '../api/RushConfiguration';
import { BaseInstallManager, IInstallManagerOptions } from './base/BaseInstallManager';
import { InstallManagerFactory } from './InstallManagerFactory';
import { VersionMismatchFinder } from './versionMismatch/VersionMismatchFinder';
import { PurgeManager } from './PurgeManager';
import { Utilities } from '../utilities/Utilities';
import { DependencyType, PackageJsonDependency } from '../api/PackageJsonEditor';
import { RushGlobalFolder } from '../api/RushGlobalFolder';
import { RushConfigurationProject } from '../api/RushConfigurationProject';
import { VersionMismatchFinderEntity } from './versionMismatch/VersionMismatchFinderEntity';
import { VersionMismatchFinderProject } from './versionMismatch/VersionMismatchFinderProject';
import { RushConstants } from './RushConstants';
import { InstallHelpers } from './installManager/InstallHelpers';
import { CommonVersionsConfiguration } from '../api/CommonVersionsConfiguration';

/**
 * The type of SemVer range specifier that is prepended to the version
 */
export const enum SemVerStyle {
  Exact = 'exact',
  Caret = 'caret',
  Tilde = 'tilde',
  Passthrough = 'passthrough'
}

export interface IRushAddPackage {
  packageName: string;

  /**
   * The style of range that should be used if the version is automatically detected.
   */
  rangeStyle: SemVerStyle;

  /**
   * If not undefined, the latest version will be used (that doesn't break ensureConsistentVersions).
   * If specified, the latest version meeting the SemVer specifier will be used as the basis.
   */
  version?: string;
}

/**
 * Options for adding a dependency to a particular project.
 */
export interface IPackageJsonUpdaterRushAddOptions {
  /**
   * The projects whose package.jsons should get updated
   */
  projects: RushConfigurationProject[];
  /**
   * The dependencies to be added.
   */
  packagesToAdd: IRushAddPackage[];
  /**
   * Whether or not this dependency should be added as a devDependency or a regular dependency.
   */
  devDependency: boolean;
  /**
   * If specified, other packages that use this dependency will also have their package.json's updated.
   */
  updateOtherPackages: boolean;
  /**
   * If specified, "rush update" will not be run after updating the package.json file(s).
   */
  skipUpdate: boolean;
  /**
   * If specified, "rush update" will be run in debug mode.
   */
  debugInstall: boolean;
  /**
   * The variant to consider when performing installations and validating shrinkwrap updates.
   */
  variant?: string | undefined;
}

/**
 * Configuration options for adding or updating a dependency in a single project
 */
export interface IUpdateProjectOptions {
  /**
   * The project which will have its package.json updated
   */
  project: VersionMismatchFinderEntity;
  /**
   * Map of packages to update
   * Its key is the name of the dependency to be added or updated in the project
   * Its value is the new SemVer specifier that should be added to the project's package.json
   */
  dependenciesToAddOrUpdate: Record<string, string>;
  /**
   * The type of dependency that should be updated. If left empty, this will be auto-detected.
   * If it cannot be auto-detected an exception will be thrown.
   */
  dependencyType?: DependencyType;
}

/**
 * A helper class for managing the dependencies of various package.json files.
 * @internal
 */
export class PackageJsonUpdater {
  private _rushConfiguration: RushConfiguration;
  private _rushGlobalFolder: RushGlobalFolder;

  public constructor(rushConfiguration: RushConfiguration, rushGlobalFolder: RushGlobalFolder) {
    this._rushConfiguration = rushConfiguration;
    this._rushGlobalFolder = rushGlobalFolder;
  }

  /**
   * Adds a dependency to a particular project. The core business logic for "rush add".
   */
  public async doRushAdd(options: IPackageJsonUpdaterRushAddOptions): Promise<void> {
    const { projects, packagesToAdd, devDependency, updateOtherPackages, skipUpdate, debugInstall, variant } =
      options;

    const allDependencyVersions: Map<string, Set<string>> = this._rushConfiguration._getAllDependencyVersions(
      variant
    );

    console.log();
    const commonVersions: CommonVersionsConfiguration = this._rushConfiguration.getCommonVersions(variant);
    const dependenciesToAddOrUpdate: Record<string, string> = {};
    for (const { packageName, version: initialVersion, rangeStyle } of packagesToAdd) {
      const existingSpecifiedVersions: Set<string> | undefined = allDependencyVersions.get(packageName);
      let implicitlyPreferredVersion: string | undefined;
      if (existingSpecifiedVersions?.size === 1) {
        implicitlyPreferredVersion = existingSpecifiedVersions.values().next().value;
      }

      const explicitlyPreferredVersion: string | undefined =
        commonVersions.preferredVersions.get(packageName);

      const version: string = await this._getNormalizedVersionSpec(
        projects,
        packageName,
        initialVersion,
        implicitlyPreferredVersion,
        explicitlyPreferredVersion,
        rangeStyle
      );

      dependenciesToAddOrUpdate[packageName] = version;
      console.log(colors.green(`Updating projects to use `) + packageName + '@' + colors.cyan(version));
      console.log();

      if (
        existingSpecifiedVersions &&
        !existingSpecifiedVersions.has(version) &&
        this._rushConfiguration.ensureConsistentVersions &&
        !updateOtherPackages
      ) {
        // There are existing versions, and the version we're going to use is not one of them, and this repo
        // requires consistent versions, and we aren't going to update other packages, so we can't proceed.

        const existingVersionList: string = Array.from(existingSpecifiedVersions).join(', ');
        throw new Error(
          `Adding '${packageName}@${version}' ` +
            `causes mismatched dependencies. Use the "--make-consistent" flag to update other packages to use ` +
            `this version, or try specify one of the existing versions (${existingVersionList}).`
        );
      }
    }

    const allPackageUpdates: IUpdateProjectOptions[] = [];

    for (const project of projects) {
      const currentProjectUpdate: IUpdateProjectOptions = {
        project: new VersionMismatchFinderProject(project),
        dependenciesToAddOrUpdate: dependenciesToAddOrUpdate,
        dependencyType: devDependency ? DependencyType.Dev : undefined
      };
      this.updateProject(currentProjectUpdate);

      const otherPackageUpdates: IUpdateProjectOptions[] = [];

      if (this._rushConfiguration.ensureConsistentVersions || updateOtherPackages) {
        // we need to do a mismatch check
        const mismatchFinder: VersionMismatchFinder = VersionMismatchFinder.getMismatches(
          this._rushConfiguration,
          {
            variant: variant
          }
        );

        const mismatches: string[] = mismatchFinder.getMismatches().filter((mismatch) => {
          return !projects.find((proj) => proj.packageName === mismatch);
        });
        if (mismatches.length && updateOtherPackages) {
          for (const [packageName, version] of Object.entries(dependenciesToAddOrUpdate)) {
            const mismatchedVersions: string[] | undefined =
              mismatchFinder.getVersionsOfMismatch(packageName);
            if (mismatchedVersions) {
              for (const mismatchedVersion of mismatchedVersions) {
                for (const consumer of mismatchFinder.getConsumersOfMismatch(
                  packageName,
                  mismatchedVersion
                )!) {
                  if (consumer instanceof VersionMismatchFinderProject) {
                    otherPackageUpdates.push({
                      project: consumer,
                      dependenciesToAddOrUpdate: {
                        [packageName]: version
                      }
                    });
                  }
                }
              }
            }
          }
        }
      }

      this.updateProjects(otherPackageUpdates);

      allPackageUpdates.push(currentProjectUpdate, ...otherPackageUpdates);
    }

    for (const { project } of allPackageUpdates) {
      if (project.saveIfModified()) {
        console.log(colors.green('Wrote ') + project.filePath);
      }
    }

    if (!skipUpdate) {
      console.log();
      console.log(colors.green('Running "rush update"'));
      console.log();

      const purgeManager: PurgeManager = new PurgeManager(this._rushConfiguration, this._rushGlobalFolder);
      const installManagerOptions: IInstallManagerOptions = {
        debug: debugInstall,
        allowShrinkwrapUpdates: true,
        bypassPolicy: false,
        noLink: false,
        fullUpgrade: false,
        recheckShrinkwrap: false,
        networkConcurrency: undefined,
        collectLogFile: false,
        variant: variant,
        maxInstallAttempts: RushConstants.defaultMaxInstallAttempts,
        pnpmFilterArguments: [],
        checkOnly: false
      };

      const installManager: BaseInstallManager = InstallManagerFactory.getInstallManager(
        this._rushConfiguration,
        this._rushGlobalFolder,
        purgeManager,
        installManagerOptions
      );
      try {
        await installManager.doInstallAsync();
      } finally {
        purgeManager.deleteAll();
      }
    }
  }

  /**
   * Updates several projects' package.json files
   */
  public updateProjects(projectUpdates: IUpdateProjectOptions[]): void {
    for (const update of projectUpdates) {
      this.updateProject(update);
    }
  }

  /**
   * Updates a single project's package.json file
   */
  public updateProject(options: IUpdateProjectOptions): void {
    let { dependencyType } = options;
    const { project, dependenciesToAddOrUpdate } = options;

    for (const [packageName, newVersion] of Object.entries(dependenciesToAddOrUpdate)) {
      const oldDependency: PackageJsonDependency | undefined = project.tryGetDependency(packageName);
      const oldDevDependency: PackageJsonDependency | undefined = project.tryGetDevDependency(packageName);

      const oldDependencyType: DependencyType | undefined = oldDevDependency
        ? oldDevDependency.dependencyType
        : oldDependency
        ? oldDependency.dependencyType
        : undefined;

      dependencyType = dependencyType || oldDependencyType || DependencyType.Regular;

      project.addOrUpdateDependency(packageName, newVersion, dependencyType!);
    }
  }

  /**
   * Selects an appropriate version number for a particular package, given an optional initial SemVer spec.
   * If ensureConsistentVersions, tries to pick a version that will be consistent.
   * Otherwise, will choose the latest semver matching the initialSpec and append the proper range style.
   * @param projects - the projects which will have their package.json's updated
   * @param packageName - the name of the package to be used
   * @param initialSpec - a semver pattern that should be used to find the latest version matching the spec
   * @param implicitlyPreferredVersion - the implicitly preferred (aka common/primary) version of the package in use
   * @param rangeStyle - if this version is selected by querying registry, then this range specifier is prepended to
   *   the selected version.
   */
  private async _getNormalizedVersionSpec(
    projects: RushConfigurationProject[],
    packageName: string,
    initialSpec: string | undefined,
    implicitlyPreferredVersion: string | undefined,
    explicitlyPreferredVersion: string | undefined,
    rangeStyle: SemVerStyle
  ): Promise<string> {
    console.log(colors.gray(`Determining new version for dependency: ${packageName}`));
    if (initialSpec) {
      console.log(`Specified version selector: ${colors.cyan(initialSpec)}`);
    } else {
      console.log(`No version selector was specified, so the version will be determined automatically.`);
    }
    console.log();

    // if ensureConsistentVersions => reuse the pinned version
    // else, query the registry and use the latest that satisfies semver spec
    if (initialSpec) {
      if (initialSpec === implicitlyPreferredVersion) {
        console.log(
          colors.green('Assigning "') +
            colors.cyan(initialSpec) +
            colors.green(
              `" for "${packageName}" because it matches what other projects are using in this repo.`
            )
        );
        return initialSpec;
      }

      if (initialSpec === explicitlyPreferredVersion) {
        console.log(
          colors.green('Assigning "') +
            colors.cyan(initialSpec) +
            colors.green(
              `" for "${packageName}" because it is the preferred version listed in ${RushConstants.commonVersionsFilename}.`
            )
        );
        return initialSpec;
      }
    }

    if (this._rushConfiguration.ensureConsistentVersions && !initialSpec) {
      if (implicitlyPreferredVersion) {
        console.log(
          `Assigning the version "${colors.cyan(implicitlyPreferredVersion)}" for "${packageName}" ` +
            'because it is already used by other projects in this repo.'
        );
        return implicitlyPreferredVersion;
      }

      if (explicitlyPreferredVersion) {
        console.log(
          `Assigning the version "${colors.cyan(explicitlyPreferredVersion)}" for "${packageName}" ` +
            `because it is the preferred version listed in ${RushConstants.commonVersionsFilename}.`
        );
        return explicitlyPreferredVersion;
      }
    }

    await InstallHelpers.ensureLocalPackageManager(
      this._rushConfiguration,
      this._rushGlobalFolder,
      RushConstants.defaultMaxInstallAttempts
    );

    const useWorkspaces: boolean = !!(
      this._rushConfiguration.pnpmOptions && this._rushConfiguration.pnpmOptions.useWorkspaces
    );
    const workspacePrefix: string = 'workspace:';

    // Trim 'workspace:' notation from the spec, since we're going to be tweaking the range
    if (useWorkspaces && initialSpec && initialSpec.startsWith(workspacePrefix)) {
      initialSpec = initialSpec.substring(workspacePrefix.length).trim();
    }

    // determine if the package is a project in the local repository and if the version exists
    const localProject: RushConfigurationProject | undefined = this._tryGetLocalProject(
      packageName,
      projects
    );

    let selectedVersion: string | undefined;
    let selectedVersionPrefix: string = '';

    if (initialSpec && initialSpec !== 'latest') {
      console.log(colors.gray('Finding versions that satisfy the selector: ') + initialSpec);
      console.log();

      if (localProject !== undefined) {
        const version: string = localProject.packageJson.version;
        if (semver.satisfies(version, initialSpec)) {
          // For workspaces, assume that specifying the exact version means you always want to consume
          // the local project. Otherwise, use the exact local package version
          if (useWorkspaces) {
            selectedVersion = initialSpec === version ? '*' : initialSpec;
            selectedVersionPrefix = workspacePrefix;
          } else {
            selectedVersion = version;
          }
        } else {
          throw new Error(
            `The dependency being added ("${packageName}") is a project in the local Rush repository, ` +
              `but the version specifier provided (${initialSpec}) does not match the local project's version ` +
              `(${version}). Correct the version specifier, omit a version specifier, or include "${packageName}" as a ` +
              `cyclicDependencyProject if it is intended for "${packageName}" to come from an external feed and not ` +
              'from the local Rush repository.'
          );
        }
      } else {
        console.log(`Querying registry for all versions of "${packageName}"...`);

        let commandArgs: string[];
        if (this._rushConfiguration.packageManager === 'yarn') {
          commandArgs = ['info', packageName, 'versions', '--json'];
        } else {
          commandArgs = ['view', packageName, 'versions', '--json'];
        }

        const allVersions: string = Utilities.executeCommandAndCaptureOutput(
          this._rushConfiguration.packageManagerToolFilename,
          commandArgs,
          this._rushConfiguration.commonTempFolder
        );

        let versionList: string[];
        if (this._rushConfiguration.packageManager === 'yarn') {
          versionList = JSON.parse(allVersions).data;
        } else {
          versionList = JSON.parse(allVersions);
        }

        console.log(colors.gray(`Found ${versionList.length} available versions.`));

        for (const version of versionList) {
          if (semver.satisfies(version, initialSpec)) {
            selectedVersion = initialSpec;
            console.log(`Found a version that satisfies ${initialSpec}: ${colors.cyan(version)}`);
            break;
          }
        }

        if (!selectedVersion) {
          throw new Error(
            `Unable to find a version of "${packageName}" that satisfies` +
              ` the version specifier "${initialSpec}"`
          );
        }
      }
    } else {
      if (localProject !== undefined) {
        // For workspaces, assume that no specified version range means you always want to consume
        // the local project. Otherwise, use the exact local package version
        if (useWorkspaces) {
          selectedVersion = '*';
          selectedVersionPrefix = workspacePrefix;
        } else {
          selectedVersion = localProject.packageJson.version;
        }
      } else {
        if (!this._rushConfiguration.ensureConsistentVersions) {
          console.log(
            colors.gray(
              `The "ensureConsistentVersions" policy is NOT active, so we will assign the latest version.`
            )
          );
          console.log();
        }

        console.log(`Querying NPM registry for latest version of "${packageName}"...`);

        let commandArgs: string[];
        if (this._rushConfiguration.packageManager === 'yarn') {
          commandArgs = ['info', packageName, 'dist-tags.latest', '--silent'];
        } else {
          commandArgs = ['view', `${packageName}@latest`, 'version'];
        }

        selectedVersion = Utilities.executeCommandAndCaptureOutput(
          this._rushConfiguration.packageManagerToolFilename,
          commandArgs,
          this._rushConfiguration.commonTempFolder
        ).trim();
      }

      console.log();

      console.log(`Found latest version: ${colors.cyan(selectedVersion)}`);
    }

    console.log();

    let reasonForModification: string = '';
    if (selectedVersion !== '*') {
      switch (rangeStyle) {
        case SemVerStyle.Caret: {
          selectedVersionPrefix += '^';
          reasonForModification = ' because the "--caret" flag was specified';
          break;
        }

        case SemVerStyle.Exact: {
          reasonForModification = ' because the "--exact" flag was specified';
          break;
        }

        case SemVerStyle.Tilde: {
          selectedVersionPrefix += '~';
          break;
        }

        case SemVerStyle.Passthrough: {
          break;
        }

        default: {
          throw new Error(`Unexpected SemVerStyle ${rangeStyle}.`);
        }
      }
    }

    const normalizedVersion: string = selectedVersionPrefix + selectedVersion;
    console.log(
      colors.gray(`Assigning version "${normalizedVersion}" for "${packageName}"${reasonForModification}.`)
    );
    return normalizedVersion;
  }

  private _collectAllDownstreamDependencies(
    project: RushConfigurationProject
  ): Set<RushConfigurationProject> {
    const allProjectDownstreamDependencies: Set<RushConfigurationProject> =
      new Set<RushConfigurationProject>();

    const collectDependencies: (rushProject: RushConfigurationProject) => void = (
      rushProject: RushConfigurationProject
    ) => {
      for (const downstreamDependencyProject of rushProject.downstreamDependencyProjects) {
        const foundProject: RushConfigurationProject | undefined =
          this._rushConfiguration.projectsByName.get(downstreamDependencyProject);

        if (!foundProject) {
          continue;
        }

        if (foundProject.cyclicDependencyProjects.has(rushProject.packageName)) {
          continue;
        }

        if (!allProjectDownstreamDependencies.has(foundProject)) {
          allProjectDownstreamDependencies.add(foundProject);
          collectDependencies(foundProject);
        }
      }
    };

    collectDependencies(project);
    return allProjectDownstreamDependencies;
  }

  /**
   * Given a package name, this function returns a {@see RushConfigurationProject} if the package is a project
   * in the local Rush repo and is not marked as cyclic for any of the projects.
   *
   * @remarks
   * This function throws an error if adding the discovered local project as a dependency
   * would create a dependency cycle, or if it would be added to multiple projects.
   */
  private _tryGetLocalProject(
    packageName: string,
    projects: RushConfigurationProject[]
  ): RushConfigurationProject | undefined {
    const foundProject: RushConfigurationProject | undefined =
      this._rushConfiguration.projectsByName.get(packageName);

    if (foundProject === undefined) {
      return undefined;
    }

    if (projects.length > 1) {
      throw new Error(
        `"rush add" does not support adding a local project as a dependency to multiple projects at once.`
      );
    }

    const project: RushConfigurationProject = projects[0];

    if (project.cyclicDependencyProjects.has(foundProject.packageName)) {
      return undefined;
    }

    // Are we attempting to add this project to itself?
    if (project === foundProject) {
      throw new Error(
        'Unable to add a project as a dependency of itself unless the dependency is listed as a cyclic dependency ' +
          `in rush.json. This command attempted to add "${foundProject.packageName}" as a dependency of itself.`
      );
    }

    // Are we attempting to create a cycle?
    const downstreamDependencies: Set<RushConfigurationProject> =
      this._collectAllDownstreamDependencies(project);
    if (downstreamDependencies.has(foundProject)) {
      throw new Error(
        `Adding "${foundProject.packageName}" as a direct or indirect dependency of ` +
          `"${project.packageName}" would create a dependency cycle.`
      );
    }

    return foundProject;
  }
}
