// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import child_process from 'child_process';
import gitInfo = require('git-repo-info');
import * as os from 'os';
import * as path from 'path';
import * as url from 'url';
import colors from 'colors/safe';
import { trueCasePathSync } from 'true-case-path';
import { Executable, AlreadyReportedError, Path, ITerminal } from '@rushstack/node-core-library';
import { ensureGitMinimumVersion } from '@rushstack/package-deps-hash';

import { Utilities } from '../utilities/Utilities';
import { GitEmailPolicy } from './policy/GitEmailPolicy';
import { RushConfiguration } from '../api/RushConfiguration';
import { EnvironmentConfiguration } from '../api/EnvironmentConfiguration';

export const DEFAULT_GIT_TAG_SEPARATOR: string = '_';

export interface IGitStatusEntryBase {
  kind: 'untracked' | 'ignored' | 'changed' | 'unmerged' | 'renamed' | 'copied';
  path: string;
}

export interface IIgnoredGitStatusEntry extends IGitStatusEntryBase {
  kind: 'ignored';
}

export interface IUntrackedGitStatusEntry extends IGitStatusEntryBase {
  kind: 'untracked';
}

export type GitStatusChangeType = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'type-changed';

export interface IChangedGitStatusEntryFields {
  stagedChangeType: GitStatusChangeType | undefined;
  unstagedChangeType: GitStatusChangeType | undefined;
  isInSubmodule: boolean;
  headFileMode: string;
  indexFileMode: string;
  worktreeFileMode: string;
  headObjectName: string;
  indexObjectName: string;
}

export interface IChangedGitStatusEntry extends IGitStatusEntryBase, IChangedGitStatusEntryFields {
  kind: 'changed';
}

export interface IRenamedOrCopiedGitStatusEntry extends IGitStatusEntryBase, IChangedGitStatusEntryFields {
  kind: 'renamed' | 'copied';
  renameOrCopyScore: number;
  originalPath: string;
}

export interface IUnmergedGitStatusEntry extends IGitStatusEntryBase {
  kind: 'unmerged';
  stagedChangeType: GitStatusChangeType | undefined;
  unstagedChangeType: GitStatusChangeType | undefined;
  isInSubmodule: boolean;
  stage1FileMode: string;
  stage2FileMode: string;
  stage3FileMode: string;
  worktreeFileMode: string;
  stage1ObjectName: string;
  stage2ObjectName: string;
  stage3ObjectName: string;
}

export type IGitStatusEntry =
  | IUntrackedGitStatusEntry
  | IIgnoredGitStatusEntry
  | IChangedGitStatusEntry
  | IRenamedOrCopiedGitStatusEntry
  | IUnmergedGitStatusEntry;

interface IResultOrError<TResult> {
  error?: Error;
  result?: TResult;
}

export interface IGetBlobOptions {
  blobSpec: string;
  repositoryRoot: string;
}

export class Git {
  private readonly _rushConfiguration: RushConfiguration;
  private _checkedGitPath: boolean = false;
  private _gitPath: string | undefined;
  private _checkedGitInfo: boolean = false;
  private _gitInfo: gitInfo.GitRepoInfo | undefined;

  private _gitEmailResult: IResultOrError<string> | undefined = undefined;
  private _gitHooksPath: IResultOrError<string> | undefined = undefined;

  public constructor(rushConfiguration: RushConfiguration) {
    this._rushConfiguration = rushConfiguration;
  }

  /**
   * Returns the path to the Git binary if found. Otherwise, return undefined.
   */
  public get gitPath(): string | undefined {
    if (!this._checkedGitPath) {
      this._gitPath = EnvironmentConfiguration.gitBinaryPath || Executable.tryResolve('git');
      this._checkedGitPath = true;
    }

    return this._gitPath;
  }

  public getGitPathOrThrow(): string {
    const gitPath: string | undefined = this.gitPath;
    if (!gitPath) {
      throw new Error('Git is not present');
    } else {
      return gitPath;
    }
  }

  /**
   * Returns true if the Git binary can be found.
   */
  public isGitPresent(): boolean {
    return !!this.gitPath;
  }

