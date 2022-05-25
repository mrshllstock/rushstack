// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as nodePath from 'path';
import type {
  Compiler as WebpackCompiler,
  MultiCompiler as WebpackMultiCompiler,
  Stats as WebpackStats,
  MultiStats as WebpackMultiStats,
  StatsCompilation as WebpackStatsCompilation,
  StatsError as WebpackStatsError
} from 'webpack';
import type TWebpackDevServer from 'webpack-dev-server';
import { LegacyAdapters, Path, Import, IPackageJson, PackageJsonLookup } from '@rushstack/node-core-library';
import type {
  HeftConfiguration,
  HeftSession,
  IBuildStageContext,
  IBuildStageProperties,
  IBundleSubstage,
  IHeftPlugin,
  ScopedLogger
} from '@rushstack/heft';
import type {
  IWebpackConfiguration,
  IWebpackBundleSubstageProperties,
  IWebpackBuildStageProperties
} from './shared';
import { WebpackConfigurationLoader } from './WebpackConfigurationLoader';

const webpack: typeof import('webpack') = Import.lazy('webpack', require);

const PLUGIN_NAME: string = 'WebpackPlugin';
const WEBPACK_DEV_SERVER_PACKAGE_NAME: string = 'webpack-dev-server';
const WEBPACK_DEV_SERVER_ENV_VAR_NAME: string = 'WEBPACK_DEV_SERVER';

interface IWebpackVersions {
  webpackVersion: string;
  webpackDevServerVersion: string;
}

/**
 * @internal
 */
export class WebpackPlugin implements IHeftPlugin {
  public readonly pluginName: string = PLUGIN_NAME;

  private static _webpackVersions: IWebpackVersions | undefined;
  private static _getWebpackVersions(): IWebpackVersions {
    if (!WebpackPlugin._webpackVersions) {
      const webpackDevServerPackageJsonPath: string = Import.resolveModule({
        modulePath: 'webpack-dev-server/package.json',
        baseFolderPath: __dirname
      });
      const webpackDevServerPackageJson: IPackageJson = PackageJsonLookup.instance.loadPackageJson(
        webpackDevServerPackageJsonPath
      );
      WebpackPlugin._webpackVersions = {
        webpackVersion: webpack.version!,
        webpackDevServerVersion: webpackDevServerPackageJson.version
      };
    }

    return WebpackPlugin._webpackVersions;
  }

  public apply(heftSession: HeftSession, heftConfiguration: HeftConfiguration): void {
    heftSession.hooks.build.tap(PLUGIN_NAME, (build: IBuildStageContext) => {
      build.hooks.bundle.tap(PLUGIN_NAME, (bundle: IBundleSubstage) => {
        bundle.hooks.configureWebpack.tap(
          { name: PLUGIN_NAME, stage: Number.MIN_SAFE_INTEGER },
          (webpackConfiguration: unknown) => {
            const webpackVersions: IWebpackVersions = WebpackPlugin._getWebpackVersions();
            bundle.properties.webpackVersion = webpack.version;
            bundle.properties.webpackDevServerVersion = webpackVersions.webpackDevServerVersion;

            return webpackConfiguration;
          }
        );

        bundle.hooks.configureWebpack.tapPromise(PLUGIN_NAME, async (existingConfiguration: unknown) => {
          const logger: ScopedLogger = heftSession.requestScopedLogger('configure-webpack');
          if (existingConfiguration) {
            logger.terminal.writeVerboseLine(
              'Skipping loading webpack config file because the webpack config has already been set.'
            );
            return existingConfiguration;
          } else {
            return await WebpackConfigurationLoader.tryLoadWebpackConfigAsync(
              logger,
              heftConfiguration.buildFolder,
              build.properties
            );
          }
        });

        bundle.hooks.run.tapPromise(PLUGIN_NAME, async () => {
          await this._runWebpackAsync(
            heftSession,
            heftConfiguration,
            bundle.properties as IWebpackBundleSubstageProperties,
            build.properties,
            heftConfiguration.terminalProvider.supportsColor
          );
        });
      });
    });
  }

