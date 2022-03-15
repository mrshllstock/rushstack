// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import { JsonFile, JsonSchema, FileSystem } from '@rushstack/node-core-library';
import type { CommandLineParameter } from '@rushstack/ts-command-line';

import { RushConstants } from '../logic/RushConstants';
import type {
  CommandJson,
  ICommandLineJson,
  IBulkCommandJson,
  IGlobalCommandJson,
  IFlagParameterJson,
  IChoiceParameterJson,
  IStringParameterJson,
  IPhasedCommandWithoutPhasesJson
} from './CommandLineJson';

export interface IShellCommandTokenContext {
  packageFolder: string;
}

/**
 * Metadata about a phase.
 * @alpha
 */
export interface IPhase {
  /**
   * The name of this phase.
   */
  name: string;

  /**
   * If set to "true," this this phase was generated from a bulk command, and
   * was not explicitly defined in the command-line.json file.
   */
  isSynthetic: boolean;

  /**
   * This property is used in the name of the filename for the logs generated by this
   * phase. This is a filesystem-safe version of the phase name. For example,
   * a phase with name "_phase:compile" has a `logFilenameIdentifier` of "_phase_compile".
   */
  logFilenameIdentifier: string;

  /**
   * The set of custom command line parameters that are relevant to this phase.
   */
  associatedParameters: Set<CommandLineParameter>;

  /**
   * The resolved dependencies of the phase
   */
  dependencies: {
    self: Set<IPhase>;
    upstream: Set<IPhase>;
  };

  /**
   * Normally Rush requires that each project's package.json has a \"scripts\" entry matching the phase name. To disable this check, set \"ignoreMissingScript\" to true.
   */
  ignoreMissingScript: boolean;

  /**
   * By default, Rush returns a nonzero exit code if errors or warnings occur during a command. If this option is set to \"true\", Rush will return a zero exit code if warnings occur during the execution of this phase.
   */
  allowWarningsOnSuccess: boolean;
}

export interface ICommandWithParameters {
  associatedParameters: Set<IParameterJson>;
}

export interface IPhasedCommandConfig extends IPhasedCommandWithoutPhasesJson, ICommandWithParameters {
  /**
   * If set to "true," then this phased command was generated from a bulk command, and
   * was not explicitly defined in the command-line.json file.
   */
  isSynthetic: boolean;
  disableBuildCache?: boolean;

  phases: Set<IPhase>;

  /**
   * If set to "true," this phased command will alwasy run in watch mode, regardless of CLI flags.
   */
  alwaysWatch: boolean;
  /**
   * The set of phases to execute when running this phased command in watch mode.
   */
  watchPhases: Set<IPhase>;
}

export interface IGlobalCommandConfig extends IGlobalCommandJson, ICommandWithParameters {}

export type Command = IGlobalCommandConfig | IPhasedCommandConfig;

/**
 * Metadata about a custom parameter defined in command-line.json
 * @alpha
 */
export type IParameterJson = IFlagParameterJson | IChoiceParameterJson | IStringParameterJson;

const DEFAULT_BUILD_COMMAND_JSON: IBulkCommandJson = {
  commandKind: RushConstants.bulkCommandKind,
  name: RushConstants.buildCommandName,
  summary: "Build all projects that haven't been built, or have changed since they were last built.",
  description:
    'This command is similar to "rush rebuild", except that "rush build" performs' +
    ' an incremental build. In other words, it only builds projects whose source files have changed' +
    ' since the last successful build. The analysis requires a Git working tree, and only considers' +
    ' source files that are tracked by Git and whose path is under the project folder. (For more details' +
    ' about this algorithm, see the documentation for the "package-deps-hash" NPM package.) The incremental' +
    ' build state is tracked in a per-project folder called ".rush/temp" which should NOT be added to Git. The' +
    ' build command is tracked by the "arguments" field in the "package-deps_build.json" file contained' +
    ' therein; a full rebuild is forced whenever the command has changed (e.g. "--production" or not).',
  safeForSimultaneousRushProcesses: false,
  enableParallelism: true,
  incremental: true
};

