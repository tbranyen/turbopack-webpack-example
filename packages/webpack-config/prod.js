const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');
const { merge } = require('webpack-merge');
const common = require('./common');

// When webpack is called as `webpack serve` this invokes the dev server. By
// searching the argv we can determine if serve was used.
const isWebpackDevServer = process.argv.includes('serve');

module.exports = (props) =>
    common(props).default.map((config) =>
        merge(config, {
            mode: 'production',
            // Do not generate source maps for production
            devtool: false,
            // When running a build with webpack-dev-server do not attempt to
            // hash the filename, otherwise we will not be able to load it
            // correctly. This helps allow testing production assets locally.
            output: {
                filename: isWebpackDevServer
                    ? config.output.filename
                    : '[name].[contenthash].js',
                publicPath: isWebpackDevServer
                    ? props.get('paths').publicPath
                    : '',
            },
            optimization: {
                ...config.optimization,
                minimizer: [
                    new TerserPlugin({
                        minify: TerserPlugin.swcMinify,
                    }),
                    new CssMinimizerPlugin(),
                ],
                minimize: true,
            },
        })
    );