  private async _runWebpackAsync(
    heftSession: HeftSession,
    heftConfiguration: HeftConfiguration,
    bundleSubstageProperties: IWebpackBundleSubstageProperties,
    buildProperties: IBuildStageProperties,
    supportsColor: boolean
  ): Promise<void> {
    const webpackConfiguration: IWebpackConfiguration | undefined | null =
      bundleSubstageProperties.webpackConfiguration;
    if (!webpackConfiguration) {
      return;
    }

    const logger: ScopedLogger = heftSession.requestScopedLogger('webpack');
    const webpackVersions: IWebpackVersions = WebpackPlugin._getWebpackVersions();
    if (bundleSubstageProperties.webpackVersion !== webpackVersions.webpackVersion) {
      logger.emitError(
        new Error(
          `The Webpack plugin expected to be configured with Webpack version ${webpackVersions.webpackVersion}, ` +
            `but the configuration specifies version ${bundleSubstageProperties.webpackVersion}. ` +
            'Are multiple versions of the Webpack plugin present?'
        )
      );
    }

    if (bundleSubstageProperties.webpackDevServerVersion !== webpackVersions.webpackDevServerVersion) {
      logger.emitError(
        new Error(
          `The Webpack plugin expected to be configured with webpack-dev-server version ${webpackVersions.webpackDevServerVersion}, ` +
            `but the configuration specifies version ${bundleSubstageProperties.webpackDevServerVersion}. ` +
            'Are multiple versions of the Webpack plugin present?'
        )
      );
    }

    logger.terminal.writeLine(`Using Webpack version ${webpack.version}`);

    let compiler: WebpackCompiler | WebpackMultiCompiler;
    if (Array.isArray(webpackConfiguration)) {
      if (webpackConfiguration.length === 0) {
        logger.terminal.writeLine('The webpack configuration is an empty array - nothing to do.');
        return;
      } else {
        compiler = webpack(webpackConfiguration); /* (webpack.Compilation[]) => MultiCompiler */
      }
    } else {
      compiler = webpack(webpackConfiguration); /* (webpack.Compilation) => Compiler */
    }

    if (buildProperties.serveMode) {
      const defaultDevServerOptions: TWebpackDevServer.Configuration = {
        host: 'localhost',
        devMiddleware: {
          publicPath: '/',
          stats: {
            cached: false,
            cachedAssets: false,
            colors: supportsColor
          }
        },
        client: {
          logging: 'info'
        },
        port: 8080
      };

      let options: TWebpackDevServer.Configuration;
      if (Array.isArray(webpackConfiguration)) {
        const devServerOptions: TWebpackDevServer.Configuration[] = webpackConfiguration
          .map((configuration) => configuration.devServer)
          .filter((devServer): devServer is TWebpackDevServer.Configuration => !!devServer);
        if (devServerOptions.length > 1) {
          logger.emitWarning(
            new Error(`Detected multiple webpack devServer configurations, using the first one.`)
          );
        }

        if (devServerOptions.length > 0) {
          options = { ...defaultDevServerOptions, ...devServerOptions[0] };
        } else {
          options = defaultDevServerOptions;
        }
      } else {
        options = { ...defaultDevServerOptions, ...webpackConfiguration.devServer };
      }

      // Register a plugin to callback after webpack is done with the first compilation
      // so we can move on to post-build
      let firstCompilationDoneCallback: (() => void) | undefined;
      const originalBeforeCallback: typeof options.onBeforeSetupMiddleware | undefined =
        options.onBeforeSetupMiddleware;
      options.onBeforeSetupMiddleware = (devServer) => {
        compiler.hooks.done.tap('heft-webpack-plugin', () => {
          if (firstCompilationDoneCallback) {
            firstCompilationDoneCallback();
            firstCompilationDoneCallback = undefined;
          }
        });

        if (originalBeforeCallback) {
          return originalBeforeCallback(devServer);
        }
      };

      // The webpack-dev-server package has a design flaw, where merely loading its package will set the
      // WEBPACK_DEV_SERVER environment variable -- even if no APIs are accessed. This environment variable
      // causes incorrect behavior if Heft is not running in serve mode. Thus, we need to be careful to call require()
      // only if Heft is in serve mode.
      const WebpackDevServer: typeof TWebpackDevServer = require(WEBPACK_DEV_SERVER_PACKAGE_NAME);
      // TODO: the WebpackDevServer accepts a third parameter for a logger. We should make
      // use of that to make logging cleaner
      const webpackDevServer: TWebpackDevServer = new WebpackDevServer(options, compiler);

      await new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
        firstCompilationDoneCallback = resolve;

        // Wrap in promise.resolve due to small issue in the type declaration, return type should be
        // webpackDevServer.start(): Promise<void>;
        Promise.resolve(webpackDevServer.start()).catch(reject);
      });
    } else {
      if (process.env[WEBPACK_DEV_SERVER_ENV_VAR_NAME]) {
        logger.emitWarning(
          new Error(
            `The "${WEBPACK_DEV_SERVER_ENV_VAR_NAME}" environment variable is set, ` +
              'which will cause problems when webpack is not running in serve mode. ' +
              `(Did a dependency inadvertently load the "${WEBPACK_DEV_SERVER_PACKAGE_NAME}" package?)`
          )
        );
      }

      let stats: WebpackStats | WebpackMultiStats | undefined;
      if (buildProperties.watchMode) {
        try {
          stats = await LegacyAdapters.convertCallbackToPromise(
            (compiler as WebpackCompiler).watch.bind(compiler),
            {}
          );
        } catch (e) {
          logger.emitError(e as Error);
        }
      } else {
        try {
          stats = await LegacyAdapters.convertCallbackToPromise(
            (compiler as WebpackCompiler).run.bind(compiler)
          );
          await LegacyAdapters.convertCallbackToPromise(compiler.close.bind(compiler));
        } catch (e) {
          logger.emitError(e as Error);
        }
      }

      if (stats) {
        // eslint-disable-next-line require-atomic-updates
        (buildProperties as IWebpackBuildStageProperties).webpackStats = stats;

        this._emitErrors(logger, heftConfiguration.buildFolder, stats);
      }
    }
  }

  private _emitErrors(
    logger: ScopedLogger,
    buildFolder: string,
    stats: WebpackStats | WebpackMultiStats
  ): void {
    if (stats.hasErrors() || stats.hasWarnings()) {
      const serializedStats: WebpackStatsCompilation = stats.toJson('errors-warnings');

      if (serializedStats.warnings) {
        for (const warning of serializedStats.warnings) {
          logger.emitWarning(this._normalizeError(buildFolder, warning));
        }
      }

      if (serializedStats.errors) {
        for (const error of serializedStats.errors) {
          logger.emitError(this._normalizeError(buildFolder, error));
        }
      }
    }
  }

  private _normalizeError(buildFolder: string, error: WebpackStatsError): Error {
    if (error instanceof Error) {
      return error;
    } else {
      let moduleName: string | undefined = error.moduleName;
      if (!moduleName && error.moduleIdentifier) {
        moduleName = Path.convertToSlashes(nodePath.relative(buildFolder, error.moduleIdentifier));
      }

      let formattedError: string;
      if (error.loc && moduleName) {
        formattedError = `${moduleName}:${error.loc} - ${error.message}`;
      } else if (moduleName) {
        formattedError = `${moduleName} - ${error.message}`;
      } else {
        formattedError = error.message;
      }

      return new Error(formattedError);
    }
  }
}