const DEFAULT_REBUILD_COMMAND_JSON: IBulkCommandJson = {
  commandKind: RushConstants.bulkCommandKind,
  name: RushConstants.rebuildCommandName,
  summary: 'Clean and rebuild the entire set of projects.',
  description:
    'This command assumes that the package.json file for each project contains' +
    ' a "scripts" entry for "npm run build" that performs a full clean build.' +
    ' Rush invokes this script to build each project that is registered in rush.json.' +
    ' Projects are built in parallel where possible, but always respecting the dependency' +
    ' graph for locally linked projects.  The number of simultaneous processes will be' +
    ' based on the number of machine cores unless overridden by the --parallelism flag.' +
    ' (For an incremental build, see "rush build" instead of "rush rebuild".)',
  safeForSimultaneousRushProcesses: false,
  enableParallelism: true,
  incremental: false
};

interface ICommandLineConfigurationOptions {
  /**
   * If true, do not include default build and rebuild commands.
   */
  doNotIncludeDefaultBuildCommands?: boolean;
}

/**
 * Custom Commands and Options for the Rush Command Line
 */
export class CommandLineConfiguration {
  private static _jsonSchema: JsonSchema = JsonSchema.fromFile(
    path.join(__dirname, '../schemas/command-line.schema.json')
  );

  public readonly commands: Map<string, Command> = new Map();
  public readonly phases: Map<string, IPhase> = new Map();
  public readonly parameters: IParameterJson[] = [];

  /**
   * shellCommand from plugin custom command line configuration needs to be expanded with tokens
   */
  public shellCommandTokenContext: IShellCommandTokenContext | undefined;

  /**
   * These path will be prepended to the PATH environment variable
   */
  private readonly _additionalPathFolders: string[] = [];

  /**
   * A map of bulk command names to their corresponding synthetic phase identifiers
   */
  private readonly _syntheticPhasesByTranslatedBulkCommandName: Map<string, IPhase> = new Map();