  /**
   * Returns true if the Git binary was found and the current path is under a Git working tree.
   * @param repoInfo - If provided, do the check based on this Git repo info. If not provided,
   * the result of `this.getGitInfo()` is used.
   */
  public isPathUnderGitWorkingTree(repoInfo?: gitInfo.GitRepoInfo): boolean {
    if (this.isGitPresent()) {
      // Do we even have a Git binary?
      if (!repoInfo) {
        repoInfo = this.getGitInfo();
      }
      return !!(repoInfo && repoInfo.sha);
    } else {
      return false;
    }
  }

  /**
   * If a Git email address is configured and is nonempty, this returns it.
   * Otherwise, undefined is returned.
   */
  public tryGetGitEmail(): string | undefined {
    const emailResult: IResultOrError<string> = this._tryGetGitEmail();
    if (emailResult.result !== undefined && emailResult.result.length > 0) {
      return emailResult.result;
    }
    return undefined;
  }

  /**
   * If a Git email address is configured and is nonempty, this returns it.
   * Otherwise, configuration instructions are printed to the console,
   * and AlreadyReportedError is thrown.
   */
  public getGitEmail(): string {
    // Determine the user's account
    // Ex: "bob@example.com"
    const emailResult: IResultOrError<string> = this._tryGetGitEmail();
    if (emailResult.error) {
      console.log(
        [
          `Error: ${emailResult.error.message}`,
          'Unable to determine your Git configuration using this command:',
          '',
          '    git config user.email',
          ''
        ].join(os.EOL)
      );
      throw new AlreadyReportedError();
    }

    if (emailResult.result === undefined || emailResult.result.length === 0) {
      console.log(
        [
          'This operation requires that a Git email be specified.',
          '',
          `If you didn't configure your email yet, try something like this:`,
          '',
          ...GitEmailPolicy.getEmailExampleLines(this._rushConfiguration),
          ''
        ].join(os.EOL)
      );
      throw new AlreadyReportedError();
    }

    return emailResult.result;
  }

  /**
   * Get the folder where Git hooks should go for the current working tree.
   * Returns undefined if the current path is not under a Git working tree.
   */
  public getHooksFolder(): string | undefined {
    const repoInfo: gitInfo.GitRepoInfo | undefined = this.getGitInfo();
    if (repoInfo && repoInfo.worktreeGitDir) {
      return path.join(repoInfo.worktreeGitDir, 'hooks');
    }
    return undefined;
  }

  public isHooksPathDefault(): boolean {
    const repoInfo: gitInfo.GitRepoInfo | undefined = this.getGitInfo();
    if (!repoInfo?.commonGitDir) {
      // This should have never been called in a non-Git environment
      return true;
    }
    let commonGitDir: string = repoInfo.commonGitDir;
    try {
      commonGitDir = trueCasePathSync(commonGitDir);
    } catch (error) {
      /* ignore errors from true-case-path */
    }
    const defaultHooksPath: string = path.resolve(commonGitDir, 'hooks');
    const hooksResult: IResultOrError<string> = this._tryGetGitHooksPath();
    if (hooksResult.error) {
      console.log(
        [
          `Error: ${hooksResult.error.message}`,
          'Unable to determine your Git configuration using this command:',
          '',
          '    git rev-parse --git-path hooks',
          '',
          'Assuming hooks can still be installed in the default location'
        ].join(os.EOL)
      );
      return true;
    }

    if (hooksResult.result) {
      const absoluteHooksPath: string = path.resolve(
        this._rushConfiguration.rushJsonFolder,
        hooksResult.result
      );
      return absoluteHooksPath === defaultHooksPath;
    }

    // No error, but also empty result? Not sure it's possible.
    return true;
  }

  public getConfigHooksPath(): string {
    let configHooksPath: string = '';
    const gitPath: string = this.getGitPathOrThrow();
    try {
      configHooksPath = this._executeGitCommandAndCaptureOutput(gitPath, ['config', 'core.hooksPath']).trim();
    } catch (e) {
      // git config returns error code 1 if core.hooksPath is not set.
    }
    return configHooksPath;
  }

