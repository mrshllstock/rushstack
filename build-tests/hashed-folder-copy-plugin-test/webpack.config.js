'use strict';

const path = require('path');
const webpack = require('webpack');

const { HashedFolderCopyPlugin } = require('@rushstack/hashed-folder-copy-plugin');
const { ModuleMinifierPlugin, LocalMinifier } = require('@rushstack/module-minifier-plugin');
const { SetPublicPathPlugin } = require('@rushstack/set-webpack-public-path-plugin');
const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer');
const HtmlWebpackPlugin = require('html-webpack-plugin');

function generateConfiguration(mode, outputFolderName) {
  return {
    mode: mode,
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          loader: require.resolve('ts-loader'),
          exclude: /(node_modules)/,
          options: {
            compiler: require.resolve('typescript'),
            logLevel: 'ERROR',
            configFile: path.resolve(__dirname, 'tsconfig.json')
          }
        }
      ]
    },
    resolve: {
      extensions: ['.js', '.jsx', '.json', '.ts', '.tsx']
    },
    entry: {
      test: path.join(__dirname, 'src', 'index.ts')
    },
    output: {
      path: path.join(__dirname, outputFolderName),
      filename: '[name]_[contenthash].js',
      chunkFilename: '[id].[name]_[contenthash].js'
    },
    optimization: {
      minimizer: [
        new ModuleMinifierPlugin({
          minifier: new LocalMinifier()
        })
      ]
    },
    plugins: [
      new webpack.optimize.ModuleConcatenationPlugin(),
      new HashedFolderCopyPlugin(),
      new BundleAnalyzerPlugin({
        openAnalyzer: false,
        analyzerMode: 'static',
        reportFilename: path.resolve(__dirname, 'temp', 'stats.html'),
        generateStatsFile: true,
        statsFilename: path.resolve(__dirname, 'temp', 'stats.json'),
        logLevel: 'error'
      }),
      new SetPublicPathPlugin({
        scriptName: {
          useAssetName: true
        }
      }),
      new HtmlWebpackPlugin()
    ]
  };
}

module.exports = [
  generateConfiguration('development', 'dist-dev'),
  generateConfiguration('production', 'dist-prod')
];