  /**
   * Use CommandLineConfiguration.loadFromFile()
   *
   * @internal
   */
  public constructor(
    commandLineJson: ICommandLineJson | undefined,
    options: ICommandLineConfigurationOptions = {}
  ) {
    const phasesJson: ICommandLineJson['phases'] = commandLineJson?.phases;
    if (phasesJson) {
      const phaseNameRegexp: RegExp = new RegExp(
        `^${RushConstants.phaseNamePrefix}[a-z][a-z0-9]*([-][a-z0-9]+)*$`
      );
      for (const phase of phasesJson) {
        if (this.phases.has(phase.name)) {
          throw new Error(
            `In ${RushConstants.commandLineFilename}, the phase "${phase.name}" is specified ` +
              'more than once.'
          );
        }

        if (!phase.name.match(phaseNameRegexp)) {
          throw new Error(
            `In ${RushConstants.commandLineFilename}, the phase "${phase.name}"'s name ` +
              'is not a valid phase name. Phase names must begin with the ' +
              `required prefix "${RushConstants.phaseNamePrefix}" followed by a name containing ` +
              'lowercase letters, numbers, or hyphens. The name must start with a letter and ' +
              'must not end with a hyphen.'
          );
        }

        // This is a completely fresh object. Avoid use of the `...` operator in its construction
        // to guarantee monomorphism.
        const processedPhase: IPhase = {
          name: phase.name,
          isSynthetic: false,
          logFilenameIdentifier: this._normalizeNameForLogFilenameIdentifiers(phase.name),
          associatedParameters: new Set(),
          dependencies: {
            self: new Set(),
            upstream: new Set()
          },
          ignoreMissingScript: !!phase.ignoreMissingScript,
          allowWarningsOnSuccess: !!phase.allowWarningsOnSuccess
        };

        this.phases.set(phase.name, processedPhase);
      }

      // Resolve phase names to the underlying objects
      for (const rawPhase of phasesJson) {
        // The named phase not existing was already handled in the loop above
        const phase: IPhase = this.phases.get(rawPhase.name)!;

        const selfDependencies: string[] | undefined = rawPhase.dependencies?.self;
        const upstreamDependencies: string[] | undefined = rawPhase.dependencies?.upstream;

        if (selfDependencies) {
          for (const dependencyName of selfDependencies) {
            const dependency: IPhase | undefined = this.phases.get(dependencyName);
            if (!dependency) {
              throw new Error(
                `In ${RushConstants.commandLineFilename}, in the phase "${phase.name}", the self ` +
                  `dependency phase "${dependencyName}" does not exist.`
              );
            }
            phase.dependencies.self.add(dependency);
          }
        }

        if (upstreamDependencies) {
          for (const dependencyName of upstreamDependencies) {
            const dependency: IPhase | undefined = this.phases.get(dependencyName);
            if (!dependency) {
              throw new Error(
                `In ${RushConstants.commandLineFilename}, in the phase "${phase.name}", ` +
                  `the upstream dependency phase "${dependencyName}" does not exist.`
              );
            }
            phase.dependencies.upstream.add(dependency);
          }
        }
      }

      // Do the recursive stuff after the dependencies have been converted
      const safePhases: Set<IPhase> = new Set();
      const cycleDetector: Set<IPhase> = new Set();
      for (const phase of this.phases.values()) {
        this._checkForPhaseSelfCycles(phase, cycleDetector, safePhases);
      }
    }

    const commandsJson: ICommandLineJson['commands'] = commandLineJson?.commands;
    let buildCommandPhases: IPhasedCommandConfig['phases'] | undefined;
    if (commandsJson) {
      for (const command of commandsJson) {
        if (this.commands.has(command.name)) {
          throw new Error(
            `In ${RushConstants.commandLineFilename}, the command "${command.name}" is specified ` +
              'more than once.'
          );
        }

        let normalizedCommand: Command;
        switch (command.commandKind) {
          case RushConstants.phasedCommandKind: {
            const commandPhases: Set<IPhase> = new Set();
            const watchPhases: Set<IPhase> = new Set();

            normalizedCommand = {
              ...command,
              isSynthetic: false,
              associatedParameters: new Set<IParameterJson>(),
              phases: commandPhases,
              watchPhases,
              alwaysWatch: false
            };

            for (const phaseName of command.phases) {
              const phase: IPhase | undefined = this.phases.get(phaseName);
              if (!phase) {
                throw new Error(
                  `In ${RushConstants.commandLineFilename}, in the "phases" property of the ` +
                    `"${normalizedCommand.name}" command, the phase "${phaseName}" does not exist.`
                );
              }

              commandPhases.add(phase);
            }

            // Apply implicit phase dependency expansion
            // The equivalent of the "--to" operator used for projects
            // Appending to the set while iterating it accomplishes a full breadth-first search
            for (const phase of commandPhases) {
              for (const dependency of phase.dependencies.self) {
                commandPhases.add(dependency);
              }

              for (const dependency of phase.dependencies.upstream) {
                commandPhases.add(dependency);
              }
            }

            const { watchOptions } = command;

            if (watchOptions) {
              normalizedCommand.alwaysWatch = watchOptions.alwaysWatch;

              // No implicit phase dependency expansion for watch mode.
              for (const phaseName of watchOptions.watchPhases) {
                const phase: IPhase | undefined = this.phases.get(phaseName);
                if (!phase) {
                  throw new Error(
                    `In ${RushConstants.commandLineFilename}, in the "watchPhases" property of the ` +
                      `"${normalizedCommand.name}" command, the phase "${phaseName}" does not exist.`
                  );
                }

                watchPhases.add(phase);
              }
            }

            break;
          }

          case RushConstants.globalCommandKind: {
            normalizedCommand = {
              ...command,
              associatedParameters: new Set<IParameterJson>()
            };
            break;
          }

          case RushConstants.bulkCommandKind: {
            // Translate the bulk command into a phased command
            normalizedCommand = this._translateBulkCommandToPhasedCommand(command);
            break;
          }
        }

        if (
          normalizedCommand.name === RushConstants.buildCommandName ||
          normalizedCommand.name === RushConstants.rebuildCommandName
        ) {
          if (normalizedCommand.commandKind === RushConstants.globalCommandKind) {
            throw new Error(
              `${RushConstants.commandLineFilename} defines a command "${normalizedCommand.name}" using ` +
                `the command kind "${RushConstants.globalCommandKind}". This command can only be designated as a command ` +
                `kind "${RushConstants.bulkCommandKind}" or "${RushConstants.phasedCommandKind}".`
            );
          } else if (command.safeForSimultaneousRushProcesses) {
            throw new Error(
              `${RushConstants.commandLineFilename} defines a command "${normalizedCommand.name}" using ` +
                `"safeForSimultaneousRushProcesses=true". This configuration is not supported for "${normalizedCommand.name}".`
            );
          } else if (normalizedCommand.name === RushConstants.buildCommandName) {
            // Record the build command phases in case we need to construct a synthetic "rebuild" command
            buildCommandPhases = normalizedCommand.phases;
          }
        }

        this.commands.set(normalizedCommand.name, normalizedCommand);
      }
    }

    if (!options.doNotIncludeDefaultBuildCommands) {
      let buildCommand: Command | undefined = this.commands.get(RushConstants.buildCommandName);
      if (!buildCommand) {
        // If the build command was not specified in the config file, add the default build command
        buildCommand = this._translateBulkCommandToPhasedCommand(DEFAULT_BUILD_COMMAND_JSON);
        buildCommand.disableBuildCache = DEFAULT_BUILD_COMMAND_JSON.disableBuildCache;
        buildCommandPhases = buildCommand.phases;
        this.commands.set(buildCommand.name, buildCommand);
      }

      if (!this.commands.has(RushConstants.rebuildCommandName)) {
        // If a rebuild command was not specified in the config file, add the default rebuild command
        if (!buildCommandPhases) {
          throw new Error(`Phases for the "${RushConstants.buildCommandName}" were not found.`);
        }

        const rebuildCommand: IPhasedCommandConfig = {
          ...DEFAULT_REBUILD_COMMAND_JSON,
          commandKind: RushConstants.phasedCommandKind,
          isSynthetic: true,
          phases: buildCommandPhases,
          disableBuildCache: DEFAULT_REBUILD_COMMAND_JSON.disableBuildCache,
          associatedParameters: buildCommand.associatedParameters, // rebuild should share build's parameters in this case,
          watchPhases: new Set(),
          alwaysWatch: false
        };
        this.commands.set(rebuildCommand.name, rebuildCommand);
      }
    }

    const parametersJson: ICommandLineJson['parameters'] = commandLineJson?.parameters;
    if (parametersJson) {
      for (const parameter of parametersJson) {
        const normalizedParameter: IParameterJson = {
          ...parameter,
          associatedPhases: parameter.associatedPhases ? [...parameter.associatedPhases] : [],
          associatedCommands: parameter.associatedCommands ? [...parameter.associatedCommands] : []
        };

        this.parameters.push(normalizedParameter);

        let parameterHasAssociatedPhases: boolean = false;

        // Do some basic validation
        switch (normalizedParameter.parameterKind) {
          case 'choice': {
            const alternativeNames: string[] = normalizedParameter.alternatives.map((x) => x.name);

            if (
              normalizedParameter.defaultValue &&
              alternativeNames.indexOf(normalizedParameter.defaultValue) < 0
            ) {
              throw new Error(
                `In ${RushConstants.commandLineFilename}, the parameter "${normalizedParameter.longName}",` +
                  ` specifies a default value "${normalizedParameter.defaultValue}"` +
                  ` which is not one of the defined alternatives: "${alternativeNames.toString()}"`
              );
            }

            break;
          }
        }

        let parameterHasAssociatedCommands: boolean = false;
        let parameterIsOnlyAssociatedWithPhasedCommands: boolean = true;
        if (normalizedParameter.associatedCommands) {
          for (const associatedCommandName of normalizedParameter.associatedCommands) {
            const syntheticPhase: IPhase | undefined =
              this._syntheticPhasesByTranslatedBulkCommandName.get(associatedCommandName);
            if (syntheticPhase) {
              // If this parameter was associated with a bulk command, include the association
              // with the synthetic phase
              normalizedParameter.associatedPhases!.push(syntheticPhase.name);
            }

            const associatedCommand: Command | undefined = this.commands.get(associatedCommandName);
            if (!associatedCommand) {
              throw new Error(
                `${RushConstants.commandLineFilename} defines a parameter "${normalizedParameter.longName}" ` +
                  `that is associated with a command "${associatedCommandName}" that does not exist or does ` +
                  'not support custom parameters.'
              );
            } else {
              associatedCommand.associatedParameters.add(normalizedParameter);
              parameterHasAssociatedCommands = true;

              if (associatedCommand.commandKind !== RushConstants.phasedCommandKind) {
                parameterIsOnlyAssociatedWithPhasedCommands = false;
              }
            }
          }
        }

        if (normalizedParameter.associatedPhases) {
          for (const associatedPhaseName of normalizedParameter.associatedPhases) {
            const associatedPhase: IPhase | undefined = this.phases.get(associatedPhaseName);
            if (!associatedPhase) {
              throw new Error(
                `${RushConstants.commandLineFilename} defines a parameter "${normalizedParameter.longName}" ` +
                  `that is associated with a phase "${associatedPhaseName}" that does not exist.`
              );
            } else {
              // Defer association to PhasedScriptAction so that it can map to the ts-command-line object
              parameterHasAssociatedPhases = true;
            }
          }
        }

        if (!parameterHasAssociatedCommands) {
          throw new Error(
            `${RushConstants.commandLineFilename} defines a parameter "${normalizedParameter.longName}"` +
              ` that lists no associated commands.`
          );
        }

        if (parameterIsOnlyAssociatedWithPhasedCommands && !parameterHasAssociatedPhases) {
          throw new Error(
            `${RushConstants.commandLineFilename} defines a parameter "${normalizedParameter.longName}" ` +
              `that is only associated with phased commands, but lists no associated phases.`
          );
        }
      }
    }
  }

