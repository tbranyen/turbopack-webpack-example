const path = require('path');
const { hostname } = require('os');
const { merge } = require('webpack-merge');
const ReactRefreshWebpackPlugin = require('@pmmmwh/react-refresh-webpack-plugin');
const { ProgressPlugin } = require('webpack');
const common = require('./common');

// When webpack is called as `webpack serve` this invokes the dev server. By
// searching the argv we can determine if serve was used.
const isWebpackDevServer = process.argv.includes('serve');

module.exports = (props) => {
    // Allow additional packages to be added easily via config.
    const enabledPackages = (props.get('webpack.enabled.packages') || []).map(
        (pkg) => {
            return require(`${path.join(
                process.cwd(),
                `/packages/${pkg}/package.json`
            )}`).name;
        }
    );

    return common(props).default.map((config) =>
        merge(config, {
            /* eslint-disable-next-line no-restricted-syntax */
            mode: 'development',
            devtool: false,

            // Disable filesystem caching if desired. On by default as it
            // greatly improves build speed over time.
            cache: props.get('webpack.cache.filesystem')
                ? {
                      type: 'filesystem',
                      cacheDirectory: path.join(process.cwd(), 'tmp'),
                      buildDependencies: {
                          defaultWebpack: ['webpack/lib/'],
                          config: [__filename],
                      },
                  }
                : undefined,

            output: {
                publicPath: props.get('paths').publicPath,
            },

            snapshot: {
                managedPaths: [
                    new RegExp(
                        `^(.+?[\\/]node_modules[\\/])(?!${enabledPackages.join(
                            '|'
                        )})`
                    ),
                ],
            },

            ...(isWebpackDevServer
                ? {
                      // note: eval-source-maps works in conjunction with the already generated
                      // sourcemaps produced by babel & loaded via the `source-map-loader` plugin
                      // below.
                      devtool:
                          props.get('webpack.devserver.source.maps') ||
                          'eval',

                      devServer: {
                          // Allows proxying from zuul-proxy
                          allowedHosts: 'all',
                          // Websocket support requires https and we cannot easily proxy these calls from nginx and zuul-proxy
                          webSocketServer: 'sockjs',
                          client: {
                              // Make wds sockets go through zuul-proxy
                              webSocketURL: {
                                  protocol: 'https',
                                  port: 443,
                                  pathname: '/ws',
                              },
                              // Show progress while compiling
                              progress: true,
                              overlay: false,
                          },
                          // Experimental hot reloading support, developers can
                          // opt-in with the property below.
                          hot: Boolean(props.get('webpack.fast.refresh')),
                          // Allow the livereload feature to be enabled/disabled.
                          liveReload: Boolean(
                              props.get('webpack.live.reload')
                          ),
                          watchFiles: [
                              props.get('paths').srcCss,
                          ].filter(Boolean),
                      },

                      plugins: [
                          props.get('webpack.fast.refresh') &&
                              new ReactRefreshWebpackPlugin(),
                          new ProgressPlugin(),
                      ].filter(Boolean),

                      stats: {
                          all: false,
                          entrypoints: true,
                      },

                      module: {
                          rules: [
                              // tell webpack to use pre-existing sourcemaps generated from babel.
                              {
                                  test: /\.js$/,
                                  enforce: 'pre',
                                  use: ['source-map-loader'],
                              },
                              props.get('webpack.fast.refresh') && {
                                  test: /\.[jt]sx?$/,
                                  exclude: new RegExp(
                                      `node_modules\/(?!(${enabledPackages.join(
                                          '|'
                                      )})\/).*/`
                                  ),
                                  use: [
                                      {
                                          loader: 'babel-loader',
                                          options: {
                                              babelrc: false,
                                              cacheDirectory: 'tmp',
                                              cacheCompression: false,
                                              plugins: [
                                                  require.resolve(
                                                      'react-refresh/babel'
                                                  ),
                                              ],
                                          },
                                      },
                                  ],
                              },
                          ].filter(Boolean),
                      },
                  }
                : {}),
        })
    );
};

// When in webpack-dev-server merge/reduce the entries to a single object.
if (isWebpackDevServer) {
    // Flatten the module exports via reduce. A single object means one port will
    // be consumed.
    const defaultExport = module.exports;
    module.exports = (props) =>
        // Wrap in an array to keep a consistent return value of config[].
        [
            defaultExport(props).reduce((memo, currentValue) => {
                const key = Object.keys(currentValue.entry)[0];

                return {
                    ...currentValue,
                    ...memo,
                    entry: {
                        ...(memo.entry || {}),
                        [key]: currentValue.entry[key],
                    },
                };
            }, {}),
        ];
}