  /**
   * Get information about the current Git working tree.
   * Returns undefined if the current path is not under a Git working tree.
   */
  public getGitInfo(): Readonly<gitInfo.GitRepoInfo> | undefined {
    if (!this._checkedGitInfo) {
      let repoInfo: gitInfo.GitRepoInfo | undefined;
      try {
        // gitInfo() shouldn't usually throw, but wrapping in a try/catch just in case
        repoInfo = gitInfo();
      } catch (ex) {
        // if there's an error, assume we're not in a Git working tree
      }

      if (repoInfo && this.isPathUnderGitWorkingTree(repoInfo)) {
        this._gitInfo = repoInfo;
      }
      this._checkedGitInfo = true;
    }
    return this._gitInfo;
  }

  public getMergeBase(targetBranch: string, terminal: ITerminal, shouldFetch: boolean = false): string {
    if (shouldFetch) {
      this._fetchRemoteBranch(targetBranch, terminal);
    }

    const gitPath: string = this.getGitPathOrThrow();
    const output: string = this._executeGitCommandAndCaptureOutput(gitPath, [
      '--no-optional-locks',
      'merge-base',
      '--',
      'HEAD',
      targetBranch
    ]);
    const result: string = output.trim();

    return result;
  }

  public getBlobContent({ blobSpec, repositoryRoot }: IGetBlobOptions): string {
    const gitPath: string = this.getGitPathOrThrow();
    const output: string = this._executeGitCommandAndCaptureOutput(
      gitPath,
      ['cat-file', 'blob', blobSpec, '--'],
      repositoryRoot
    );

    return output;
  }

  /**
   * @param pathPrefix - An optional path prefix "git diff"s should be filtered by.
   * @returns
   * An array of paths of repo-root-relative paths of files that are different from
   * those in the provided {@param targetBranch}. If a {@param pathPrefix} is provided,
   * this function only returns results under the that path.
   */
  public getChangedFiles(
    targetBranch: string,
    terminal: ITerminal,
    skipFetch: boolean = false,
    pathPrefix?: string
  ): string[] {
    if (!skipFetch) {
      this._fetchRemoteBranch(targetBranch, terminal);
    }

    const gitPath: string = this.getGitPathOrThrow();
    const output: string = this._executeGitCommandAndCaptureOutput(gitPath, [
      'diff',
      `${targetBranch}...`,
      '--name-only',
      '--no-renames',
      '--diff-filter=A'
    ]);
    return output
      .split('\n')
      .map((line) => {
        if (line) {
          const trimmedLine: string = line.trim();
          if (!pathPrefix || Path.isUnderOrEqual(trimmedLine, pathPrefix)) {
            return trimmedLine;
          }
        } else {
          return undefined;
        }
      })
      .filter((line) => {
        return line && line.length > 0;
      }) as string[];
  }

  /**
   * Gets the remote default branch that maps to the provided repository url.
   * This method is used by 'Rush change' to find the default remote branch to compare against.
   * If repository url is not provided or if there is no match, returns the default remote's
   * default branch 'origin/main'.
   * If there are more than one matches, returns the first remote's default branch.
   *
   * @param rushConfiguration - rush configuration
   */
  public getRemoteDefaultBranch(): string {
    const repositoryUrls: string[] = this._rushConfiguration.repositoryUrls;
    if (repositoryUrls.length > 0) {
      const gitPath: string = this.getGitPathOrThrow();
      const output: string = this._executeGitCommandAndCaptureOutput(gitPath, ['remote']).trim();

      const normalizedRepositoryUrls: Set<string> = new Set<string>();
      for (const repositoryUrl of repositoryUrls) {
        // Apply toUpperCase() for a case-insensitive comparison
        normalizedRepositoryUrls.add(Git.normalizeGitUrlForComparison(repositoryUrl).toUpperCase());
      }

      const matchingRemotes: string[] = output.split('\n').filter((remoteName) => {
        if (remoteName) {
          const remoteUrl: string = this._executeGitCommandAndCaptureOutput(gitPath, [
            'remote',
            'get-url',
            '--',
            remoteName
          ]).trim();

          if (!remoteUrl) {
            return false;
          }

          // Also apply toUpperCase() for a case-insensitive comparison
          const normalizedRemoteUrl: string = Git.normalizeGitUrlForComparison(remoteUrl).toUpperCase();
          if (normalizedRepositoryUrls.has(normalizedRemoteUrl)) {
            return true;
          }
        }

        return false;
      });

      if (matchingRemotes.length > 0) {
        if (matchingRemotes.length > 1) {
          console.log(
            `More than one git remote matches the repository URL. Using the first remote (${matchingRemotes[0]}).`
          );
        }

        return `${matchingRemotes[0]}/${this._rushConfiguration.repositoryDefaultBranch}`;
      } else {
        const errorMessage: string =
          repositoryUrls.length > 1
            ? `Unable to find a git remote matching one of the repository URLs (${repositoryUrls.join(
                ', '
              )}). `
            : `Unable to find a git remote matching the repository URL (${repositoryUrls[0]}). `;
        console.log(colors.yellow(errorMessage + 'Detected changes are likely to be incorrect.'));

        return this._rushConfiguration.repositoryDefaultFullyQualifiedRemoteBranch;
      }
    } else {
      console.log(
        colors.yellow(
          'A git remote URL has not been specified in rush.json. Setting the baseline remote URL is recommended.'
        )
      );
      return this._rushConfiguration.repositoryDefaultFullyQualifiedRemoteBranch;
    }
  }