  /**
   * Performs a depth-first search to detect cycles in the directed graph of phase "self" dependencies.
   *
   * @param phase The phase node currently being checked
   * @param phasesInPath The current path from the start node to `phase`
   * @param cycleFreePhases Phases that have already been fully walked and confirmed to not be in any cycles
   */
  private _checkForPhaseSelfCycles(
    phase: IPhase,
    phasesInPath: Set<IPhase>,
    cycleFreePhases: Set<IPhase>
  ): void {
    if (cycleFreePhases.has(phase)) {
      // phase is known to not be reachable from itself, i.e. not in a cycle. Skip.
      return;
    }

    for (const dependency of phase.dependencies.self) {
      if (phasesInPath.has(dependency)) {
        throw new Error(
          `In ${RushConstants.commandLineFilename}, there exists a cycle within the ` +
            `set of ${dependency.name} dependencies: ${Array.from(
              phasesInPath,
              (phase: IPhase) => phase.name
            ).join(', ')}`
        );
      } else {
        phasesInPath.add(dependency);
        this._checkForPhaseSelfCycles(dependency, phasesInPath, cycleFreePhases);
        phasesInPath.delete(dependency);
      }
    }

    // phase is not reachable from itself, mark for skipping
    cycleFreePhases.add(phase);
  }

  /**
   * Load the command-line.json configuration file from the specified path. Note that this
   * does not include the default build settings. This option is intended to be used to load
   * command-line.json files from plugins. To load a common/config/rush/command-line.json file,
   * use {@see loadFromFileOrDefault} instead.
   *
   * If the file does not exist, this function returns `undefined`
   */
  public static tryLoadFromFile(jsonFilePath: string): CommandLineConfiguration | undefined {
    let commandLineJson: ICommandLineJson | undefined;
    try {
      commandLineJson = JsonFile.loadAndValidate(jsonFilePath, CommandLineConfiguration._jsonSchema);
    } catch (e) {
      if (!FileSystem.isNotExistError(e as Error)) {
        throw e;
      }
    }

    if (commandLineJson) {
      return new CommandLineConfiguration(commandLineJson, { doNotIncludeDefaultBuildCommands: true });
    } else {
      return undefined;
    }
  }

  /**
   * Loads the configuration from the specified file and applies any omitted default build
   * settings.  If the file does not exist, then a default instance is returned.
   * If the file contains errors, then an exception is thrown.
   */
  public static loadFromFileOrDefault(jsonFilePath?: string): CommandLineConfiguration {
    let commandLineJson: ICommandLineJson | undefined = undefined;
    if (jsonFilePath) {
      try {
        commandLineJson = JsonFile.load(jsonFilePath);
      } catch (e) {
        if (!FileSystem.isNotExistError(e as Error)) {
          throw e;
        }
      }

      // merge commands specified in command-line.json and default (re)build settings
      // Ensure both build commands are included and preserve any other commands specified
      if (commandLineJson?.commands) {
        for (let i: number = 0; i < commandLineJson.commands.length; i++) {
          const command: CommandJson = commandLineJson.commands[i];

          // Determine if we have a set of default parameters
          let commandDefaultDefinition: CommandJson | {} = {};
          switch (command.commandKind) {
            case RushConstants.phasedCommandKind:
            case RushConstants.bulkCommandKind: {
              switch (command.name) {
                case RushConstants.buildCommandName: {
                  commandDefaultDefinition = DEFAULT_BUILD_COMMAND_JSON;
                  break;
                }

                case RushConstants.rebuildCommandName: {
                  commandDefaultDefinition = DEFAULT_REBUILD_COMMAND_JSON;
                  break;
                }
              }
              break;
            }
          }

          // Merge the default parameters into the repo-specified parameters
          commandLineJson.commands[i] = {
            ...commandDefaultDefinition,
            ...command
          };
        }

        CommandLineConfiguration._jsonSchema.validateObject(commandLineJson, jsonFilePath);
      }
    }

    return new CommandLineConfiguration(commandLineJson, { doNotIncludeDefaultBuildCommands: false });
  }