  public hasUncommittedChanges(): boolean {
    const gitStatusEntries: Iterable<IGitStatusEntry> = this.getGitStatus();
    for (const gitStatusEntry of gitStatusEntries) {
      if (gitStatusEntry.kind !== 'ignored') {
        return true;
      }
    }

    return false;
  }

  public hasUnstagedChanges(): boolean {
    const gitStatusEntries: Iterable<IGitStatusEntry> = this.getGitStatus();
    for (const gitStatusEntry of gitStatusEntries) {
      if (
        gitStatusEntry.kind === 'untracked' ||
        (gitStatusEntry as IChangedGitStatusEntry).unstagedChangeType !== undefined
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * The list of files changed but not committed
   */
  public getUncommittedChanges(): ReadonlyArray<string> {
    const result: string[] = [];
    const gitStatusEntries: Iterable<IGitStatusEntry> = this.getGitStatus();
    for (const gitStatusEntry of gitStatusEntries) {
      if (gitStatusEntry.kind !== 'ignored') {
        result.push(gitStatusEntry.path);
      }
    }

    return result;
  }

  public getTagSeparator(): string {
    return this._rushConfiguration.gitTagSeparator || DEFAULT_GIT_TAG_SEPARATOR;
  }

  public *getGitStatus(): Iterable<IGitStatusEntry> {
    const gitPath: string = this.getGitPathOrThrow();
    // See Git.test.ts for example output
    const output: string = this._executeGitCommandAndCaptureOutput(gitPath, [
      'status',
      '--porcelain=2',
      '--null'
    ]);

    // State machine for parsing a git status entry
    // See reference https://git-scm.com/docs/git-status?msclkid=1cff552bcdce11ecadf77a086eded66c#_porcelain_format_version_2

    const enum GitStatusEntryState {
      mode,
      changeType,
      headFileMode,
      indexFileMode,
      stage1FileMode,
      stage2FileMode,
      stage3FileMode,
      worktreeFileMode,
      headObjectName,
      indexObjectName,
      stage1ObjectName,
      stage2ObjectName,
      stage3ObjectName,
      submoduleState,
      renameOrCopyScore,
      path
    }

    let pos: number = 0;
    let state: GitStatusEntryState | undefined = GitStatusEntryState.mode;

    let isRenamedOrCopied: boolean = false;
    let isUnmerged: boolean = false;
    let currentObject: Partial<IGitStatusEntry> = {};

    function getFieldAndAdvancePos(delimiter: string): string {
      const newPos: number = output.indexOf(delimiter, pos);
      const field: string = output.substring(pos, newPos);
      pos = newPos + delimiter.length;
      return field;
    }

    while (state !== undefined) {
      switch (state) {
        case GitStatusEntryState.mode: {
          const modeField: string = getFieldAndAdvancePos(' ');
          switch (modeField) {
            case '?': {
              // Untracked
              currentObject.kind = 'untracked';
              state = GitStatusEntryState.path;
              break;
            }

            case '1': {
              // Simple change
              currentObject.kind = 'changed';
              state = GitStatusEntryState.changeType;
              break;
            }

            case '2': {
              // Renamed or copied
              isRenamedOrCopied = true;
              state = GitStatusEntryState.changeType;
              break;
            }

            case 'u': {
              // Unmerged
              currentObject.kind = 'unmerged';
              isUnmerged = false;
              state = GitStatusEntryState.changeType;
              break;
            }

            case '!': {
              // Ignored
              currentObject.kind = 'ignored';
              state = GitStatusEntryState.path;
              break;
            }

            default: {
              throw new Error(`Unexpected git status mode: ${modeField}`);
            }
          }

          break;
        }

        case GitStatusEntryState.changeType: {
          const typedCurrentObject: IChangedGitStatusEntry | IRenamedOrCopiedGitStatusEntry =
            currentObject as IChangedGitStatusEntry | IRenamedOrCopiedGitStatusEntry;

          const changeTypeField: string = getFieldAndAdvancePos(' ');
          const rawStagedChangeType: string = changeTypeField.charAt(0);
          typedCurrentObject.stagedChangeType = this._parseGitStatusChangeType(rawStagedChangeType);
          const rawUnstagedChangeType: string = changeTypeField.charAt(1);
          typedCurrentObject.unstagedChangeType = this._parseGitStatusChangeType(rawUnstagedChangeType);

          state = GitStatusEntryState.submoduleState;

          break;
        }

        case GitStatusEntryState.submoduleState: {
          const typedCurrentObject: IChangedGitStatusEntry | IRenamedOrCopiedGitStatusEntry =
            currentObject as IChangedGitStatusEntry | IRenamedOrCopiedGitStatusEntry;

          // This field is actually four characters long, but this parser only handles if the entry is in a
          // submodule or not. That is represented by a "N" or an "S" in the first character.
          const submoduleState: string = getFieldAndAdvancePos(' ');
          const submoduleMode: string = submoduleState.charAt(0);
          if (submoduleMode === 'N') {
            typedCurrentObject.isInSubmodule = false;
          } else if (submoduleMode === 'S') {
            typedCurrentObject.isInSubmodule = true;
          } else {
            throw new Error(`Unexpected submodule state: ${submoduleState}`);
          }

          if (isUnmerged) {
            state = GitStatusEntryState.stage1FileMode;
          } else {
            state = GitStatusEntryState.headFileMode;
          }

          break;
        }

        case GitStatusEntryState.headFileMode: {
          (currentObject as IChangedGitStatusEntry | IRenamedOrCopiedGitStatusEntry).headFileMode =
            getFieldAndAdvancePos(' ');
          state = GitStatusEntryState.indexFileMode;
          break;
        }

        case GitStatusEntryState.indexFileMode: {
          (currentObject as IChangedGitStatusEntry | IRenamedOrCopiedGitStatusEntry).indexFileMode =
            getFieldAndAdvancePos(' ');
          state = GitStatusEntryState.worktreeFileMode;
          break;
        }

        case GitStatusEntryState.stage1FileMode: {
          (currentObject as IUnmergedGitStatusEntry).stage1FileMode = getFieldAndAdvancePos(' ');
          state = GitStatusEntryState.stage2FileMode;
          break;
        }

        case GitStatusEntryState.stage2FileMode: {
          (currentObject as IUnmergedGitStatusEntry).stage2FileMode = getFieldAndAdvancePos(' ');
          state = GitStatusEntryState.stage3FileMode;
          break;
        }

        case GitStatusEntryState.stage3FileMode: {
          (currentObject as IUnmergedGitStatusEntry).stage3FileMode = getFieldAndAdvancePos(' ');
          state = GitStatusEntryState.worktreeFileMode;
          break;
        }

        case GitStatusEntryState.worktreeFileMode: {
          (currentObject as IChangedGitStatusEntry | IRenamedOrCopiedGitStatusEntry).worktreeFileMode =
            getFieldAndAdvancePos(' ');

          if (isUnmerged) {
            state = GitStatusEntryState.stage1ObjectName;
          } else {
            state = GitStatusEntryState.headObjectName;
          }

          break;
        }

        case GitStatusEntryState.headObjectName: {
          (currentObject as IChangedGitStatusEntry | IRenamedOrCopiedGitStatusEntry).headObjectName =
            getFieldAndAdvancePos(' ');
          state = GitStatusEntryState.indexObjectName;
          break;
        }

        case GitStatusEntryState.indexObjectName: {
          (currentObject as IChangedGitStatusEntry | IRenamedOrCopiedGitStatusEntry).indexObjectName =
            getFieldAndAdvancePos(' ');
          if (isRenamedOrCopied) {
            state = GitStatusEntryState.renameOrCopyScore;
          } else {
            state = GitStatusEntryState.path;
          }
          break;
        }

        case GitStatusEntryState.stage1ObjectName: {
          (currentObject as IUnmergedGitStatusEntry).stage1ObjectName = getFieldAndAdvancePos(' ');
          state = GitStatusEntryState.stage2ObjectName;
          break;
        }

        case GitStatusEntryState.stage2ObjectName: {
          (currentObject as IUnmergedGitStatusEntry).stage2ObjectName = getFieldAndAdvancePos(' ');
          state = GitStatusEntryState.stage3ObjectName;
          break;
        }

        case GitStatusEntryState.stage3ObjectName: {
          (currentObject as IUnmergedGitStatusEntry).stage3ObjectName = getFieldAndAdvancePos(' ');
          state = GitStatusEntryState.path;
          break;
        }

        case GitStatusEntryState.renameOrCopyScore: {
          const typedCurrentObject: IRenamedOrCopiedGitStatusEntry =
            currentObject as IRenamedOrCopiedGitStatusEntry;

          const renameOrCopyScoreField: string = getFieldAndAdvancePos(' ');
          const renameOrCopyMode: string = renameOrCopyScoreField.charAt(0);
          if (renameOrCopyMode === 'R') {
            typedCurrentObject.kind = 'renamed';
          } else if (renameOrCopyMode === 'C') {
            typedCurrentObject.kind = 'copied';
          } else {
            throw new Error(`Unexpected rename or copy mode: ${renameOrCopyMode}`);
          }

          const rawRenameOrCopyScore: string = renameOrCopyScoreField.substring(1);
          typedCurrentObject.renameOrCopyScore = parseInt(rawRenameOrCopyScore, 10);
          state = GitStatusEntryState.path;
          break;
        }

        case GitStatusEntryState.path: {
          currentObject.path = getFieldAndAdvancePos('\0');
          if (isRenamedOrCopied) {
            (currentObject as IRenamedOrCopiedGitStatusEntry).originalPath = getFieldAndAdvancePos('\0');
          }

          yield currentObject as IGitStatusEntry;
          isRenamedOrCopied = false;
          isUnmerged = false;
          currentObject = {};

          if (pos >= output.length) {
            state = undefined;
          } else {
            state = GitStatusEntryState.mode;
          }

          break;
        }
      }
    }
  }

  /**
   * Git remotes can use different URL syntaxes; this converts them all to a normalized HTTPS
   * representation for matching purposes.  IF THE INPUT IS NOT ALREADY HTTPS, THE OUTPUT IS
   * NOT NECESSARILY A VALID GIT URL.
   *
   * @example
   * `git@github.com:ExampleOrg/ExampleProject.git` --> `https://github.com/ExampleOrg/ExampleProject`
   */
  public static normalizeGitUrlForComparison(gitUrl: string): string {
    // Git URL formats are documented here: https://www.git-scm.com/docs/git-clone#_git_urls

    let result: string = gitUrl.trim();

    // [user@]host.xz:path/to/repo.git/
    // "This syntax is only recognized if there are no slashes before the first colon. This helps
    // differentiate a local path that contains a colon."
    //
    // Match patterns like this:
    //   user@host.ext:path/to/repo
    //   host.ext:path/to/repo
    //   localhost:/~user/path/to/repo
    //
    // But not:
    //   http://blah
    //   c:/windows/path.txt
    //
    const scpLikeSyntaxRegExp: RegExp = /^(?:[^@:\/]+\@)?([^:\/]{2,})\:((?!\/\/).+)$/;

    // Example: "user@host.ext:path/to/repo"
    const scpLikeSyntaxMatch: RegExpExecArray | null = scpLikeSyntaxRegExp.exec(gitUrl);
    if (scpLikeSyntaxMatch) {
      // Example: "host.ext"
      const host: string = scpLikeSyntaxMatch[1];
      // Example: "path/to/repo"
      const path: string = scpLikeSyntaxMatch[2];

      if (path.startsWith('/')) {
        result = `https://${host}${path}`;
      } else {
        result = `https://${host}/${path}`;
      }
    }

    const parsedUrl: url.UrlWithStringQuery = url.parse(result);

    // Only convert recognized schemes

    switch (parsedUrl.protocol) {
      case 'http:':
      case 'https:':
      case 'ssh:':
      case 'ftp:':
      case 'ftps:':
      case 'git:':
      case 'git+http:':
      case 'git+https:':
      case 'git+ssh:':
      case 'git+ftp:':
      case 'git+ftps:':
        // Assemble the parts we want:
        result = `https://${parsedUrl.host}${parsedUrl.pathname}`;
        break;
    }

    // Trim ".git" or ".git/" from the end
    result = result.replace(/.git\/?$/, '');
    return result;
  }

  private _tryGetGitEmail(): IResultOrError<string> {
    if (this._gitEmailResult === undefined) {
      const gitPath: string = this.getGitPathOrThrow();
      try {
        this._gitEmailResult = {
          result: this._executeGitCommandAndCaptureOutput(gitPath, ['config', 'user.email']).trim()
        };
      } catch (e) {
        this._gitEmailResult = {
          error: e as Error
        };
      }
    }

    return this._gitEmailResult;
  }

  private _tryGetGitHooksPath(): IResultOrError<string> {
    if (this._gitHooksPath === undefined) {
      const gitPath: string = this.getGitPathOrThrow();
      try {
        this._gitHooksPath = {
          result: this._executeGitCommandAndCaptureOutput(gitPath, [
            'rev-parse',
            '--git-path',
            'hooks'
          ]).trim()
        };
      } catch (e) {
        this._gitHooksPath = {
          error: e as Error
        };
      }
    }

    return this._gitHooksPath;
  }

  private _tryFetchRemoteBranch(remoteBranchName: string): boolean {
    const firstSlashIndex: number = remoteBranchName.indexOf('/');
    if (firstSlashIndex === -1) {
      throw new Error(
        `Unexpected git remote branch format: ${remoteBranchName}. ` +
          'Expected branch to be in the <remote>/<branch name> format.'
      );
    }

    const remoteName: string = remoteBranchName.substr(0, firstSlashIndex);
    const branchName: string = remoteBranchName.substr(firstSlashIndex + 1);
    const gitPath: string = this.getGitPathOrThrow();
    const spawnResult: child_process.SpawnSyncReturns<string> = Executable.spawnSync(
      gitPath,
      ['fetch', '--', remoteName, branchName],
      {
        stdio: 'ignore'
      }
    );
    return spawnResult.status === 0;
  }

  private _fetchRemoteBranch(remoteBranchName: string, terminal: ITerminal): void {
    console.log(`Checking for updates to ${remoteBranchName}...`);
    const fetchResult: boolean = this._tryFetchRemoteBranch(remoteBranchName);
    if (!fetchResult) {
      terminal.writeWarningLine(
        `Error fetching git remote branch ${remoteBranchName}. Detected changed files may be incorrect.`
      );
    }
  }

  private _parseGitStatusChangeType(str: string): GitStatusChangeType | undefined {
    switch (str) {
      case 'M': {
        return 'modified';
      }

      case 'T': {
        return 'type-changed';
      }

      case 'A': {
        return 'added';
      }

      case 'D': {
        return 'deleted';
      }

      case 'R': {
        return 'renamed';
      }

      case 'C': {
        return 'copied';
      }

      case '.': {
        return undefined;
      }

      default: {
        throw new Error(`Unexpected git status change type: ${str}`);
      }
    }
  }

  /**
   * @internal
   */
  public _executeGitCommandAndCaptureOutput(
    gitPath: string,
    args: string[],
    repositoryRoot: string = this._rushConfiguration.rushJsonFolder
  ): string {
    try {
      return Utilities.executeCommandAndCaptureOutput(gitPath, args, repositoryRoot);
    } catch (e) {
      ensureGitMinimumVersion(gitPath);
      throw e;
    }
  }
}