  public get additionalPathFolders(): Readonly<string[]> {
    return this._additionalPathFolders;
  }

  public prependAdditionalPathFolder(pathFolder: string): void {
    this._additionalPathFolders.unshift(pathFolder);
  }

  /**
   * This function replaces colons (":") with underscores ("_").
   *
   * ts-command-line restricts command names to lowercase letters, numbers, underscores, and colons.
   * Replacing colons with underscores produces a filesystem-safe name.
   */
  private _normalizeNameForLogFilenameIdentifiers(name: string): string {
    return name.replace(/:/g, '_'); // Replace colons with underscores to be filesystem-safe
  }

  private _translateBulkCommandToPhasedCommand(command: IBulkCommandJson): IPhasedCommandConfig {
    const phaseName: string = command.name;
    const phase: IPhase = {
      name: phaseName,
      isSynthetic: true,
      logFilenameIdentifier: this._normalizeNameForLogFilenameIdentifiers(command.name),
      associatedParameters: new Set(),
      dependencies: {
        self: new Set(),
        upstream: new Set()
      },
      ignoreMissingScript: !!command.ignoreMissingScript,
      allowWarningsOnSuccess: !!command.allowWarningsInSuccessfulBuild
    };

    if (!command.ignoreDependencyOrder) {
      phase.dependencies.upstream.add(phase);
    }

    this.phases.set(phaseName, phase);
    this._syntheticPhasesByTranslatedBulkCommandName.set(command.name, phase);

    const phases: Set<IPhase> = new Set([phase]);

    const translatedCommand: IPhasedCommandConfig = {
      ...command,
      commandKind: 'phased',
      isSynthetic: true,
      associatedParameters: new Set<IParameterJson>(),
      phases,
      // Bulk commands used the same phases for watch as for regular execution. Preserve behavior.
      watchPhases: command.watchForChanges ? phases : new Set(),
      alwaysWatch: !!command.watchForChanges
    };

    return translatedCommand;
  }
}
